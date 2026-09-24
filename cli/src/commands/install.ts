import type { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyEdits,
  modify,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import {
  type CreatedToken,
  createToken,
  reMintToken,
  TokenNameTaken,
} from "../../../server/src/tokens.ts";
import type { CommandIo } from "./token.ts";

const BOARD_HEALTH_URL = "http://127.0.0.1:7800/api/health";
export const INSTALL_USAGE =
  "usage: board install [--agents opencode,claude,codex,pi] [--force]";

// The D22 stdio connector (wave 2): what agent harnesses actually spawn, so
// MCP is available whenever ANY board server is up (shared daemon or a D20
// session instance) — not only when the shared daemon runs. REPO_ROOT derives
// from this module's own location (import.meta.url via import.meta.dir), never
// the cwd — `make install` may run from anywhere. Bare "node" matches the
// working playwright MCP precedent on this machine: opencode's env PATH has
// node but not reliably bun, which is why the connector is node-runnable.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
export const MCP_CONNECTOR_COMMAND = "node";
export const MCP_CONNECTOR_PATH = join(
  REPO_ROOT,
  "cli",
  "src",
  "mcp-connector.ts",
);

const AGENTS = ["opencode", "claude", "codex", "pi"] as const;
type Agent = (typeof AGENTS)[number];

const DEFAULT_AGENTS: Agent[] = ["opencode", "claude"];

interface InstallArgs {
  agents: Agent[];
  force: boolean;
}

interface InstallCommandInput {
  db: Database;
  argv: string[];
  io: CommandIo;
  // Seams (open.ts pattern): tests inject fakes so nothing touches the
  // network or the real claude CLI.
  checkHealth?: () => boolean;
  claudeOnPath?: () => boolean;
  runClaude?: (args: string[]) => number;
}

export function parseInstallArgs(argv: string[]): InstallArgs | string {
  let agents: Agent[] = [...DEFAULT_AGENTS];
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    const raw =
      arg === "--agents"
        ? argv[i + 1]
        : arg?.startsWith("--agents=")
          ? arg.slice("--agents=".length)
          : undefined;
    if (arg === "--agents" || arg?.startsWith("--agents=")) {
      i++;
      if (raw === undefined || raw.length === 0) {
        return "--agents needs a comma-separated list";
      }
      agents = [];
      for (const part of raw.split(",")) {
        const name = part.trim();
        if (!(AGENTS as readonly string[]).includes(name)) {
          return `unknown agent "${name}" (known: ${AGENTS.join(", ")})`;
        }
        if (!agents.includes(name as Agent)) {
          agents.push(name as Agent);
        }
      }
      if (agents.length === 0) {
        return "--agents needs at least one agent";
      }
      continue;
    }
    return `unknown argument "${arg}"`;
  }
  return { agents, force };
}

// Sync probe via a spawned bun fetch (open.ts's spawnXdgOpen pattern) — keeps
// the whole command synchronous. Any failure means "not reachable", which only
// downgrades UX: install continues.
function defaultCheckHealth(): boolean {
  try {
    const probe = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        "const r = await fetch(process.env.BOARD_HEALTH_URL, { signal: AbortSignal.timeout(2000) }).catch(() => null); process.exit(r?.ok ? 0 : 1);",
      ],
      {
        env: { ...process.env, BOARD_HEALTH_URL: BOARD_HEALTH_URL },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

function defaultClaudeOnPath(): boolean {
  return Bun.which("claude") !== null;
}

function defaultRunClaude(args: string[]): number {
  const proc = Bun.spawnSync(["claude", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode ?? 1;
}

const REPO_SKILL = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "skills",
  "board",
  "SKILL.md",
);

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim().length > 0) {
    return xdg;
  }
  return join(homedir(), ".config");
}

// os.homedir() caches and ignores a live HOME change (bun/node), so read $HOME
// directly — tests redirect it, and POSIX shells always set it.
function homeDir(): string {
  const home = process.env.HOME;
  if (home !== undefined && home.trim().length > 0) {
    return home;
  }
  return homedir();
}

function copySkill(dest: string, io: CommandIo): boolean {
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(REPO_SKILL, dest);
    io.stdout(`skill: ${dest}`);
    return true;
  } catch (err) {
    io.stderr(
      `board: could not copy the board skill to ${dest} (${err instanceof Error ? err.message : String(err)}); copy ${REPO_SKILL} there manually`,
    );
    return false;
  }
}

export class OpencodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodeConfigError";
  }
}

interface BoardMcpEntry {
  // Local stdio entry (D22): opencode spawns the connector itself; the token
  // rides `environment` (plaintext in agent config — the same exposure class
  // D17/D20 accept) instead of an HTTP header, because the connector owns the
  // per-request backend resolution.
  type: "local";
  command: string[];
  enabled: boolean;
  // opencode's local-server default (5s per its schema) is shorter than a
  // board_publish render; 60000 matches the connector's PROXY_TIMEOUT_MS.
  timeout: number;
  environment: { BOARD_MCP_TOKEN: string };
}

// Comment-preserving merge into opencode.jsonc: modify computes a surgical
// edit at ["mcp", "board"], so unrelated keys and comments survive verbatim.
export function mergeOpencodeConfig(
  text: string,
  entry: BoardMcpEntry,
): string {
  if (text.trim().length === 0) {
    return `${JSON.stringify({ mcp: { board: entry } }, null, 2)}\n`;
  }
  // opencode's own loader accepts trailing commas (verified against v2.0.16),
  // so a config opencode runs happily must not fail our stricter parse.
  const errors: ParseError[] = [];
  parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new OpencodeConfigError(
      `not valid JSONC (${errors.map((e) => printParseErrorCode(e.error)).join(", ")})`,
    );
  }
  const edits = modify(text, ["mcp", "board"], entry, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      insertFinalNewline: true,
    },
  });
  return applyEdits(text, edits);
}

function manualTokenNote(agent: Agent): string {
  return `BOARD_MCP_TOKEN=<board-${agent}-token> (replace with the token printed above)`;
}

function wireOpencode(token: string, io: CommandIo): boolean {
  const configPath = join(configHome(), "opencode", "opencode.jsonc");
  const skillDest = join(
    configHome(),
    "opencode",
    "skills",
    "board",
    "SKILL.md",
  );
  const entry: BoardMcpEntry = {
    type: "local",
    command: [MCP_CONNECTOR_COMMAND, MCP_CONNECTOR_PATH],
    enabled: true,
    timeout: 60000,
    environment: { BOARD_MCP_TOKEN: token },
  };
  let ok = true;
  try {
    const existing = existsSync(configPath)
      ? readFileSync(configPath, "utf8")
      : "";
    const merged = mergeOpencodeConfig(existing, entry);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, merged);
    io.stdout(`wired: ${configPath}`);
  } catch (err) {
    ok = false;
    // Container case: a read-only agent-config filesystem (EROFS) means the
    // token never gets wired, so the connector silently falls through to the
    // newest session instance while the human's browser hits the shared
    // daemon — a split-brain the env-var fix below resolves. The placeholder
    // (not the token) keeps stderr token-free: the plaintext was printed once
    // above, on stdout (invariant 7).
    const isReadOnly = err instanceof Error && err.message?.includes("EROFS");
    if (isReadOnly) {
      io.stderr(
        `board: ${configPath} is read-only (EROFS). You are running inside a container.\n` +
          `Set BOARD_MCP_TOKEN in the connector's environment so it prefers the shared daemon:\n` +
          `  export BOARD_MCP_TOKEN=<board-opencode-token>\n` +
          `Or add this MCP entry to opencode.jsonc on your host machine:\n` +
          `  "board": {\n` +
          `    "type": "local",\n` +
          `    "command": ["${MCP_CONNECTOR_COMMAND}", "${MCP_CONNECTOR_PATH}"],\n` +
          `    "enabled": true,\n` +
          `    "timeout": 60000,\n` +
          `    "environment": { "BOARD_MCP_TOKEN": "<board-opencode-token>" }\n` +
          `  }`,
      );
      io.stderr(`  (${manualTokenNote("opencode")})`);
    } else {
      io.stderr(
        `board: could not merge the board MCP entry into ${configPath} (${err instanceof Error ? err.message : String(err)}); add it manually under "mcp":`,
      );
      io.stderr(`  "board": {`);
      io.stderr(`    "type": "local",`);
      io.stderr(
        `    "command": ["${MCP_CONNECTOR_COMMAND}", "${MCP_CONNECTOR_PATH}"],`,
      );
      io.stderr(`    "enabled": true,`);
      io.stderr(`    "timeout": 60000,`);
      io.stderr(
        `    "environment": { "BOARD_MCP_TOKEN": "<board-opencode-token>" }`,
      );
      io.stderr(`  }`);
      io.stderr(`  (${manualTokenNote("opencode")})`);
    }
  }
  return copySkill(skillDest, io) && ok;
}

function printClaudeManual(io: CommandIo): void {
  io.stdout(
    "claude CLI not found on PATH or `claude mcp add` failed; add the board connector manually:",
  );
  io.stdout(
    `  claude mcp add --scope user board --env BOARD_MCP_TOKEN=<board-claude-token> -- ${MCP_CONNECTOR_COMMAND} ${MCP_CONNECTOR_PATH}`,
  );
  io.stdout(
    "  (--scope user makes the server available in all projects; " +
      manualTokenNote("claude") +
      ")",
  );
}

function wireClaude(
  token: string,
  io: CommandIo,
  claudeOnPath: () => boolean,
  runClaude: (args: string[]) => number,
): boolean {
  let ok = true;
  if (claudeOnPath()) {
    // Stdio form (D22): the real `claude mcp add` syntax — name, then
    // `--env KEY=value`, then `--` and the connector command (transport
    // defaults to stdio). Verified against `claude mcp add --help`.
    const args = [
      "mcp",
      "add",
      "--scope",
      "user",
      "board",
      "--env",
      `BOARD_MCP_TOKEN=${token}`,
      "--",
      MCP_CONNECTOR_COMMAND,
      MCP_CONNECTOR_PATH,
    ];
    try {
      if (runClaude(args) === 0) {
        io.stdout("wired: claude mcp (user scope)");
      } else {
        ok = false;
        printClaudeManual(io);
      }
    } catch (err) {
      ok = false;
      // Same container case as wireOpencode: an EROFS from the wiring attempt
      // means the claude config lives on a read-only filesystem — point at
      // the env-var fix (placeholder, never the token: invariant 7).
      const isReadOnly = err instanceof Error && err.message?.includes("EROFS");
      if (isReadOnly) {
        io.stderr(
          `board: \`claude mcp add\` failed because its config is read-only (EROFS). You are running inside a container.\n` +
            `Set BOARD_MCP_TOKEN in the connector's environment so it prefers the shared daemon:\n` +
            `  export BOARD_MCP_TOKEN=<board-claude-token>\n` +
            `Or run this on your host machine:\n` +
            `  claude mcp add --scope user board --env BOARD_MCP_TOKEN=<board-claude-token> -- ${MCP_CONNECTOR_COMMAND} ${MCP_CONNECTOR_PATH}`,
        );
        io.stderr(`  (${manualTokenNote("claude")})`);
      } else {
        printClaudeManual(io);
      }
    }
  } else {
    // Guidance, not a failure: a machine without claude installed is fine.
    printClaudeManual(io);
  }
  return (
    copySkill(join(homeDir(), ".claude", "skills", "board", "SKILL.md"), io) &&
    ok
  );
}

function wireTomlAgent(agent: Agent, io: CommandIo): boolean {
  if (agent === "codex") {
    io.stdout(
      "no automated wiring for codex; add this to ~/.codex/config.toml (example, verify against your codex version):",
    );
  } else {
    io.stdout(
      "no automated wiring for pi; add an equivalent MCP server entry to your pi config (codex-style TOML example, verify against your version):",
    );
  }
  io.stdout(`  [mcp_servers.board]`);
  io.stdout(`  command = "${MCP_CONNECTOR_COMMAND}"`);
  io.stdout(`  args = ["${MCP_CONNECTOR_PATH}"]`);
  io.stdout(`  env = { "BOARD_MCP_TOKEN" = "<board-${agent}-token>" }`);
  io.stdout(`  (${manualTokenNote(agent)})`);
  return copySkill(
    join(homeDir(), ".agents", "skills", "board", "SKILL.md"),
    io,
  );
}

function wireAgent(
  agent: Agent,
  token: string,
  io: CommandIo,
  claudeOnPath: () => boolean,
  runClaude: (args: string[]) => number,
): boolean {
  switch (agent) {
    case "opencode":
      return wireOpencode(token, io);
    case "claude":
      return wireClaude(token, io, claudeOnPath, runClaude);
    case "codex":
    case "pi":
      return wireTomlAgent(agent, io);
  }
}

function mintToken(
  db: Database,
  agent: Agent,
  force: boolean,
  io: CommandIo,
): CreatedToken | null {
  const name = `board-${agent}`;
  if (force) {
    const { previous, created } = reMintToken(db, { name });
    if (previous !== null && previous.revoked_at === null) {
      io.stdout(`--force: revoked old token "${name}"`);
    }
    return created;
  }
  try {
    return createToken(db, { name });
  } catch (err) {
    if (err instanceof TokenNameTaken) {
      // Without --force there is nothing to wire: the plaintext token is
      // gone (stored hashed, invariant 8), so re-minting is required. Give
      // the exact runnable commands — `make install --force` does NOT work
      // (GNU make eats dash-flags as its own options).
      io.stdout(
        `already installed for ${agent} — re-mint with: make install FLAGS=--force (or: bun run cli/src/main.ts install --force)`,
      );
      return null;
    }
    throw err;
  }
}

export function runInstallCommand({
  db,
  argv,
  io,
  checkHealth = defaultCheckHealth,
  claudeOnPath = defaultClaudeOnPath,
  runClaude = defaultRunClaude,
}: InstallCommandInput): number {
  const parsed = parseInstallArgs(argv);
  if (typeof parsed === "string") {
    io.stderr(`board: ${parsed}`);
    io.stderr(INSTALL_USAGE);
    return 1;
  }
  const { agents, force } = parsed;
  if (!checkHealth()) {
    // D22: a down daemon barely matters for wiring — the connector lists the
    // tools offline and its tool calls explain how to start a server; the
    // shared daemon is only the persistent library (D21).
    io.stderr(
      "board: warning: shared daemon not running — wiring works regardless (the connector lists the board tools offline, and each tool call explains how to start a server); `make serve` is only needed for the persistent library (D21)",
    );
  }
  const failed: Agent[] = [];
  for (const agent of agents) {
    io.stdout(`== ${agent} ==`);
    const token = mintToken(db, agent, force, io);
    if (token === null) {
      continue;
    }
    // Print-once discipline (invariant 8): the token is stored hashed, so
    // this is the only time the plaintext exists after the mint — if the
    // agent config is lost, the fix is a --force re-mint, not a re-show.
    io.stdout(
      `token for "${token.name}" (store it now — it is stored hashed and cannot be shown again):`,
    );
    io.stdout(token.token);
    if (!wireAgent(agent, token.token, io, claudeOnPath, runClaude)) {
      failed.push(agent);
    }
  }
  if (failed.length > 0) {
    io.stderr(
      `board: failed to wire: ${failed.join(", ")} — apply the manual steps printed above`,
    );
    return 1;
  }
  return 0;
}
