import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../../server/src/config.ts";
import { openDb } from "../../../server/src/db.ts";
import { verifyToken } from "../../../server/src/tokens.ts";
import { type CommandIo, runTokenCommand } from "./token.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Tests never touch the real ~/.board — always a fresh temp data dir (AGENTS.md).
// The command opens its own db handle from the config (it may resolve an
// instance's db instead); the tests' `db` handle is for row assertions.
function freshDb(): { db: Database; config: Config } {
  const dir = mkdtempSync(join(tmpdir(), "board-cli-test-"));
  dirs.push(dir);
  return {
    db: openDb(dir),
    config: {
      dataDir: dir,
      host: "127.0.0.1",
      port: 7800,
      bind: ["127.0.0.1"],
    },
  };
}

interface Capture {
  out: string[];
  err: string[];
  io: CommandIo;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    },
  };
}

const TOKEN_LINE = /^[A-Za-z0-9_-]{43}$/;

function findToken(lines: string[]): string | undefined {
  return lines.find((line) => TOKEN_LINE.test(line));
}

describe("board token add", () => {
  test("exits 0, prints the token exactly once, and warns it is unrecoverable", () => {
    const { db, config } = freshDb();
    const { out, err, io } = capture();
    const code = runTokenCommand({ config, argv: ["add", "smoke-agent"], io });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("\n");
    const token = findToken(out);
    expect(token).toBeDefined();
    expect(text.split(token ?? "")).toHaveLength(2);
    expect(text).toContain("not recoverable");
    expect(verifyToken(db, token ?? "")?.name).toBe("smoke-agent");
    const row = db
      .prepare("SELECT token_hash FROM tokens WHERE name = ?")
      .get("smoke-agent") as { token_hash: string };
    expect(text).not.toContain(row.token_hash);
    db.close();
  });

  test("a duplicate name exits 1 on stderr without printing a token", () => {
    const { db, config } = freshDb();
    const first = capture();
    expect(
      runTokenCommand({ config, argv: ["add", "alice"], io: first.io }),
    ).toBe(0);
    const second = capture();
    const code = runTokenCommand({
      config,
      argv: ["add", "alice"],
      io: second.io,
    });
    expect(code).toBe(1);
    expect(second.err.join("\n")).toContain("alice");
    expect(second.err.join("\n")).toContain(
      "a taken name is permanent (D17); re-mint with --force or pick a new name",
    );
    expect(findToken(second.out)).toBeUndefined();
    db.close();
  });

  test("--force on a taken name revokes it and mints under a suffixed name", () => {
    const { db, config } = freshDb();
    const first = capture();
    expect(
      runTokenCommand({ config, argv: ["add", "cli"], io: first.io }),
    ).toBe(0);
    const oldToken = findToken(first.out) ?? "";
    const second = capture();
    const code = runTokenCommand({
      config,
      argv: ["add", "cli", "--force"],
      io: second.io,
    });
    expect(code).toBe(0);
    expect(second.err).toEqual([]);
    const text = second.out.join("\n");
    // both facts print: what was revoked, what was minted
    expect(text).toContain('revoked old token "cli"');
    expect(text).toContain('token for "cli-2"');
    expect(text).toContain("not recoverable");
    // the new plaintext is present exactly once; the old one verifies no more
    const newToken = findToken(second.out);
    expect(newToken).toBeDefined();
    expect(newToken).not.toBe(oldToken);
    expect(text.split(newToken ?? "")).toHaveLength(2);
    expect(verifyToken(db, oldToken)).toBeNull();
    expect(verifyToken(db, newToken ?? "")?.name).toBe("cli-2");
    // the audit trail keeps both rows (D17)
    const names = (
      db.prepare("SELECT name FROM tokens ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(names).toEqual(["cli", "cli-2"]);
    db.close();
  });

  test("--force on a free name mints under the exact name", () => {
    const { db, config } = freshDb();
    const cap = capture();
    const code = runTokenCommand({
      config,
      argv: ["add", "--force", "fresh"],
      io: cap.io,
    });
    expect(code).toBe(0);
    expect(cap.out.join("\n")).not.toContain("revoked");
    expect(cap.out.join("\n")).toContain('token for "fresh"');
    expect(verifyToken(db, findToken(cap.out) ?? "")?.name).toBe("fresh");
    db.close();
  });

  // The server's real mint rules (server/src/tokens.ts): the tokens.name
  // PRIMARY KEY — uniqueness via TokenNameTaken. There is no server-side
  // charset/length rule to satisfy (mint is CLI-local-db, docs/api.md), so
  // "satisfies the server's rules" here means: uniqueness holds across many
  // generated mints, and the mention-friendly shape ^[a-z]+-[a-z]+$ (the
  // generator's self-imposed, stricter rule) is what the handle looks like.
  test("a missing name mints a generated color-animal handle", () => {
    const { db, config } = freshDb();
    const { out, err, io } = capture();
    const code = runTokenCommand({ config, argv: ["add"], io });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const token = findToken(out);
    expect(token).toBeDefined();
    const name = /^token for "([^"]+)" /.exec(out.join("\n"))?.[1] ?? "";
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(verifyToken(db, token ?? "")?.name).toBe(name);
    db.close();
  });

  test("generated mints all succeed and differ (uniqueness = the real server rule)", () => {
    const { db, config } = freshDb();
    const names: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { out, err, io } = capture();
      const code = runTokenCommand({ config, argv: ["add"], io });
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const name = /^token for "([^"]+)" /.exec(out.join("\n"))?.[1] ?? "";
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      names.push(name);
    }
    expect(new Set(names).size).toBe(names.length);
    const rows = db
      .prepare("SELECT name FROM tokens ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(names.slice().sort());
    db.close();
  });

  test("an explicitly empty name still prints usage and exits 1", () => {
    const { db, config } = freshDb();
    const { out, err, io } = capture();
    const code = runTokenCommand({ config, argv: ["add", ""], io });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("usage");
    expect(out).toEqual([]);
    db.close();
  });

  test("--force without a name is refused with a remediation hint", () => {
    const { db, config } = freshDb();
    const { out, err, io } = capture();
    const code = runTokenCommand({ config, argv: ["add", "--force"], io });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--force re-mints an explicit name");
    expect(out).toEqual([]);
    db.close();
  });
});

describe("board token list", () => {
  test("renders an aligned table with names, timestamps, and revoked state", () => {
    const { db, config } = freshDb();
    const add = capture();
    runTokenCommand({ config, argv: ["add", "alpha"], io: add.io });
    runTokenCommand({ config, argv: ["add", "beta"], io: capture().io });
    verifyToken(db, findToken(add.out) ?? "");

    const { out, err, io } = capture();
    const code = runTokenCommand({ config, argv: ["list"], io });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const header = out[0] ?? "";
    expect(header).toContain("NAME");
    expect(header).toContain("CREATED");
    expect(header).toContain("LAST USED");
    expect(header).toContain("REVOKED");
    const alphaRow = out.find((line) => line.startsWith("alpha"));
    const betaRow = out.find((line) => line.startsWith("beta"));
    expect(alphaRow).toBeDefined();
    expect(betaRow).toBeDefined();
    expect(betaRow ?? "").toContain("never");
    expect(alphaRow ?? "").not.toContain("never");
    expect(alphaRow ?? "").toContain("no");
    expect((alphaRow ?? "").indexOf("20")).toBe(header.indexOf("CREATED"));
    expect((betaRow ?? "").indexOf("20")).toBe(header.indexOf("CREATED"));

    runTokenCommand({ config, argv: ["revoke", "beta"], io: capture().io });
    const afterRevoke = capture();
    runTokenCommand({ config, argv: ["list"], io: afterRevoke.io });
    const betaAfter = afterRevoke.out.find((line) => line.startsWith("beta"));
    expect(betaAfter ?? "").toContain("yes");

    const text = [...out, ...afterRevoke.out].join("\n");
    expect(text).not.toContain(
      (
        db
          .prepare("SELECT token_hash FROM tokens WHERE name = 'alpha'")
          .get() as { token_hash: string }
      ).token_hash,
    );
    expect(text).not.toContain(findToken(add.out) ?? "");
    db.close();
  });

  test("reports when there are no tokens yet", () => {
    const { db, config } = freshDb();
    const { out, io } = capture();
    expect(runTokenCommand({ config, argv: ["list"], io })).toBe(0);
    expect(out.join("\n")).toContain("no tokens");
    db.close();
  });
});

describe("board token revoke", () => {
  test("confirms revocation and the token stops verifying", () => {
    const { db, config } = freshDb();
    const add = capture();
    runTokenCommand({ config, argv: ["add", "gamma"], io: add.io });
    const token = findToken(add.out) ?? "";
    const { out, err, io } = capture();
    const code = runTokenCommand({ config, argv: ["revoke", "gamma"], io });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("gamma");
    expect(verifyToken(db, token)).toBeNull();
    db.close();
  });

  test("an unknown name exits 1 on stderr", () => {
    const { db, config } = freshDb();
    const { out, err, io } = capture();
    const code = runTokenCommand({ config, argv: ["revoke", "nobody"], io });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("nobody");
    expect(out).toEqual([]);
    db.close();
  });
});

describe("board token dispatch", () => {
  test("a missing or unknown subcommand prints usage and exits 1", () => {
    const { db, config } = freshDb();
    for (const argv of [[], ["frobnicate"]]) {
      const { err, io } = capture();
      expect(runTokenCommand({ config, argv, io })).toBe(1);
      expect(err.join("\n")).toContain("usage");
    }
    db.close();
  });
});
