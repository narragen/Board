// Single source of truth for the session-instance registry's FILE FORMATS
// (D20): the instance.json field shape and the 0600 env file's `export K=V`
// lines. Two consumers parse these files — cli/src/instances.ts (the
// bun-run `up/down/instances` lifecycle) and cli/src/mcp-connector.ts (the
// stdio MCP connector, which opencode spawns as `node …/mcp-connector.ts`
// with no bun on its PATH) — so the parsers live here, importable by node:
// pure string/JSON in, typed values out, no Bun APIs, no fs access.
// Filesystem reading stays with each consumer (the connector reads and never
// writes — invariant 3, writes go through the daemon).

/** The instance.json registry entry (D20) — written by `board up`, stamped by
 * `down`/prune. Never contains tokens: credentials live only in the sibling
 * `env` file (mode 0600). */
export interface InstanceEntry {
  id: string;
  pid: number;
  // port/url are absent on the pre-readiness (booting) entry written by the
  // F3 boot-window guard — they exist only once the daemon is confirmed ready
  port?: number;
  url?: string;
  dataDir: string;
  agentTokenName: string;
  createdAt: string;
  closedAt?: string;
  // board ids kept as zips under <registry>/boards/ — stamped at teardown
  boards?: string[];
  // set ONLY on the minimal entry written before readiness completes (F3);
  // the full entry overwrites it atomically on success
  booting?: true;
}

/** Parsed `<instances>/<id>/env` contents: the `export BOARD_*` lines the
 * D20 credential file carries (the one sanctioned plaintext-at-rest
 * exception — never logged, purged by `down`/prune). */
export interface InstanceEnv {
  instance?: string;
  port?: number;
  token?: string;
}

/**
 * Parse instance.json contents. Returns null on unreadable/torn JSON —
 * callers treat that as a corrupt entry (reported, never acted on).
 */
export function parseInstanceJson(text: string): InstanceEntry | null {
  try {
    return JSON.parse(text) as InstanceEntry;
  } catch {
    return null;
  }
}

/**
 * Parse the env file's `export K=V` lines into typed fields. Mirrors the
 * writer's line discipline exactly (writeEnvFile: one space after `export`,
 * value is a single \S+ token, `#` comment lines carry no anchor) — a value
 * with whitespace or a missing value is not a line this file format can
 * express, so it is ignored rather than guessed at.
 */
export function parseInstanceEnv(text: string): InstanceEnv {
  const env: InstanceEnv = {};
  for (const match of text.matchAll(
    /^export ([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/gm,
  )) {
    const key = match[1];
    const value = match[2];
    switch (key) {
      case "BOARD_INSTANCE":
        env.instance = value;
        break;
      case "BOARD_PORT":
        if (/^\d+$/.test(value)) {
          env.port = Number.parseInt(value, 10);
        }
        break;
      case "BOARD_TOKEN":
        env.token = value;
        break;
    }
  }
  return env;
}
