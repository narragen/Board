import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import {
  createExchangeToken,
  exchangeSession,
  InvalidExchangeToken,
  verifySessionToken,
} from "./sessions.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Tests never touch the real ~/.board — always a fresh temp data dir (AGENTS.md).
function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "board-sessions-test-"));
  dirs.push(dir);
  return openDb(dir);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface SessionRow {
  token_hash: string;
  kind: string;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  board_id: string | null;
}

function rowFor(db: Database, token: string): SessionRow | undefined {
  return db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .get(sha256(token)) as SessionRow | undefined;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const EXCHANGE_TTL_MS = 10 * 60 * 1000;

describe("createExchangeToken", () => {
  test("stores a hashed, unused, unexpired exchange row and returns the plaintext once", () => {
    const db = freshDb();
    const token = createExchangeToken(db);
    expect(token).toMatch(TOKEN_RE);
    const row = rowFor(db, token);
    expect(row).toBeDefined();
    expect(row?.kind).toBe("exchange");
    expect(row?.used_at).toBeNull();
    expect(row?.board_id).toBeNull();
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(row?.expires_at ?? "")).toBeGreaterThan(Date.now());
    expect(
      (Date.parse(row?.expires_at ?? "") ?? 0) -
        (Date.parse(row?.created_at ?? "") ?? 0),
    ).toBe(EXCHANGE_TTL_MS);
    db.close();
  });

  test("hashes at rest: the row holds sha256(token), never the plaintext (invariant 7)", () => {
    const db = freshDb();
    const token = createExchangeToken(db);
    const row = rowFor(db, token);
    expect(row?.token_hash).toBe(sha256(token));
    expect(row?.token_hash).not.toBe(token);
    const allRows = db
      .prepare("SELECT token_hash FROM sessions")
      .all() as Array<{ token_hash: string }>;
    expect(allRows.map((r) => r.token_hash)).not.toContain(token);
    db.close();
  });

  test("records an optional board_id for board open deep links", () => {
    const db = freshDb();
    const token = createExchangeToken(db, "ab12cd34ef");
    expect(rowFor(db, token)?.board_id).toBe("ab12cd34ef");
    db.close();
  });
});

describe("exchangeSession", () => {
  test("happy path: one-time exchange mints a session row with the 30-day TTL and returns its plaintext", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db);
    const session = exchangeSession(db, exchange);
    expect(session).toMatch(TOKEN_RE);
    expect(session).not.toBe(exchange);

    const sessionRow = rowFor(db, session);
    expect(sessionRow?.kind).toBe("session");
    // D19 hardening: the live session expires 30 days after exchange.
    // SESSION_TTL_MS isn't exported from sessions.ts, so the span is computed
    // inline; 60s tolerance — stamped at exchange, so a tick inside the test
    // window is fine (mirrors server/test/hardening.test.ts).
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const createdMs = Date.parse(sessionRow?.created_at ?? "");
    const expiresMs = Date.parse(sessionRow?.expires_at ?? "");
    expect(sessionRow?.expires_at).not.toBeNull();
    expect(expiresMs - createdMs).toBeGreaterThanOrEqual(thirtyDays - 60_000);
    expect(expiresMs - createdMs).toBeLessThanOrEqual(thirtyDays);
    expect(sessionRow?.used_at).toBeNull();
    expect(sessionRow?.board_id).toBeNull();

    expect(rowFor(db, exchange)?.used_at).not.toBeNull();
    expect(verifySessionToken(db, session)).toBe(true);
    db.close();
  });

  test("reuse of an exchange token is rejected and mints nothing", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db);
    expect(exchangeSession(db, exchange)).toMatch(TOKEN_RE);
    expect(() => exchangeSession(db, exchange)).toThrow(InvalidExchangeToken);
    const rows = db.prepare("SELECT kind FROM sessions").all() as Array<{
      kind: string;
    }>;
    expect(rows.filter((row) => row.kind === "session")).toHaveLength(1);
    db.close();
  });

  test("an expired exchange token is rejected", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db);
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
      "2000-01-01T00:00:00.000Z",
      sha256(exchange),
    );
    expect(() => exchangeSession(db, exchange)).toThrow(InvalidExchangeToken);
    expect(rowFor(db, exchange)?.used_at).toBeNull();
    db.close();
  });

  test("a session token presented for exchange is rejected (wrong kind)", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db);
    const session = exchangeSession(db, exchange);
    expect(() => exchangeSession(db, session)).toThrow(InvalidExchangeToken);
    db.close();
  });

  test("an unknown or malformed token is rejected", () => {
    const db = freshDb();
    for (const bogus of ["", "garbage", "AAAA"]) {
      expect(() => exchangeSession(db, bogus)).toThrow(InvalidExchangeToken);
    }
    db.close();
  });

  test("board_id round-trips onto the session row", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db, "board12345");
    const session = exchangeSession(db, exchange);
    expect(rowFor(db, session)?.board_id).toBe("board12345");
    db.close();
  });
});

describe("verifySessionToken", () => {
  test("only valid session tokens verify; exchange tokens never do", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db);
    const session = exchangeSession(db, exchange);
    expect(verifySessionToken(db, session)).toBe(true);
    expect(verifySessionToken(db, exchange)).toBe(false);
    db.close();
  });

  test("garbage and empty tokens do not verify", () => {
    const db = freshDb();
    expect(verifySessionToken(db, "not-a-token")).toBe(false);
    expect(verifySessionToken(db, "")).toBe(false);
    db.close();
  });
});
