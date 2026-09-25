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
  parse,
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

// Every skill board ships. `board` is the review loop; `interview` is the
// scoping method that drives it (D25). Both land in the same per-agent skills
// root, so adding a third is one entry here.
const SKILL_NAMES = ["board", "interview"] as const;

// Where each agent looks for skills. codex and pi share one root on purpose —
// neither has automated MCP wiring, but both read ~/.agents/skills.
// The credential already wired into an agent's config (D28, ruled C).
//
// Re-writing an MCP entry needs the plaintext token, and the plaintext only
// exists at mint time — tokens are stored hashed (invariant 7). That used to
// mean the only way to refresh a stale entry shape was `--force`, which
// revokes and re-mints every agent's credential on every update. But the
// plaintext is already in the file we are about to rewrite, so read it back
// and reuse it: nothing new is stored, nothing is printed, and the entry gets
// the current shape without costing anyone their session.
//
// Returns null when there is no entry to read — a first install, or a config
// this never wired.
function readWiredToken(agent: Agent): string | null {
  try {
    if (agent === "opencode") {
      const path = opencodeConfigPath(join(configHome(), "opencode"));
      if (!existsSync(path)) {
        return null;
      }
      const config = parse(readFileSync(path, "utf8"), [], {
        allowTrailingComma: true,
      }) as Record<string, unknown> | undefined;
      const mcp = config?.mcp as Record<string, unknown> | undefined;
      const servers = mcp?.servers as Record<string, unknown> | undefined;
      // the D24 native shape first, then the pre-D24 legacy one
      for (const entry of [servers?.board, mcp?.board]) {
        const env = (entry as { environment?: Record<string, unknown> })
          ?.environment;
        const token = env?.BOARD_MCP_TOKEN;
        if (typeof token === "string" && token.length > 0) {
          return token;
        }
      }
      return null;
    }
    if (agent === "claude") {
      const path = join(homeDir(), ".claude.json");
      if (!existsSync(path)) {
        return null;
      }
      const config = JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers?: Record<string, { env?: Record<string, unknown> }>;
      };
      const token = config.mcpServers?.board?.env?.BOARD_MCP_TOKEN;
      return typeof token === "string" && token.length > 0 ? token : null;
    }
    // codex and pi are paste-a-snippet only — nothing of ours to read back
    return null;
  } catch {
    // an unreadable or malformed config is not a failure here: the caller
    // falls back to telling the human to re-mint
    return null;
  }
}

function agentSkillsRoot(agent: Agent): string {
  switch (agent) {
    case "opencode":
      return join(configHome(), "opencode", "skills");
    case "claude":
      return join(homeDir(), ".claude", "skills");
    case "codex":
    case "pi":
      return join(homeDir(), ".agents", "skills");
  }
}

function repoSkillPath(name: string): string {
  return join(import.meta.dir, "..", "..", "..", "skills", name, "SKILL.md");
}

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

// Copies every shipped skill into one agent's skills root (the directory that
// holds <name>/SKILL.md). Returns false if any copy failed — the caller turns
// that into a non-zero exit.
function copySkills(skillsRoot: string, io: CommandIo): boolean {
  let ok = true;
  for (const name of SKILL_NAMES) {
    const src = repoSkillPath(name);
    const dest = join(skillsRoot, name, "SKILL.md");
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      io.stdout(`skill: ${dest}`);
    } catch (err) {
      ok = false;
      reportSkillCopyFailure(src, dest, err, io);
    }
  }
  return ok;
}

// A read-only skills directory means a container: agentbox and friends mount the
// HOST's ~/.claude/skills read-only, so nothing inside the box can write there —
// and "copy it manually" is advice the human cannot follow either (D25). Name the
// real fix instead: install from the host, which every box then inherits.
export function reportSkillCopyFailure(
  src: string,
  dest: string,
  err: unknown,
  io: CommandIo,
): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("EROFS")) {
    io.stderr(
      `board: ${dest} is on a read-only filesystem — you are running inside a container.\n` +
        `  Agent sandboxes mount the host's skills directory read-only, so no in-container\n` +
        `  install can write there, manually or otherwise.\n` +
        `  Fix: run \`make install\` on your HOST machine. Every container you start\n` +
        `  afterwards inherits the skill through that same mount.`,
    );
    return;
  }
  io.stderr(
    `board: could not copy ${src} to ${dest} (${message}); copy it there manually`,
  );
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
  // opencode v2's native key is `disabled`, not `enabled` (D24): an `enabled`
  // field is silently stripped on load, so writing it would be a no-op we'd
  // mistake for configuration.
  disabled: boolean;
  // MUST stay the {catalog, execution} object form. opencode v2 silently DROPS
  // the entire server entry when `timeout` is a scalar (measured against
  // v2.0.16, D24) — the board tools would vanish with no error. 60000 matches
  // the connector's PROXY_TIMEOUT_MS; opencode's own default (5s) is shorter
  // than a board_publish render.
  timeout: { catalog: number; execution: number };
  environment: { BOARD_MCP_TOKEN: string };
}

// Comment-preserving merge into opencode.jsonc: modify computes a surgical
// edit at ["mcp", "board"], so unrelated keys and comments survive verbatim.
export function mergeOpencodeConfig(
  text: string,
  entry: BoardMcpEntry,
): string {
  if (text.trim().length === 0) {
    return `${JSON.stringify({ mcp: { servers: { board: entry } } }, null, 2)}\n`;
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
  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    insertFinalNewline: true,
  };
  // D24: write opencode v2's native ["mcp","servers","board"], then drop any
  // legacy ["mcp","board"] we (or an older board) wrote. v2 merges both shapes
  // and the native one wins a name collision, so the legacy key is dead config
  // — harmless to opencode, actively confusing to whoever reads the file next.
  // Two sequential applyEdits passes, not one: jsonc-parser computes each edit
  // against the text it was given, so batching offsets from two `modify` calls
  // would corrupt the second.
  const withEntry = applyEdits(
    text,
    modify(text, ["mcp", "servers", "board"], entry, { formattingOptions }),
  );
  return applyEdits(
    withEntry,
    modify(withEntry, ["mcp", "board"], undefined, { formattingOptions }),
  );
}

function manualTokenNote(agent: Agent): string {
  return `BOARD_MCP_TOKEN=<board-${agent}-token> (replace with the token printed above)`;
}

// D24: opencode v2's own `mcp add` writes opencode.json, while board has always
// written opencode.jsonc. Both load and merge, so hardcoding .jsonc "works" —
// but it leaves the human owning two config files with no canonical one. Target
// the file that already exists; only a fresh install creates one, and .jsonc
// stays the default there because board writes comments into it.
export function opencodeConfigPath(dir: string): string {
  const jsonc = join(dir, "opencode.jsonc");
  const json = join(dir, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc;
}

function wireOpencode(token: string, io: CommandIo): boolean {
  const configPath = opencodeConfigPath(join(configHome(), "opencode"));
  const entry: BoardMcpEntry = {
    type: "local",
    command: [MCP_CONNECTOR_COMMAND, MCP_CONNECTOR_PATH],
    disabled: false,
    timeout: { catalog: 60000, execution: 60000 },
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
          `Or add this MCP entry under "mcp": { "servers": { … } } in opencode.jsonc on your host machine:\n` +
          `  "board": {\n` +
          `    "type": "local",\n` +
          `    "command": ["${MCP_CONNECTOR_COMMAND}", "${MCP_CONNECTOR_PATH}"],\n` +
          `    "disabled": false,\n` +
          `    "timeout": { "catalog": 60000, "execution": 60000 },\n` +
          `    "environment": { "BOARD_MCP_TOKEN": "<board-opencode-token>" }\n` +
          `  }`,
      );
      io.stderr(`  (${manualTokenNote("opencode")})`);
    } else {
      io.stderr(
        `board: could not merge the board MCP entry into ${configPath} (${err instanceof Error ? err.message : String(err)}); add it manually under "mcp": { "servers": { … } }:`,
      );
      io.stderr(`  "board": {`);
      io.stderr(`    "type": "local",`);
      io.stderr(
        `    "command": ["${MCP_CONNECTOR_COMMAND}", "${MCP_CONNECTOR_PATH}"],`,
      );
      io.stderr(`    "disabled": false,`);
      io.stderr(`    "timeout": { "catalog": 60000, "execution": 60000 },`);
      io.stderr(
        `    "environment": { "BOARD_MCP_TOKEN": "<board-opencode-token>" }`,
      );
      io.stderr(`  }`);
      io.stderr(`  (${manualTokenNote("opencode")})`);
    }
  }
  return ok;
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
    // Remove first, ALWAYS. `claude mcp add` on a name that already exists
    // prints "MCP server board already exists in user config" and exits 0 —
    // a silent no-op that we then reported as "wired" (measured against claude
    // 2.1.282). With --force that was actively harmful: the old token had just
    // been revoked, the new one never reached the config, and every board tool
    // call 401'd until someone hand-edited ~/.claude.json. `remove` on a name
    // that is not there is harmless, so this is unconditional.
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
      // Inside the try so a read-only config surfaces as the container case
      // rather than an unhandled throw.
      runClaude(["mcp", "remove", "--scope", "user", "board"]);
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
  return ok;
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
  return true;
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
        `already installed for ${agent} — skills refreshed above; the credential and MCP entry are unchanged. ` +
          `Re-mint both with: make install FLAGS=--force (or: bun run cli/src/main.ts install --force)`,
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
    // Skills are copied on EVERY run, for every agent, before anything else
    // (D26). Copying a file and rotating a credential are unrelated
    // operations, and this loop used to make the first hostage to the second:
    // mintToken returns null for an agent that already has a token, the loop
    // skipped to the next agent, and `make install` silently shipped no skill
    // update at all. Pulling a new skill version should not cost every agent
    // its credential and a session restart.
    let ok = copySkills(agentSkillsRoot(agent), io);
    const token = mintToken(db, agent, force, io);
    if (token !== null) {
      // Print-once discipline (invariant 8): the token is stored hashed, so
      // this is the only time the plaintext exists after the mint — if the
      // agent config is lost, the fix is a --force re-mint, not a re-show.
      io.stdout(
        `token for "${token.name}" (store it now — it is stored hashed and cannot be shown again):`,
      );
      io.stdout(token.token);
      ok = wireAgent(agent, token.token, io, claudeOnPath, runClaude) && ok;
    } else {
      // Nothing minted, so this agent already has a live credential. Rewrite
      // its MCP entry around the token already in its config (D28) — that is
      // how a shape change like D24 reaches an existing install without
      // rotating anything. Never printed: it is the same secret, already at
      // rest where we found it.
      const wired = readWiredToken(agent);
      if (wired !== null) {
        ok = wireAgent(agent, wired, io, claudeOnPath, runClaude) && ok;
        io.stdout(
          `re-wired ${agent} with its existing credential — not rotated, no session restart needed`,
        );
      } else if (agent === "opencode" || agent === "claude") {
        io.stdout(
          `no board credential found in ${agent}'s config — re-mint with: make install FLAGS=--force`,
        );
      }
    }
    if (!ok) {
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
