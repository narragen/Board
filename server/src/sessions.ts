import type { Database } from "bun:sqlite";
import type { SessionInfo } from "./domain.ts";
import { hashToken, newToken } from "./secrets.ts";

// docs/security.md "human browser session": `board open` mints a one-time
// exchange token for the URL; the SPA swaps it at /api/session/exchange for a
// long-lived bearer stored in localStorage. Both kinds are random ≥128-bit
// (we use 256-bit like agent tokens) and stored SHA-256 only — the plaintext
// exists solely in the minting call's return value (invariant 7). The minting
// and hashing themselves live in secrets.ts, shared with agent tokens.

export class InvalidExchangeToken extends Error {
  constructor() {
    // Deliberately generic: no token material and no reason code, so callers
    // can't distinguish "never issued" from "already spent" by the message.
    super("exchange token is invalid, expired, or already used");
    this.name = "InvalidExchangeToken";
  }
}

interface SessionRow {
  token_hash: string;
  kind: string;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  board_id: string | null;
}

const EXCHANGE_TTL_MS = 10 * 60 * 1000;
// Live sessions expire (M7 hardening): a bearer token in localStorage never
// ages on its own, so without a TTL a forgotten credential is valid until
// someone notices and revokes it. 30 days bounds the leak window; the UI's
// re-exchange flow / `board open` recovers. Enforced at auth time by
// verifySessionToken's expires_at check.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createExchangeToken(db: Database, boardId?: string): string {
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXCHANGE_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO sessions (token_hash, kind, created_at, expires_at, board_id) VALUES (?, 'exchange', ?, ?, ?)",
  ).run(hashToken(token), now.toISOString(), expiresAt, boardId ?? null);
  return token;
}

export function exchangeSession(db: Database, exchangeToken: string): string {
  const now = new Date();
  // One transaction so the used_at claim and the session insert commit together:
  // a crash in between can never leave a spent exchange without its session.
  const exchange = db.transaction((): string => {
    const row = db
      .prepare("SELECT * FROM sessions WHERE token_hash = ?")
      .get(hashToken(exchangeToken)) as SessionRow | null;
    if (
      row === null ||
      row.kind !== "exchange" ||
      row.used_at !== null ||
      (row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime())
    ) {
      throw new InvalidExchangeToken();
    }
    // Conditional update = atomic one-time claim, the real reuse guard.
    const claimed = db
      .prepare(
        "UPDATE sessions SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
      )
      .run(now.toISOString(), row.token_hash);
    if (claimed.changes !== 1) {
      throw new InvalidExchangeToken();
    }
    const sessionToken = newToken();
    db.prepare(
      "INSERT INTO sessions (token_hash, kind, created_at, expires_at, board_id) VALUES (?, 'session', ?, ?, ?)",
    ).run(
      hashToken(sessionToken),
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      row.board_id,
    );
    return sessionToken;
  });
  return exchange();
}

export function verifySessionToken(db: Database, token: string): boolean {
  const row = db
    .prepare("SELECT kind, expires_at FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as Pick<SessionRow, "kind" | "expires_at"> | null;
  if (row === null || row.kind !== "session") {
    return false;
  }
  // Enforced at auth time (M7 hardening): session rows carry a 30-day expiry
  // stamped at exchange; a null expires_at can only be a pre-TTL legacy row —
  // migration v6 backfilled those, so this guard is just honest if one exists.
  return row.expires_at === null || Date.parse(row.expires_at) > Date.now();
}

// The audit view's session inventory (M7): every row — spent exchange tokens
// included, because the dogfooded leak this surface remediates was exactly a
// pasted ?token= URL, and the operator needs to see (and kill) those too.
// `kind` tells the operator which credential class a row is.
export function listSessions(db: Database): SessionInfo[] {
  const rows = db
    .prepare(
      "SELECT token_hash, kind, created_at, expires_at, used_at FROM sessions ORDER BY created_at DESC, token_hash ASC",
    )
    .all() as SessionRow[];
  return rows.map((row) => ({
    id: row.token_hash,
    kind: row.kind as SessionInfo["kind"],
    created_at: row.created_at,
    used_at: row.used_at,
    expires_at: row.expires_at,
  }));
}

// Revoke = row delete. Sessions are state, not history — invariant 4 (events
// are append-only) covers the event log, which stays untouched here. This is the remediation for the
// dogfooded session-token leak: a live credential pasted into a comment had
// no kill switch (docs/security.md "Audit view"). Deleting the CURRENT
// session is allowed — the UI's re-exchange flow handles the dead credential.
export function revokeSession(db: Database, id: string): boolean {
  const res = db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(id);
  return res.changes > 0;
}
