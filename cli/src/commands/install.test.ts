import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { openDb } from "../../../server/src/db.ts";
import {
  INSTALL_USAGE,
  MCP_CONNECTOR_COMMAND,
  MCP_CONNECTOR_PATH,
  mergeOpencodeConfig,
  OpencodeConfigError,
  runInstallCommand,
} from "./install.ts";
import type { CommandIo } from "./token.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Tests never touch the real ~/.board — always a fresh temp data dir (AGENTS.md).
function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "board-install-test-"));
  dirs.push(dir);
  return openDb(dir);
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

function tokenLines(lines: string[]): string[] {
  return lines.filter((line) => TOKEN_LINE.test(line));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) {
    return out;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

// Redirect HOME + XDG_CONFIG_HOME at temp dirs for the duration of fn; the
// command reads them per-call via homedir()/configHome().
function withIsolatedEnv(
  fn: (env: { home: string; xdg: string }) => void,
): void {
  const home = mkdtempSync(join(tmpdir(), "board-install-home-"));
  const xdg = mkdtempSync(join(tmpdir(), "board-install-xdg-"));
  dirs.push(home, xdg);
  const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    fn({ home, xdg });
  } finally {
    if (saved.home === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = saved.home;
    }
    if (saved.xdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = saved.xdg;
    }
  }
}

const HEALTHY = () => true;
const NO_CLAUDE = () => false;

describe("board install opencode config merge", () => {
  test("merges into an existing jsonc preserving comments and unrelated keys", () => {
    withIsolatedEnv(({ xdg }) => {
      const dir = join(xdg, "opencode");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "opencode.jsonc"),
        `{
  // model picked by the human — keep
  "model": "anthropic/claude-opus-4",
  "plugin": {
    // gh-pr keeps review state
    "gh-pr": true
  }
}
`,
      );
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "opencode"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(0);
      expect(err).toEqual([]);

      const raw = readFileSync(join(dir, "opencode.jsonc"), "utf8");
      // comments and unrelated config survive verbatim
      expect(raw).toContain("// model picked by the human — keep");
      expect(raw).toContain("// gh-pr keeps review state");
      const errors: ParseError[] = [];
      const config = parse(raw, errors) as {
        model: string;
        plugin: { "gh-pr": boolean };
        mcp: {
          board: {
            type: string;
            command: string[];
            enabled: boolean;
            timeout: number;
            environment: { BOARD_MCP_TOKEN: string };
          };
        };
      };
      expect(errors).toEqual([]);
      expect(config.model).toBe("anthropic/claude-opus-4");
      expect(config.plugin["gh-pr"]).toBe(true);
      const board = config.mcp.board;
      expect(board.type).toBe("local");
      expect(board.command).toEqual([
        MCP_CONNECTOR_COMMAND,
        MCP_CONNECTOR_PATH,
      ]);
      expect(board.enabled).toBe(true);
      expect(board.timeout).toBe(60000);
      const token = tokenLines(out)[0];
      expect(token).toBeDefined();
      expect(board.environment.BOARD_MCP_TOKEN).toBe(token);
      db.close();
    });
  });

  test("creates the config from scratch when the file does not exist", () => {
    withIsolatedEnv(({ xdg }) => {
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "opencode"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const raw = readFileSync(join(xdg, "opencode", "opencode.jsonc"), "utf8");
      const errors: ParseError[] = [];
      const config = parse(raw, errors) as {
        mcp: {
          board: {
            type: string;
            command: string[];
            enabled: boolean;
            timeout: number;
            environment: { BOARD_MCP_TOKEN: string };
          };
        };
      };
      expect(errors).toEqual([]);
      expect(config.mcp.board.type).toBe("local");
      expect(config.mcp.board.command).toEqual([
        MCP_CONNECTOR_COMMAND,
        MCP_CONNECTOR_PATH,
      ]);
      expect(config.mcp.board.enabled).toBe(true);
      expect(config.mcp.board.timeout).toBe(60000);
      expect(config.mcp.board.environment.BOARD_MCP_TOKEN).toBe(
        tokenLines(out)[0],
      );
      db.close();
    });
  });

  test("replaces an old remote (pre-D22) entry, still preserving comments", () => {
    withIsolatedEnv(({ xdg }) => {
      const dir = join(xdg, "opencode");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "opencode.jsonc"),
        `{
  // a human comment that must survive the upgrade
  "model": "anthropic/claude-opus-4",
  "mcp": {
    "board": {
      // the pre-D22 remote wiring — replaced wholesale
      "type": "remote",
      "url": "http://127.0.0.1:7800/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer stale" }
    }
  }
}
`,
      );
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "opencode"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const raw = readFileSync(join(dir, "opencode.jsonc"), "utf8");
      expect(raw).toContain("// a human comment that must survive the upgrade");
      const errors: ParseError[] = [];
      const config = parse(raw, errors) as {
        mcp: {
          board: {
            type: string;
            url?: string;
            headers?: unknown;
            command: string[];
            timeout: number;
            environment: { BOARD_MCP_TOKEN: string };
          };
        };
      };
      expect(errors).toEqual([]);
      const board = config.mcp.board;
      expect(board.type).toBe("local");
      expect(board.command).toEqual([
        MCP_CONNECTOR_COMMAND,
        MCP_CONNECTOR_PATH,
      ]);
      expect(board.url).toBeUndefined();
      expect(board.headers).toBeUndefined();
      expect(board.timeout).toBe(60000);
      expect(board.environment.BOARD_MCP_TOKEN).toBe(tokenLines(out)[0]);
      db.close();
    });
  });

  test("repo root derives from the module location, not the cwd", () => {
    // Absolute, pointing at the real connector file next to this repo —
    // derived independently of process.cwd() (bun test runs at the repo root,
    // so the path is recomputed here from the test's own module location).
    expect(MCP_CONNECTOR_PATH.startsWith("/")).toBe(true);
    expect(MCP_CONNECTOR_PATH).toBe(
      join(import.meta.dir, "..", "mcp-connector.ts"),
    );
    expect(existsSync(MCP_CONNECTOR_PATH)).toBe(true);
  });

  test("mergeOpencodeConfig accepts trailing commas, as opencode does", () => {
    const merged = mergeOpencodeConfig(
      '{\n  // local models\n  "provider": { "ollama": {}, },\n}\n',
      {
        type: "local",
        command: [MCP_CONNECTOR_COMMAND, MCP_CONNECTOR_PATH],
        enabled: true,
        timeout: 60000,
        environment: { BOARD_MCP_TOKEN: "x" },
      },
    );
    expect(merged).toContain("// local models");
    const errors: ParseError[] = [];
    const parsed = parse(merged, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect(parsed.mcp.board.environment.BOARD_MCP_TOKEN).toBe("x");
    expect(parsed.provider).toEqual({ ollama: {} });
  });

  test("mergeOpencodeConfig rejects invalid JSONC with a parse-error message", () => {
    try {
      mergeOpencodeConfig('{ "mcp": }', {
        type: "local",
        command: [MCP_CONNECTOR_COMMAND, MCP_CONNECTOR_PATH],
        enabled: true,
        timeout: 60000,
        environment: { BOARD_MCP_TOKEN: "x" },
      });
      throw new Error("expected OpencodeConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(OpencodeConfigError);
      expect((err as Error).message).toContain("not valid JSONC");
    }
  });
});

describe("board install tokens", () => {
  test("mints once per agent; a second run skips; --force revokes and re-mints", () => {
    withIsolatedEnv(() => {
      const db = freshDb();
      const first = capture();
      expect(
        runInstallCommand({
          db,
          argv: ["--agents", "opencode"],
          io: first.io,
          checkHealth: HEALTHY,
          claudeOnPath: NO_CLAUDE,
        }),
      ).toBe(0);
      let rows = db
        .prepare("SELECT * FROM tokens WHERE name = ?")
        .all("board-opencode");
      expect(rows).toHaveLength(1);
      expect((rows[0] as { revoked_at: string | null }).revoked_at).toBeNull();

      const second = capture();
      expect(
        runInstallCommand({
          db,
          argv: ["--agents", "opencode"],
          io: second.io,
          checkHealth: HEALTHY,
          claudeOnPath: NO_CLAUDE,
        }),
      ).toBe(0);
      expect(second.out.join("\n")).toContain(
        "already installed for opencode — re-mint with: make install FLAGS=--force (or: bun run cli/src/main.ts install --force)",
      );
      expect(tokenLines(second.out)).toEqual([]);
      rows = db
        .prepare("SELECT * FROM tokens WHERE name = ?")
        .all("board-opencode");
      expect(rows).toHaveLength(1);

      const third = capture();
      expect(
        runInstallCommand({
          db,
          argv: ["--agents", "opencode", "--force"],
          io: third.io,
          checkHealth: HEALTHY,
          claudeOnPath: NO_CLAUDE,
        }),
      ).toBe(0);
      expect(third.out.join("\n")).toContain(
        '--force: revoked old token "board-opencode"',
      );
      expect(tokenLines(third.out)).toHaveLength(1);
      // tokens.name is the PRIMARY KEY: the revoked row keeps "board-opencode",
      // the fresh active mint lands on the first free suffix.
      rows = db
        .prepare(
          "SELECT * FROM tokens WHERE name LIKE 'board-opencode%' ORDER BY created_at",
        )
        .all();
      expect(rows).toHaveLength(2);
      expect(
        (
          rows.find(
            (r) => (r as { name: string }).name === "board-opencode",
          ) as { revoked_at: string | null }
        ).revoked_at,
      ).not.toBeNull();
      expect(
        (
          rows.find(
            (r) => (r as { name: string }).name === "board-opencode-2",
          ) as { revoked_at: string | null }
        ).revoked_at,
      ).toBeNull();
      db.close();
    });
  });

  test("prints each token exactly once on stdout, never on stderr, and never writes tokens to files except the opencode entry's environment", () => {
    withIsolatedEnv(({ home, xdg }) => {
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: [],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(0);
      expect(err).toEqual([]);

      // default agents are opencode + claude
      const printed = tokenLines(out);
      expect(printed).toHaveLength(2);
      const [opencodeToken, claudeToken] = printed;
      const text = out.join("\n");
      expect(text.split(opencodeToken)).toHaveLength(2);
      expect(text.split(claudeToken)).toHaveLength(2);
      expect(out.join("\n")).toContain("cannot be shown again");

      for (const file of [...walkFiles(home), ...walkFiles(xdg)]) {
        const content = readFileSync(file, "utf8");
        const occurrences = content.split(opencodeToken).length - 1;
        if (file.endsWith("opencode.jsonc")) {
          expect(occurrences).toBe(1);
        } else {
          expect(occurrences).toBe(0);
        }
        expect(content.split(claudeToken).length - 1).toBe(0);
      }
      db.close();
    });
  });
});

describe("board install wiring", () => {
  test("copies the skill into opencode, claude, and ~/.agents skill dirs", () => {
    withIsolatedEnv(({ home, xdg }) => {
      const db = freshDb();
      const { out, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "opencode,claude,codex,pi"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(0);
      const expected = readFileSync(
        join(import.meta.dir, "..", "..", "..", "skills", "board", "SKILL.md"),
        "utf8",
      );
      for (const dest of [
        join(xdg, "opencode", "skills", "board", "SKILL.md"),
        join(home, ".claude", "skills", "board", "SKILL.md"),
        join(home, ".agents", "skills", "board", "SKILL.md"),
      ]) {
        expect(readFileSync(dest, "utf8")).toBe(expected);
      }
      // one skill copy per wired agent (codex + pi share ~/.agents/skills)
      expect(out.filter((line) => line.startsWith("skill: "))).toHaveLength(4);
      db.close();
    });
  });

  test("claude on PATH runs `claude mcp add` with verified flags and no manual fallback", () => {
    withIsolatedEnv(() => {
      const db = freshDb();
      const { out, io } = capture();
      const calls: string[][] = [];
      const code = runInstallCommand({
        db,
        argv: ["--agents", "claude"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: () => true,
        runClaude: (args) => {
          calls.push(args);
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      // Stdio form (D22), verified against `claude mcp add --help`: name, then
      // --env KEY=value, then `--` and the connector command (transport
      // defaults to stdio; no --transport/--header/--url needed).
      expect(calls[0]).toEqual([
        "mcp",
        "add",
        "--scope",
        "user",
        "board",
        "--env",
        `BOARD_MCP_TOKEN=${tokenLines(out)[0]}`,
        "--",
        MCP_CONNECTOR_COMMAND,
        MCP_CONNECTOR_PATH,
      ]);
      expect(out.join("\n")).not.toContain("manually");
      db.close();
    });
  });

  test("claude manual fallback prints the stdio add command with a placeholder token", () => {
    withIsolatedEnv(({ home }) => {
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "claude"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(0); // guidance, not a failure
      const text = out.join("\n");
      expect(text).toContain(
        "claude mcp add --scope user board --env BOARD_MCP_TOKEN=<board-claude-token>",
      );
      expect(text).toContain(
        `-- ${MCP_CONNECTOR_COMMAND} ${MCP_CONNECTOR_PATH}`,
      );
      expect(text).toContain("<board-claude-token>");
      expect(tokenLines(err)).toEqual([]);
      // the skill still copies even when the CLI is absent
      expect(
        existsSync(join(home, ".claude", "skills", "board", "SKILL.md")),
      ).toBe(true);
      db.close();
    });
  });

  test("codex/pi print command-form TOML snippets pointing at the connector", () => {
    withIsolatedEnv(() => {
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "codex,pi"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const text = out.join("\n");
      expect(text).toContain(`command = "${MCP_CONNECTOR_COMMAND}"`);
      expect(text).toContain(`args = ["${MCP_CONNECTOR_PATH}"]`);
      expect(text).toContain(
        `env = { "BOARD_MCP_TOKEN" = "<board-codex-token>" }`,
      );
      expect(text).toContain(
        `env = { "BOARD_MCP_TOKEN" = "<board-pi-token>" }`,
      );
      // no remote/url leftovers in the snippet form
      expect(text).not.toContain("http://127.0.0.1:7800/mcp");
      db.close();
    });
  });
});

describe("board install failure modes", () => {
  test("daemon down: warning printed, install still completes", () => {
    withIsolatedEnv(({ xdg }) => {
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "opencode"],
        io,
        checkHealth: () => false,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(0);
      expect(err.join("\n")).toContain("daemon not running");
      expect(err.join("\n")).toContain("make serve");
      // D22: the warning explains wiring is daemon-independent now
      expect(err.join("\n")).toContain("wiring works regardless");
      expect(err.join("\n")).toContain("persistent library");
      expect(existsSync(join(xdg, "opencode", "opencode.jsonc"))).toBe(true);
      expect(tokenLines(out)).toHaveLength(1);
      db.close();
    });
  });

  test("a failing agent (claude runner error) exits 1, prints the manual fix, and others still install", () => {
    withIsolatedEnv(({ home, xdg }) => {
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "opencode,claude"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: () => true,
        runClaude: () => 1,
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("failed to wire: claude");
      const text = out.join("\n");
      expect(text).toContain(
        "claude mcp add --scope user board --env BOARD_MCP_TOKEN=<board-claude-token>",
      );
      expect(text).toContain("--scope user");
      expect(text).toContain("<board-claude-token>");
      // opencode still wired
      expect(existsSync(join(xdg, "opencode", "opencode.jsonc"))).toBe(true);
      expect(
        existsSync(join(home, ".claude", "skills", "board", "SKILL.md")),
      ).toBe(true);
      db.close();
    });
  });

  test("unwritable opencode config exits 1 with a manual fix that contains no token material", () => {
    withIsolatedEnv(({ xdg }) => {
      const dir = join(xdg, "opencode");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "opencode.jsonc"), "{ broken");
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "opencode"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: NO_CLAUDE,
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("add it manually");
      expect(err.join("\n")).toContain("not valid JSONC");
      expect(tokenLines(err)).toEqual([]);
      expect(err.join("\n")).toContain("<board-opencode-token>");
      // the manual fix shows the D22 local shape, not the old remote entry
      expect(err.join("\n")).toContain('"type": "local"');
      expect(err.join("\n")).toContain('"timeout": 60000');
      expect(err.join("\n")).toContain(MCP_CONNECTOR_PATH);
      expect(tokenLines(out)).toHaveLength(1);
      db.close();
    });
  });

  test("read-only config filesystem (EROFS) prints the container guidance, not the manual-merge block, and no token on stderr", () => {
    withIsolatedEnv(({ xdg }) => {
      const db = freshDb();
      const { out, err, io } = capture();
      const realWriteFileSync = writeFileSync;
      const configPath = join(xdg, "opencode", "opencode.jsonc");
      try {
        // A real EROFS needs a read-only mount (not portable in tests), so
        // mock the write to raise exactly what a read-only filesystem does;
        // every other node:fs export stays real via the namespace spread.
        mock.module("node:fs", () => ({
          ...fs,
          writeFileSync: () => {
            throw new Error(
              `EROFS: read-only file system, open '${configPath}'`,
            );
          },
        }));
        const code = runInstallCommand({
          db,
          argv: ["--agents", "opencode"],
          io,
          checkHealth: HEALTHY,
          claudeOnPath: NO_CLAUDE,
        });
        expect(code).toBe(1);
      } finally {
        mock.module("node:fs", () => ({
          ...fs,
          writeFileSync: realWriteFileSync,
        }));
      }
      const text = err.join("\n");
      expect(text).toContain("read-only (EROFS)");
      expect(text).toContain("You are running inside a container");
      expect(text).toContain("export BOARD_MCP_TOKEN=");
      expect(text).toContain("on your host machine");
      expect(text).toContain(MCP_CONNECTOR_PATH);
      // the generic manual-merge guidance does not fit the container case
      expect(text).not.toContain('add it manually under "mcp"');
      // print-once discipline (invariant 7): the token rides stdout only —
      // the EROFS guidance carries the placeholder, never the plaintext
      const token = tokenLines(out)[0];
      expect(token).toBeDefined();
      expect(text).not.toContain(token);
      db.close();
    });
  });

  test("claude wiring failure with EROFS prints the container export guidance", () => {
    withIsolatedEnv(() => {
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "claude"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: () => true,
        runClaude: () => {
          throw new Error(
            "EROFS: read-only file system, open '/home/x/.claude.json'",
          );
        },
      });
      expect(code).toBe(1);
      const text = err.join("\n");
      expect(text).toContain("read-only (EROFS)");
      expect(text).toContain("You are running inside a container");
      expect(text).toContain("export BOARD_MCP_TOKEN=");
      expect(text).toContain(
        "claude mcp add --scope user board --env BOARD_MCP_TOKEN=<board-claude-token>",
      );
      const token = tokenLines(out)[0];
      expect(token).toBeDefined();
      expect(text).not.toContain(token);
      db.close();
    });
  });

  test("unknown agent or stray flag exits 1 with usage and mints nothing", () => {
    withIsolatedEnv(() => {
      const db = freshDb();
      for (const argv of [
        ["--agents", "frobnicate"],
        ["--agents"],
        ["--wat"],
      ]) {
        const { err, io } = capture();
        const code = runInstallCommand({
          db,
          argv,
          io,
          checkHealth: HEALTHY,
          claudeOnPath: NO_CLAUDE,
        });
        expect(code).toBe(1);
        expect(err.join("\n")).toContain(INSTALL_USAGE);
      }
      expect(db.prepare("SELECT * FROM tokens").all()).toEqual([]);
      db.close();
    });
  });
});

describe("board install dispatch", () => {
  interface Proc {
    exitCode: number;
    stdout: string;
    stderr: string;
  }

  function runCli(
    args: string[],
    env: Record<string, string>,
    cwd: string = join(import.meta.dir, "..", "..", ".."),
  ): Proc {
    const proc = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "main.ts"), ...args],
      {
        env,
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  test("subprocess: usage error never creates the default data dir", () => {
    const home = mkdtempSync(join(tmpdir(), "board-install-main-"));
    dirs.push(home);
    const proc = runCli(["install", "--agents", "frobnicate"], { HOME: home });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain("usage: board install");
    expect(existsSync(join(home, ".board"))).toBe(false);
  });

  test("subprocess: happy path wires the isolated config and prints each token once", () => {
    const home = mkdtempSync(join(tmpdir(), "board-install-main-"));
    const data = mkdtempSync(join(tmpdir(), "board-install-data-"));
    dirs.push(home, data);
    const proc = runCli(["install"], { HOME: home, BOARD_DATA_DIR: data });
    expect(proc.exitCode).toBe(0);
    const printed = proc.stdout
      .split("\n")
      .filter((line) => TOKEN_LINE.test(line));
    expect(printed).toHaveLength(2);
    const raw = readFileSync(
      join(home, ".config", "opencode", "opencode.jsonc"),
      "utf8",
    );
    const errors: ParseError[] = [];
    const config = parse(raw, errors) as {
      mcp: { board: { environment: { BOARD_MCP_TOKEN: string } } };
    };
    expect(errors).toEqual([]);
    expect(config.mcp.board.environment.BOARD_MCP_TOKEN).toBe(printed[0]);
  });

  test("subprocess: wiring from a foreign cwd still points at the repo connector (D22 repo-root derivation)", () => {
    const home = mkdtempSync(join(tmpdir(), "board-install-main-"));
    const data = mkdtempSync(join(tmpdir(), "board-install-data-"));
    const foreignCwd = mkdtempSync(join(tmpdir(), "board-install-cwd-"));
    dirs.push(home, data, foreignCwd);
    const proc = runCli(
      ["install", "--agents", "opencode"],
      { HOME: home, BOARD_DATA_DIR: data },
      foreignCwd,
    );
    expect(proc.exitCode).toBe(0);
    const raw = readFileSync(
      join(home, ".config", "opencode", "opencode.jsonc"),
      "utf8",
    );
    const errors: ParseError[] = [];
    const config = parse(raw, errors) as {
      mcp: { board: { command: string[] } };
    };
    expect(errors).toEqual([]);
    // cwd was a temp dir — only a module-location derivation can produce the
    // repo's real connector path here.
    expect(config.mcp.board.command).toEqual([
      MCP_CONNECTOR_COMMAND,
      MCP_CONNECTOR_PATH,
    ]);
  });
});
