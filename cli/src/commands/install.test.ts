import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
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
import { createToken } from "../../../server/src/tokens.ts";
import {
  INSTALL_USAGE,
  MCP_CONNECTOR_COMMAND,
  MCP_CONNECTOR_PATH,
  mergeOpencodeConfig,
  OpencodeConfigError,
  opencodeConfigPath,
  reportSkillCopyFailure,
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

// The skills `install` ships. Kept here rather than imported so a skill added
// to install.ts without a test update fails loudly instead of silently.
const SKILL_NAMES_UNDER_TEST = ["board", "interview"] as const;
const SKILL_COUNT = SKILL_NAMES_UNDER_TEST.length;
// Listed here for the same reason: a template added to skills/templates/ should
// show up as a deliberate test change, not pass silently.
const TEMPLATES_UNDER_TEST = [
  "dashboard.html",
  "interview-round.html",
] as const;

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
          servers: {
            board: {
              type: string;
              command: string[];
              disabled: boolean;
              timeout: { catalog: number; execution: number };
              environment: { BOARD_MCP_TOKEN: string };
            };
          };
        };
      };
      expect(errors).toEqual([]);
      expect(config.model).toBe("anthropic/claude-opus-4");
      expect(config.plugin["gh-pr"]).toBe(true);
      const board = config.mcp.servers.board;
      expect(board.type).toBe("local");
      expect(board.command).toEqual([
        MCP_CONNECTOR_COMMAND,
        MCP_CONNECTOR_PATH,
      ]);
      expect(board.disabled).toBe(false);
      expect(board.timeout).toEqual({ catalog: 60000, execution: 60000 });
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
          servers: {
            board: {
              type: string;
              command: string[];
              disabled: boolean;
              timeout: { catalog: number; execution: number };
              environment: { BOARD_MCP_TOKEN: string };
            };
          };
        };
      };
      expect(errors).toEqual([]);
      expect(config.mcp.servers.board.type).toBe("local");
      expect(config.mcp.servers.board.command).toEqual([
        MCP_CONNECTOR_COMMAND,
        MCP_CONNECTOR_PATH,
      ]);
      expect(config.mcp.servers.board.disabled).toBe(false);
      expect(config.mcp.servers.board.timeout).toEqual({
        catalog: 60000,
        execution: 60000,
      });
      expect(config.mcp.servers.board.environment.BOARD_MCP_TOKEN).toBe(
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
          board?: unknown;
          servers: {
            board: {
              type: string;
              url?: string;
              headers?: unknown;
              command: string[];
              timeout: { catalog: number; execution: number };
              environment: { BOARD_MCP_TOKEN: string };
            };
          };
        };
      };
      expect(errors).toEqual([]);
      const board = config.mcp.servers.board;
      expect(board.type).toBe("local");
      expect(board.command).toEqual([
        MCP_CONNECTOR_COMMAND,
        MCP_CONNECTOR_PATH,
      ]);
      expect(board.url).toBeUndefined();
      expect(board.headers).toBeUndefined();
      expect(board.timeout).toEqual({ catalog: 60000, execution: 60000 });
      expect(board.environment.BOARD_MCP_TOKEN).toBe(tokenLines(out)[0]);
      // D24: the legacy key is deleted, not left shadowed as dead config.
      expect(config.mcp.board).toBeUndefined();
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

  // D24 — the shape opencode v2 actually accepts. Measured against v2.0.16:
  // a scalar `timeout` makes v2 DROP the whole server entry silently, so this
  // assertion is the tripwire for a regression that would otherwise be
  // invisible until someone noticed the board tools had vanished.
  test("writes the native v2 entry shape: timeout is {catalog, execution}, never a scalar", () => {
    const merged = mergeOpencodeConfig("{}\n", {
      type: "local",
      command: [MCP_CONNECTOR_COMMAND, MCP_CONNECTOR_PATH],
      disabled: false,
      timeout: { catalog: 60000, execution: 60000 },
      environment: { BOARD_MCP_TOKEN: "x" },
    });
    const errors: ParseError[] = [];
    const parsed = parse(merged, errors);
    expect(errors).toEqual([]);
    const entry = parsed.mcp.servers.board;
    expect(typeof entry.timeout).toBe("object");
    expect(entry.timeout).toEqual({ catalog: 60000, execution: 60000 });
    expect(entry.disabled).toBe(false);
    // `enabled` is v1's key; v2 strips it on load, so writing it is a no-op
    // we would mistake for configuration.
    expect(entry.enabled).toBeUndefined();
  });

  test("mergeOpencodeConfig deletes a legacy mcp.board while writing the native entry", () => {
    const merged = mergeOpencodeConfig(
      `{
  // keep me
  "mcp": {
    "board": { "type": "local", "command": ["node", "/old.ts"], "enabled": true },
    "servers": { "other": { "type": "local", "command": ["node", "/other.ts"] } }
  }
}
`,
      {
        type: "local",
        command: [MCP_CONNECTOR_COMMAND, MCP_CONNECTOR_PATH],
        disabled: false,
        timeout: { catalog: 60000, execution: 60000 },
        environment: { BOARD_MCP_TOKEN: "fresh" },
      },
    );
    expect(merged).toContain("// keep me");
    const errors: ParseError[] = [];
    const parsed = parse(merged, errors);
    expect(errors).toEqual([]);
    expect(parsed.mcp.board).toBeUndefined();
    expect(parsed.mcp.servers.board.environment.BOARD_MCP_TOKEN).toBe("fresh");
    // a co-resident server someone else wired is untouched
    expect(parsed.mcp.servers.other.command).toEqual(["node", "/other.ts"]);
  });

  test("opencodeConfigPath targets the file that already exists, preferring .jsonc", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-install-cfgpath-"));
    dirs.push(dir);
    // fresh install: nothing there yet -> .jsonc (board writes comments)
    expect(opencodeConfigPath(dir)).toBe(join(dir, "opencode.jsonc"));
    // v2's own `mcp add` wrote opencode.json -> don't create a second file
    writeFileSync(join(dir, "opencode.json"), "{}\n");
    expect(opencodeConfigPath(dir)).toBe(join(dir, "opencode.json"));
    // both present -> .jsonc wins
    writeFileSync(join(dir, "opencode.jsonc"), "{}\n");
    expect(opencodeConfigPath(dir)).toBe(join(dir, "opencode.jsonc"));
  });

  test("mergeOpencodeConfig accepts trailing commas, as opencode does", () => {
    const merged = mergeOpencodeConfig(
      '{\n  // local models\n  "provider": { "ollama": {}, },\n}\n',
      {
        type: "local",
        command: [MCP_CONNECTOR_COMMAND, MCP_CONNECTOR_PATH],
        disabled: false,
        timeout: { catalog: 60000, execution: 60000 },
        environment: { BOARD_MCP_TOKEN: "x" },
      },
    );
    expect(merged).toContain("// local models");
    const errors: ParseError[] = [];
    const parsed = parse(merged, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect(parsed.mcp.servers.board.environment.BOARD_MCP_TOKEN).toBe("x");
    expect(parsed.provider).toEqual({ ollama: {} });
  });

  test("mergeOpencodeConfig rejects invalid JSONC with a parse-error message", () => {
    try {
      mergeOpencodeConfig('{ "mcp": }', {
        type: "local",
        command: [MCP_CONNECTOR_COMMAND, MCP_CONNECTOR_PATH],
        disabled: false,
        timeout: { catalog: 60000, execution: 60000 },
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
        "already installed for opencode — skills refreshed above; the credential and MCP entry are unchanged.",
      );
      expect(tokenLines(second.out)).toEqual([]);
      // D26: the skills still ship on a re-run. They used to be skipped with
      // the mint, so the only way to update a skill was to rotate every
      // agent's credential — copying a file is not a credential operation.
      expect(
        second.out.filter((line) => line.startsWith("skill: ")),
      ).toHaveLength(SKILL_COUNT);
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
  test("copies every shipped skill and its templates into every agent's skills dir", () => {
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
      // D25: board ships two skills — the review loop and the scoping method
      // that drives it. Both land in every agent's skills root.
      for (const name of SKILL_NAMES_UNDER_TEST) {
        const expected = readFileSync(
          join(import.meta.dir, "..", "..", "..", "skills", name, "SKILL.md"),
          "utf8",
        );
        for (const root of [
          join(xdg, "opencode", "skills"),
          join(home, ".claude", "skills"),
          join(home, ".agents", "skills"),
        ]) {
          expect(readFileSync(join(root, name, "SKILL.md"), "utf8")).toBe(
            expected,
          );
          // The templates travel with the skill. Without them the skill points
          // an agent in any other repo at a file it cannot open, while telling
          // it not to hand-roll the submit call that file contains.
          for (const file of TEMPLATES_UNDER_TEST) {
            expect(
              readFileSync(join(root, name, "templates", file), "utf8"),
            ).toBe(
              readFileSync(
                join(
                  import.meta.dir,
                  "..",
                  "..",
                  "..",
                  "skills",
                  "templates",
                  file,
                ),
                "utf8",
              ),
            );
          }
        }
      }
      expect(out.filter((line) => line.startsWith("skill: "))).toHaveLength(
        SKILL_COUNT * 4,
      );
      db.close();
    });
  });

  // The agentbox shape, end to end: the host already populated the skills dir
  // and the box cannot write to it. `install` used to wire claude perfectly and
  // then report `failed to wire: claude`, sending the human to manual steps for
  // an unrelated problem — and failing any container setup script that checked
  // the exit code.
  test("an unwritable skills dir that already holds the skills is not a failure", () => {
    withIsolatedEnv(({ home }) => {
      const db = freshDb();
      const skillsRoot = join(home, ".claude", "skills");
      const lockedDirs: string[] = [];
      const lockedFiles: string[] = [];
      // Pre-populate exactly what a host install leaves behind.
      for (const name of SKILL_NAMES_UNDER_TEST) {
        const skillDir = join(skillsRoot, name);
        const templateDir = join(skillDir, "templates");
        mkdirSync(templateDir, { recursive: true });
        const skillFile = join(skillDir, "SKILL.md");
        writeFileSync(skillFile, "host copy");
        lockedFiles.push(skillFile);
        for (const file of TEMPLATES_UNDER_TEST) {
          const path = join(templateDir, file);
          writeFileSync(path, "host copy");
          lockedFiles.push(path);
        }
        lockedDirs.push(templateDir, skillDir);
      }
      // Read-only from here on. Both the files AND their directories: on a
      // read-only mount neither is writable, and overwriting an existing file
      // needs write permission on the FILE, not on its directory — locking
      // only the directory leaves the copy succeeding.
      //
      // EACCES here rather than EROFS, deliberately: the usability rule keys
      // off the file being present, not off which errno explained the failure.
      for (const path of lockedFiles) {
        chmodSync(path, 0o400);
      }
      for (const dir of lockedDirs) {
        chmodSync(dir, 0o500);
      }
      try {
        const { out, err, io } = capture();
        const code = runInstallCommand({
          db,
          argv: ["--agents", "claude"],
          io,
          checkHealth: HEALTHY,
          claudeOnPath: NO_CLAUDE,
        });
        expect(code).toBe(0);
        expect(err.join("\n")).not.toContain("failed to wire");
        // and it says so positively rather than looking like a failure
        expect(
          out.filter((line) => line.includes("already present, not refreshed")),
        ).toHaveLength(SKILL_COUNT);
        db.close();
      } finally {
        for (const dir of lockedDirs) {
          chmodSync(dir, 0o700);
        }
        for (const path of lockedFiles) {
          chmodSync(path, 0o600);
        }
      }
    });
  });

  // The other half of the rule: unwritable AND missing is a real failure, because
  // the skill would point the agent at a template it cannot open.
  test("an unwritable skills dir with nothing in it still fails", () => {
    withIsolatedEnv(({ home }) => {
      const db = freshDb();
      const skillsRoot = join(home, ".claude", "skills");
      mkdirSync(skillsRoot, { recursive: true });
      chmodSync(skillsRoot, 0o500);
      try {
        const { err, io } = capture();
        const code = runInstallCommand({
          db,
          argv: ["--agents", "claude"],
          io,
          checkHealth: HEALTHY,
          claudeOnPath: NO_CLAUDE,
        });
        expect(code).toBe(1);
        expect(err.join("\n")).toContain("failed to wire");
        db.close();
      } finally {
        chmodSync(skillsRoot, 0o700);
      }
    });
  });

  // The #9 regression, now guarded rather than merely fixed: `claude mcp add`
  // on an existing name printed "already exists", exited 0 and wrote nothing.
  // A zero exit from the CLI is not evidence the credential landed, so install
  // reads it back and refuses to call that a success.
  test("a wire that reports success but stores nothing is caught, not believed", () => {
    withIsolatedEnv(() => {
      const db = freshDb();
      const { out, err, io } = capture();
      const code = runInstallCommand({
        db,
        argv: ["--agents", "claude"],
        io,
        checkHealth: HEALTHY,
        claudeOnPath: () => true,
        // exits 0 and writes nothing — exactly the measured no-op
        runClaude: () => 0,
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("reported a successful wire");
      expect(err.join("\n")).toContain("would 401");
      // and the plaintext still reached the human, so nothing is lost
      expect(tokenLines(out)).toHaveLength(1);
      db.close();
    });
  });

  // D25: a read-only skills dir means a container — agent sandboxes mount the
  // host's skills dir read-only. "Copy it there manually" is advice the human
  // cannot follow either, so the EROFS branch names the real fix instead.
  test("EROFS names the container fix; other errors keep the manual advice", () => {
    const rofs = capture();
    reportSkillCopyFailure(
      "/repo/skills/board/SKILL.md",
      "/home/node/.claude/skills/board/SKILL.md",
      new Error(
        "EROFS: read-only file system, mkdir '/home/node/.claude/skills/board'",
      ),
      rofs.io,
    );
    const text = rofs.err.join("\n");
    expect(text).toContain("read-only filesystem");
    expect(text).toContain("you are running inside a container");
    expect(text).toContain("run `make install` on your HOST machine");
    expect(text).not.toContain("copy it there manually");

    // a plain permissions error IS fixable by hand — keep the old advice
    const other = capture();
    reportSkillCopyFailure(
      "/repo/skills/interview/SKILL.md",
      "/somewhere/interview/SKILL.md",
      new Error("EACCES: permission denied"),
      other.io,
    );
    expect(other.err.join("\n")).toContain("copy it there manually");
    expect(other.err.join("\n")).not.toContain("inside a container");
  });

  // D28: a re-run refreshes the MCP entry SHAPE without rotating credentials.
  // The plaintext is unavailable after the mint (stored hashed, invariant 7) —
  // but it is already sitting in the config we are about to rewrite, so it is
  // read back and reused. This is what makes a shape change like D24 reach an
  // existing install without costing every agent its session.
  test("a re-run rewires opencode with the token already in its config", () => {
    withIsolatedEnv(({ xdg }) => {
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
      const minted = tokenLines(first.out)[0];
      const configPath = join(xdg, "opencode", "opencode.jsonc");
      const wiredToken = (): string =>
        (
          parse(readFileSync(configPath, "utf8"), [], {
            allowTrailingComma: true,
          }) as {
            mcp: {
              servers: { board: { environment: Record<string, string> } };
            };
          }
        ).mcp.servers.board.environment.BOARD_MCP_TOKEN;
      expect(wiredToken()).toBe(minted);

      // corrupt the entry the way a stale shape would look, then re-run
      writeFileSync(
        configPath,
        JSON.stringify({
          mcp: {
            servers: {
              board: {
                type: "local",
                command: ["stale"],
                environment: { BOARD_MCP_TOKEN: minted },
              },
            },
          },
        }),
      );

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
      // nothing minted, nothing printed, same credential still wired
      expect(tokenLines(second.out)).toEqual([]);
      expect(wiredToken()).toBe(minted);
      expect(second.out.join("\n")).toContain(
        "re-wired opencode with its existing credential",
      );
      // ...and the entry shape is current again, not the stale one
      const entry = (
        parse(readFileSync(configPath, "utf8"), [], {
          allowTrailingComma: true,
        }) as {
          mcp: {
            servers: {
              board: { command: string[]; timeout: { catalog: number } };
            };
          };
        }
      ).mcp.servers.board;
      expect(entry.command).not.toEqual(["stale"]);
      expect(entry.timeout.catalog).toBe(60000);
      db.close();
    });
  });

  test("a re-run reads claude's wired token back out of ~/.claude.json", () => {
    withIsolatedEnv(({ home }) => {
      const db = freshDb();
      const existing = "tok-already-wired";
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { board: { env: { BOARD_MCP_TOKEN: existing } } },
        }),
      );
      // an agent that already holds a credential: mintToken returns null
      createToken(db, { name: "board-claude" });

      const { out, io } = capture();
      const calls: string[][] = [];
      expect(
        runInstallCommand({
          db,
          argv: ["--agents", "claude"],
          io,
          checkHealth: HEALTHY,
          claudeOnPath: () => true,
          runClaude: (args) => {
            calls.push(args);
            return 0;
          },
        }),
      ).toBe(0);
      expect(tokenLines(out)).toEqual([]);
      expect(calls[1]).toContain(`BOARD_MCP_TOKEN=${existing}`);
      // the secret is reused, never echoed
      expect(out.join("\n")).not.toContain(existing);
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
        // A faithful fake: a real successful `claude mcp add` writes the
        // credential into ~/.claude.json, and install now reads it back, so a
        // fake that only returns 0 is indistinguishable from the #9 no-op.
        runClaude: (args) => {
          calls.push(args);
          const add = args[0] === "mcp" && args[1] === "add";
          if (add) {
            const env = args[args.indexOf("--env") + 1] ?? "";
            writeFileSync(
              join(process.env.HOME ?? "", ".claude.json"),
              JSON.stringify({
                mcpServers: {
                  board: {
                    env: {
                      BOARD_MCP_TOKEN: env.slice("BOARD_MCP_TOKEN=".length),
                    },
                  },
                },
              }),
            );
          }
          return 0;
        },
      });
      expect(code).toBe(0);
      // D28: remove ALWAYS precedes add. `claude mcp add` on an existing name
      // prints "already exists" and exits 0 — a silent no-op we reported as
      // success, which under --force left the freshly revoked token in the
      // config (measured against claude 2.1.282).
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(["mcp", "remove", "--scope", "user", "board"]);
      // Stdio form (D22), verified against `claude mcp add --help`: name, then
      // --env KEY=value, then `--` and the connector command (transport
      // defaults to stdio; no --transport/--header/--url needed).
      expect(calls[1]).toEqual([
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
      expect(err.join("\n")).toContain(
        '"timeout": { "catalog": 60000, "execution": 60000 }',
      );
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
      mcp: { servers: { board: { environment: { BOARD_MCP_TOKEN: string } } } };
    };
    expect(errors).toEqual([]);
    expect(config.mcp.servers.board.environment.BOARD_MCP_TOKEN).toBe(
      printed[0],
    );
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
      mcp: { servers: { board: { command: string[] } } };
    };
    expect(errors).toEqual([]);
    // cwd was a temp dir — only a module-location derivation can produce the
    // repo's real connector path here.
    expect(config.mcp.servers.board.command).toEqual([
      MCP_CONNECTOR_COMMAND,
      MCP_CONNECTOR_PATH,
    ]);
  });
});
