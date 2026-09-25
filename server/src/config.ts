import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  bind: string[];
}

type Env = Record<string, string | undefined>;

const DEFAULT_DATA_DIR = "~/.board";
// Loopback-only bind is invariant 1 (docs/security.md); BOARD_HOST/BOARD_BIND are the explicit, documented opt-outs.
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7800;
const DEFAULT_BIND = ["127.0.0.1"];
const MAX_PORT = 65535;
// why whitespace + slash: a hostname with "/" could traverse paths when the
// origin URL is built from it, whitespace could smuggle header structure
// (injection) — a hostname is one flat token, nothing else survives.
const HOSTNAME_FORBIDDEN = /[\s/]/;

function readString(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new ConfigError(`${name} must not be empty`);
  }
  return value;
}

function parsePort(env: Env, name: string, fallback: number): number {
  const raw = readString(env, name, String(fallback));
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) > MAX_PORT) {
    throw new ConfigError(
      `${name} must be an integer between 0 and ${MAX_PORT}, got "${raw}"`,
    );
  }
  return Number.parseInt(raw, 10);
}

function parseHostname(env: Env, name: string, fallback: string): string {
  const value = readString(env, name, fallback).toLowerCase();
  if (HOSTNAME_FORBIDDEN.test(value)) {
    throw new ConfigError(
      `${name} must be a hostname or IP address, got "${value}"`,
    );
  }
  return value;
}

function parseBindList(env: Env): string[] {
  const raw = env.BOARD_BIND;
  if (raw === undefined || raw.trim().length === 0) {
    return [...DEFAULT_BIND];
  }
  const entries: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (entry.length === 0) {
      throw new ConfigError(
        `BOARD_BIND must be comma-separated hostnames, found an empty entry in "${raw}"`,
      );
    }
    if (HOSTNAME_FORBIDDEN.test(entry)) {
      throw new ConfigError(
        `BOARD_BIND entries must be hostname or IP addresses, got "${entry}"`,
      );
    }
    if (!entries.includes(entry)) {
      entries.push(entry);
    }
  }
  return entries;
}

function expandDataDir(raw: string): string {
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  return isAbsolute(raw) ? raw : resolve(raw);
}

export function makeConfig(env: Env): Config {
  const port = parsePort(env, "BOARD_PORT", DEFAULT_PORT);
  return {
    dataDir: expandDataDir(readString(env, "BOARD_DATA_DIR", DEFAULT_DATA_DIR)),
    host: parseHostname(env, "BOARD_HOST", DEFAULT_HOST),
    port,
    bind: parseBindList(env),
  };
}

export function loadConfig(): Config {
  return makeConfig(process.env);
}

// D23 D3 ratified a persistent mount for the agent box's data dir
// (BOARD_DATA_DIR=/home/node/board), and nothing ever enforced it. A box that
// skips the mount runs perfectly on the container's own writable layer and
// loses every board the moment the box is re-created — which is not
// hypothetical: a data dir vanished mid-week during dogfooding, and that reset
// is part of what D23 was written to answer.
//
// A warning, not a refusal. The daemon is fully functional; the exposure is
// future data loss, and refusing to start would break every box running today
// for a risk that has not materialised yet. Loud at startup is proportionate.
//
// Pure, so all three conditions are testable without a container:
//   1. in a container at all — otherwise none of this applies and we say
//      nothing on a normal host,
//   2. not under the system temp dir — a data dir there is ephemeral by
//      design (every test and `make smoke` uses one), so the warning would be
//      true and useless,
//   3. same device as `/` — a volume or bind mount lands on a different
//      device, so this is what distinguishes "on a mount that survives" from
//      "on the container's root filesystem". It is the check that makes the
//      warning a measurement rather than a guess.
// An unknown device (null) means we could not tell, so we stay quiet.
export function ephemeralDataDirWarning(facts: {
  dataDir: string;
  inContainer: boolean;
  dataDirDevice: number | null;
  rootDevice: number | null;
  tmpDir: string;
}): string | null {
  const { dataDir, inContainer, dataDirDevice, rootDevice, tmpDir } = facts;
  if (!inContainer) {
    return null;
  }
  if (dataDir === tmpDir || dataDir.startsWith(`${tmpDir}${sep}`)) {
    return null;
  }
  if (dataDirDevice === null || rootDevice === null) {
    return null;
  }
  if (dataDirDevice !== rootDevice) {
    return null;
  }
  return (
    `board: warning: the data dir (${dataDir}) is on this container's own writable layer, ` +
    "not a mount — every board, comment and event in it disappears when the container is re-created.\n" +
    "  Fix (D23 D3, docs/deployment.md): mount a volume and point the daemon at it —\n" +
    "  BOARD_DATA_DIR=/home/node/board, with /home/node/board on a persistent mount."
  );
}

// The data dir does not exist yet on a first run, so fall back to its parent:
// the question is which filesystem the path lands on, and the parent answers
// it just as well.
function deviceOf(path: string): number | null {
  for (const candidate of [path, dirname(path)]) {
    try {
      return statSync(candidate).dev;
    } catch {
      // try the parent, then give up — an unknown device warns about nothing
    }
  }
  return null;
}

export function describeEphemeralDataDir(dataDir: string): string | null {
  return ephemeralDataDirWarning({
    dataDir,
    // both standard markers: docker writes /.dockerenv, podman writes
    // /run/.containerenv. Missing both is the honest "not in a container".
    inContainer: existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
    dataDirDevice: deviceOf(dataDir),
    rootDevice: deviceOf("/"),
    tmpDir: tmpdir(),
  });
}
