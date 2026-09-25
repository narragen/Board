import type { Database } from "bun:sqlite";
import type { TokenInfo } from "./domain.ts";
import { errText } from "./err-text.ts";
import { hashToken, newToken } from "./secrets.ts";

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export class TokenNameTaken extends TokenError {
  constructor(message: string) {
    super(message);
    this.name = "TokenNameTaken";
  }
}

export interface CreatedToken {
  name: string;
  token: string;
  scopes: string[];
  created_at: string;
}

interface TokenRow {
  name: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function parseScopes(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function toInfo(row: TokenRow): TokenInfo {
  return {
    name: row.name,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

export function createToken(
  db: Database,
  opts: { name: string; scopes?: string[] },
): CreatedToken {
  const scopes = opts.scopes ?? [];
  const token = newToken();
  const createdAt = new Date().toISOString();
  try {
    db.prepare(
      "INSERT INTO tokens (name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?)",
    ).run(opts.name, hashToken(token), JSON.stringify(scopes), createdAt);
  } catch (err) {
    const message = errText(err);
    if (
      message.includes("UNIQUE constraint failed") &&
      message.includes("tokens.name")
    ) {
      throw new TokenNameTaken(`a token named "${opts.name}" already exists`);
    }
    throw err;
  }
  return { name: opts.name, token, scopes, created_at: createdAt };
}

export function verifyToken(db: Database, token: string): TokenInfo | null {
  const row = db
    .prepare("SELECT * FROM tokens WHERE token_hash = ?")
    .get(hashToken(token)) as TokenRow | null;
  if (row === null || row.revoked_at !== null) {
    return null;
  }
  const lastUsedAt = new Date().toISOString();
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE name = ?").run(
    lastUsedAt,
    row.name,
  );
  return { ...toInfo(row), last_used_at: lastUsedAt };
}

export function revokeToken(db: Database, name: string): TokenInfo | null {
  const row = db
    .prepare("SELECT * FROM tokens WHERE name = ?")
    .get(name) as TokenRow | null;
  if (row === null) {
    return null;
  }
  if (row.revoked_at !== null) {
    return toInfo(row);
  }
  const revokedAt = new Date().toISOString();
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ?").run(
    revokedAt,
    name,
  );
  return { ...toInfo(row), revoked_at: revokedAt };
}

export interface ReMintResult {
  // the row that held the name before the re-mint, in its pre-call state
  // (null when the name was free — the caller decides what that's worth)
  previous: TokenInfo | null;
  created: CreatedToken;
}

// tokens.name is the PRIMARY KEY and a revoked row keeps its name forever
// (D17) — a --force re-mint revokes whatever row holds the requested name
// (whatever state: an already-revoked row revokes idempotently) and mints a
// fresh token under the first free suffix (`name`, `name-2`, …), keeping the
// row's audit trail. The old plaintext is unrecoverable — invariant 7 (tokens
// stored hashed) — and that is WHY re-minting, not re-showing, is the only
// option.
export function reMintToken(
  db: Database,
  opts: { name: string; scopes?: string[] },
): ReMintResult {
  const row = db
    .prepare("SELECT * FROM tokens WHERE name = ?")
    .get(opts.name) as TokenRow | null;
  const previous = row === null ? null : toInfo(row);
  if (previous !== null) {
    revokeToken(db, opts.name);
  }
  return { previous, created: firstFreeCreate(db, opts.name, opts.scopes) };
}

// D17's install precedent: the exact name first, then suffixes 2–99 — the
// suffix is the visible trace of the re-mint in `token list`.
function firstFreeCreate(
  db: Database,
  name: string,
  scopes?: string[],
): CreatedToken {
  try {
    return createToken(db, { name, scopes });
  } catch (err) {
    if (!(err instanceof TokenNameTaken)) {
      throw err;
    }
  }
  for (let n = 2; n < 100; n++) {
    try {
      return createToken(db, { name: `${name}-${n}`, scopes });
    } catch (err) {
      if (!(err instanceof TokenNameTaken)) {
        throw err;
      }
    }
  }
  throw new Error(`no free token name under "${name}" (suffixes 2–99 taken)`);
}

export function listTokens(db: Database): TokenInfo[] {
  const rows = db
    .prepare("SELECT * FROM tokens ORDER BY name")
    .all() as TokenRow[];
  return rows.map(toInfo);
}
