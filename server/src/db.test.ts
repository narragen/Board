import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-db-test-"));
  dirs.push(dir);
  return dir;
}

describe("openDb", () => {
  test("creates the data dir and board.db when missing", () => {
    const dir = join(freshDir(), "nested", "data");
    openDb(dir);
    expect(existsSync(join(dir, "board.db"))).toBe(true);
  });

  test("enables WAL journal mode", () => {
    const db = openDb(freshDir());
    const row = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(row.journal_mode).toBe("wal");
    db.close();
  });

  test("enables foreign keys and busy timeout", () => {
    const db = openDb(freshDir());
    const fk = db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    const busy = db.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(fk.foreign_keys).toBe(1);
    expect(busy.timeout).toBe(5000);
    db.close();
  });

  test("creates all tables across migrations", () => {
    const db = openDb(freshDir());
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    for (const table of [
      "boards",
      "versions",
      "comments",
      "events",
      "subscribers",
      "tokens",
      "sessions",
      "schema_migrations",
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  test("reopening an existing data dir is idempotent", () => {
    const dir = freshDir();
    const first: Database = openDb(dir);
    first.close();
    const second = openDb(dir);
    const migrations = second
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(migrations.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    second.close();
  });

  // Migration 7 backfills versions.format from source_md: markdown always
  // keeps its source (even an empty one), html never does. Rows are written
  // against the pre-7 schema, then the reopen runs the migration for real.
  test("migration 7 backfills each version's format from source_md", () => {
    const dir = freshDir();
    const pre = openDb(dir);
    pre.exec("DROP TRIGGER versions_format_required;");
    pre.exec("ALTER TABLE versions DROP COLUMN format;");
    pre.exec("DELETE FROM schema_migrations WHERE version = 7;");
    pre
      .prepare(
        "INSERT INTO boards (id, title, format, created_by, created_at) VALUES ('b', 't', 'markdown', 'a', '2026-01-01T00:00:00Z')",
      )
      .run();
    const insert = pre.prepare(
      "INSERT INTO versions (board_id, n, content, source_md, created_by, created_at) VALUES ('b', ?, '<p>x</p>', ?, 'a', '2026-01-01T00:00:00Z')",
    );
    insert.run(1, "# md");
    insert.run(2, "");
    insert.run(3, null);
    pre.close();

    const db = openDb(dir);
    const rows = db
      .prepare("SELECT n, format FROM versions ORDER BY n")
      .all() as Array<{ n: number; format: string }>;
    expect(rows).toEqual([
      { n: 1, format: "markdown" },
      { n: 2, format: "markdown" },
      { n: 3, format: "html" },
    ]);
    db.close();
  });

  // The shape of a pre-D30 binary's insert (no format column named): it must
  // fail, not store a NULL format that the viewer would render as markdown.
  test("a version insert without a format is rejected", () => {
    const db = openDb(freshDir());
    db.prepare(
      "INSERT INTO boards (id, title, format, created_by, created_at) VALUES ('b', 't', 'markdown', 'a', '2026-01-01T00:00:00Z')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO versions (board_id, n, content, source_md, created_by, created_at) VALUES ('b', 1, '<p>x</p>', NULL, 'a', '2026-01-01T00:00:00Z')",
        )
        .run(),
    ).toThrow("versions.format is required");
    db.close();
  });

  test("rejects a second daemon-style writer cleanly via WAL (two open connections)", () => {
    const dir = freshDir();
    const a = openDb(dir);
    const b = openDb(dir);
    a.prepare(
      "INSERT INTO tokens (name, token_hash, created_at) VALUES ('a', 'h1', '2026-01-01T00:00:00Z')",
    ).run();
    const rows = b.prepare("SELECT name FROM tokens").all() as Array<{
      name: string;
    }>;
    expect(rows).toHaveLength(1);
    a.close();
    b.close();
  });
});
