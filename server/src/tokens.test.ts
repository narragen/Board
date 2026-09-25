import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import {
  createToken,
  listTokens,
  reMintToken,
  revokeToken,
  TokenError,
  TokenNameTaken,
  verifyToken,
} from "./tokens.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "board-tokens-test-"));
  dirs.push(dir);
  return openDb(dir);
}

function storedHash(db: Database, name: string): string {
  const row = db
    .prepare("SELECT token_hash FROM tokens WHERE name = ?")
    .get(name) as { token_hash: string };
  return row.token_hash;
}

describe("createToken", () => {
  test("returns name, token, scopes, created_at and round-trips via verifyToken", () => {
    const db = freshDb();
    const created = createToken(db, {
      name: "alice",
      scopes: ["boards:read", "boards:write"],
    });
    expect(created.name).toBe("alice");
    expect(created.scopes).toEqual(["boards:read", "boards:write"]);
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const info = verifyToken(db, created.token);
    expect(info?.name).toBe("alice");
    expect(info?.scopes).toEqual(["boards:read", "boards:write"]);
    expect(info?.created_at).toBe(created.created_at);
    expect(info?.revoked_at).toBeNull();
    expect(typeof info?.last_used_at).toBe("string");
    db.close();
  });

  test("defaults scopes to an empty list", () => {
    const db = freshDb();
    const created = createToken(db, { name: "alice" });
    expect(created.scopes).toEqual([]);
    expect(verifyToken(db, created.token)?.scopes).toEqual([]);
    db.close();
  });

  test("emits unpadded base64url encoding exactly 32 random bytes", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url").byteLength).toBe(32);
    db.close();
  });

  test("yields a distinct token and hash per call", () => {
    const db = freshDb();
    const a = createToken(db, { name: "alice" });
    const b = createToken(db, { name: "bob" });
    expect(b.token).not.toBe(a.token);
    expect(storedHash(db, "bob")).not.toBe(storedHash(db, "alice"));
    db.close();
  });

  test("stores sha256(token) hex, never the plaintext (invariant 7)", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    const hash = storedHash(db, "alice");
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const allRows = db
      .prepare("SELECT name, token_hash, scopes FROM tokens")
      .all() as Array<Record<string, string>>;
    expect(JSON.stringify(allRows)).not.toContain(token);
    db.close();
  });

  test("throws TokenNameTaken for a duplicate name", () => {
    const db = freshDb();
    createToken(db, { name: "alice" });
    let caught: unknown;
    try {
      createToken(db, { name: "alice" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TokenNameTaken);
    expect(caught).toBeInstanceOf(TokenError);
    expect((caught as Error).message).toContain("alice");
    expect(listTokens(db)).toHaveLength(1);
    db.close();
  });
});

describe("verifyToken", () => {
  test("returns null for a wrong or garbage token", () => {
    const db = freshDb();
    createToken(db, { name: "alice" });
    expect(verifyToken(db, "garbage")).toBeNull();
    expect(verifyToken(db, "")).toBeNull();
    expect(verifyToken(db, "A".repeat(43))).toBeNull();
    db.close();
  });

  test("returns null once revoked", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    expect(verifyToken(db, token)).not.toBeNull();
    revokeToken(db, "alice");
    expect(verifyToken(db, token)).toBeNull();
    db.close();
  });

  test("updates last_used_at on successful verify only", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    expect(listTokens(db)[0]?.last_used_at).toBeNull();
    verifyToken(db, token);
    expect(listTokens(db)[0]?.last_used_at).not.toBeNull();
    revokeToken(db, "alice");
    verifyToken(db, token);
    const rows = db
      .prepare(
        "SELECT last_used_at, revoked_at FROM tokens WHERE name = 'alice'",
      )
      .all() as Array<{ last_used_at: string; revoked_at: string }>;
    expect(rows[0]?.revoked_at).not.toBeNull();
    db.close();
  });
});

describe("revokeToken", () => {
  test("marks the token revoked and is idempotent on re-revoke", () => {
    const db = freshDb();
    createToken(db, { name: "alice" });
    const first = revokeToken(db, "alice");
    expect(first?.name).toBe("alice");
    expect(first?.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const again = revokeToken(db, "alice");
    expect(again?.revoked_at).toBe(first?.revoked_at);
    db.close();
  });

  test("returns null for an unknown name", () => {
    const db = freshDb();
    expect(revokeToken(db, "nobody")).toBeNull();
    db.close();
  });
});

describe("reMintToken (D17 --force re-mint)", () => {
  test("revokes the active row and mints fresh under the first free suffix", () => {
    const db = freshDb();
    const first = createToken(db, { name: "cli" });
    const { previous, created } = reMintToken(db, { name: "cli" });
    // both facts for the caller: what was revoked, what was minted
    expect(previous?.name).toBe("cli");
    expect(previous?.revoked_at).toBeNull();
    expect(created.name).toBe("cli-2");
    // the old credential dies immediately; the new one verifies
    expect(verifyToken(db, first.token)).toBeNull();
    expect(verifyToken(db, created.token)?.name).toBe("cli-2");
    // the audit trail keeps both rows — names are permanent (D17)
    const names = listTokens(db).map((info) => info.name);
    expect(names).toEqual(["cli", "cli-2"]);
    db.close();
  });

  test("a free name mints under the exact name with no revocation", () => {
    const db = freshDb();
    const { previous, created } = reMintToken(db, { name: "cli" });
    expect(previous).toBeNull();
    expect(created.name).toBe("cli");
    expect(verifyToken(db, created.token)?.name).toBe("cli");
    db.close();
  });

  test("an already-revoked row still re-mints suffixed (revoke is idempotent)", () => {
    const db = freshDb();
    const first = createToken(db, { name: "cli" });
    revokeToken(db, "cli");
    const { previous, created } = reMintToken(db, { name: "cli" });
    expect(previous?.name).toBe("cli");
    expect(previous?.revoked_at).not.toBeNull();
    expect(created.name).toBe("cli-2");
    expect(verifyToken(db, first.token)).toBeNull();
    expect(verifyToken(db, created.token)?.name).toBe("cli-2");
    db.close();
  });

  test("suffix walking skips taken names (cli, cli-2 → cli-3)", () => {
    const db = freshDb();
    createToken(db, { name: "cli" });
    createToken(db, { name: "cli-2" });
    const { created } = reMintToken(db, { name: "cli" });
    expect(created.name).toBe("cli-3");
    db.close();
  });
});

describe("listTokens", () => {
  test("returns info rows with no hash or plaintext material", () => {
    const db = freshDb();
    const a = createToken(db, { name: "alice" });
    const b = createToken(db, { name: "bob" });
    const list = listTokens(db);
    expect(list.map((info) => info.name)).toEqual(["alice", "bob"]);
    for (const info of list) {
      expect(Object.keys(info).sort()).toEqual([
        "created_at",
        "last_used_at",
        "name",
        "revoked_at",
        "scopes",
      ]);
    }
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(a.token);
    expect(serialized).not.toContain(b.token);
    expect(serialized).not.toContain(storedHash(db, "alice"));
    expect(serialized).not.toContain(storedHash(db, "bob"));
    db.close();
  });
});
