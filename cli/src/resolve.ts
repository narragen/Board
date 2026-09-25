// Instance-aware target resolution (D20 wave 2): ONE precedence rule for every
// command that can address a session instance instead of the shared daemon.
//
//   selection    --instance <id> flag > BOARD_INSTANCE env > none
//   REST target  the registry entry's url
//   credential   --token flag > BOARD_TOKEN env > the instance env file
//   local-db     the entry's dataDir (REPLACES the ambient BOARD_DATA_DIR)
//
// `none` is the pre-wave-2 shared-daemon behavior, byte-for-byte. This module
// is pure lookup — argv parsing and printed UX stay in commands/ — and errors
// come back as message strings (the parseArgs house style), exit 1 at the
// call site.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../server/src/config.ts";
import { originUrlFor } from "../../server/src/daemon.ts";
import {
  type InstanceEntry,
  type InstancePaths,
  instancePaths,
  instancesRoot,
  listRegistryEntries,
  pidIdentity,
  plausibleId,
  readEnvToken,
  readInstanceEntry,
} from "./instances.ts";

export interface Selection {
  entry: InstanceEntry;
  paths: InstancePaths;
}

export interface RestTarget {
  baseUrl: string;
  token: string;
}

const NO_TOKEN =
  "no token: pass --token <token> or set BOARD_TOKEN (mint one with: make token add cli)";

// The instance flavour of NO_TOKEN: same precedence, one more fallback to
// name (the 0600 env file `up` wrote). Both REST paths below hand it back.
function noInstanceToken(sel: Selection): string {
  return `no token: pass --token <token>, set BOARD_TOKEN, or source the instance env file (${sel.paths.env})`;
}

function envToken(): string | undefined {
  const raw = process.env.BOARD_TOKEN;
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}

function envInstance(): string | undefined {
  const raw = process.env.BOARD_INSTANCE;
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}

// Selection precedence (D20 wave 2): --instance flag > BOARD_INSTANCE env >
// none. An unknown id errors with the LIVE ids listed so a stale id is
// self-correcting in one glance.
function selectInstance(
  config: Config,
  flag?: string,
): Selection | null | string {
  const id = flag ?? envInstance();
  if (id === undefined || id.length === 0) {
    return null;
  }
  // F1 guard 2 (audit): only ids `up` could have minted become paths — a
  // `../`-style id must never address files outside the registry.
  if (!plausibleId(id)) {
    return `invalid instance id "${id}" — ids look like s-<10 alphanumerics> (minted by board up)`;
  }
  const paths = instancePaths(config.dataDir, id);
  const entry = readInstanceEntry(paths);
  if (entry === null) {
    const live: string[] = [];
    for (const { entry: e } of listRegistryEntries(config.dataDir)) {
      if (
        e !== null &&
        e.closedAt === undefined &&
        pidIdentity(e.pid, e.dataDir) === "ours"
      ) {
        live.push(e.id);
      }
    }
    return (
      `unknown instance "${id}"` +
      (live.length > 0
        ? ` — live instances: ${live.join(", ")}`
        : ` — no live instances in ${instancesRoot(config.dataDir)} (start one with: board up [file])`)
    );
  }
  return { entry, paths };
}

// Liveness is DERIVED (D20): the closedAt stamp, then pid identity at read
// time — never a stored flag.
type InstanceState = "live" | "closed" | "stale" | "foreign";

function instanceState(sel: Selection): InstanceState {
  if (sel.entry.closedAt !== undefined) {
    return "closed";
  }
  const identity = pidIdentity(sel.entry.pid, sel.entry.dataDir);
  return identity === "ours"
    ? "live"
    : identity === "gone"
      ? "stale"
      : "foreign";
}

function stateText(sel: Selection, state: InstanceState): string {
  switch (state) {
    case "closed":
      return `closed at ${sel.entry.closedAt}`;
    case "stale":
      return `daemon pid ${sel.entry.pid} is gone`;
    case "foreign":
      return `pid ${sel.entry.pid} is alive but is not this daemon (pid-reuse defense, D20)`;
    case "live":
      return "live";
  }
}

// A foreign pid is refused EVERYWHERE, without a workaround hint: the port may
// be owned by a non-board process, and sending the instance's credentials
// there would leak them (credential-leak defense, not just correctness).
function foreignRefusal(sel: Selection): string {
  return `instance "${sel.entry.id}": ${stateText(sel, "foreign")} — refusing to send credentials to it; inspect \`board instances --all\` or the registry at ${sel.paths.dir}`;
}

// F3 (audit): a booting entry has no url yet — its `up` died mid-boot (or is
// mid-boot in another shell). There is nothing to target; `down` is the
// remediation that manages (signals/purges) it.
function bootingRefusal(sel: Selection): string {
  return `instance "${sel.entry.id}" never finished booting (no url — its up was killed mid-boot?) — tear it down with: board down ${sel.entry.id}`;
}

// N3 (audit): url and pid are independently tamperable in the registry — a
// non-loopback entry url would send the env-file bearer to a remote machine.
// Instance paths only ever speak loopback; refused without a workaround hint
// (credential-leak defense). An explicit --token to the SHARED daemon (its
// url comes from the local config, not the registry) stays the user's call.
//
// Do NOT unify with mcp-connector.ts isLoopbackHttpUrl: that one is strictly
// stricter (it also rejects userinfo, query strings and sub-paths — audits
// 2026-09-22/09-23, where a connector-pinned url is user input). This one vets
// a url the CLI itself wrote into the registry, and it could not import that
// file anyway (the connector must stay outside the Bun graph).
function isLoopbackUrl(url: string): boolean {
  try {
    // IPv6 hosts come back bracketed ("[::1]")
    const host = new URL(url).hostname.replace(/^\[/, "").replace(/\]$/, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function loopbackRefusal(sel: Selection): string {
  return `instance "${sel.entry.id}": entry url "${sel.entry.url}" is not loopback — refusing to send credentials to it; inspect \`board instances --all\` or the registry at ${sel.paths.dir}`;
}

// The keepsake hint rides every closed-instance REST error: the disk bundles
// still work without a daemon — that is the whole point of down's zips.
function notServing(sel: Selection, state: InstanceState): string {
  return `instance "${sel.entry.id}" is not serving REST (${stateText(sel, state)}) — "board export --instance ${sel.entry.id} <board_id>" still works on a closed instance (zips from disk)`;
}

function instanceToken(sel: Selection, flag?: string): string | undefined {
  // Credential precedence (D20 wave 2): --token flag > BOARD_TOKEN env > the
  // instance env file — the env file is the fallback, never the override.
  return flag ?? envToken() ?? readEnvToken(sel.paths) ?? undefined;
}

// REST commands (list/status/import): the shared daemon when no instance is
// selected — token from --token or BOARD_TOKEN, exactly as before this wave.
export function restTarget(
  config: Config,
  parsed: { token?: string; instance?: string },
): RestTarget | string {
  const sel = selectInstance(config, parsed.instance);
  if (typeof sel === "string") {
    return sel;
  }
  if (sel === null) {
    const token = parsed.token ?? envToken();
    if (token === undefined) {
      return NO_TOKEN;
    }
    return { baseUrl: originUrlFor(config.host, config.port), token };
  }
  // F3 (audit): the url is the first fact settled — an entry without one
  // never finished booting. An OPEN no-url entry is refused outright (its up
  // died mid-boot, or is mid-boot in another shell — nothing to target in
  // any state); a CLOSED one was down'ed mid-boot and gets the ordinary
  // not-serving answer, keepsake hint included.
  const url = sel.entry.url;
  if (url === undefined) {
    if (sel.entry.closedAt !== undefined) {
      return notServing(sel, "closed");
    }
    return bootingRefusal(sel);
  }
  const state = instanceState(sel);
  if (state === "foreign") {
    return foreignRefusal(sel);
  }
  if (state !== "live") {
    return notServing(sel, state);
  }
  const token = instanceToken(sel, parsed.token);
  if (token === undefined) {
    return noInstanceToken(sel);
  }
  if (!isLoopbackUrl(url)) {
    return loopbackRefusal(sel);
  }
  return { baseUrl: url, token };
}

export type ExportTarget =
  | ({ mode: "rest" } & RestTarget)
  | { mode: "disk"; selection: Selection };

// export is the ONE command with two dead-instance behaviors (D20 wave 2):
// a closed/stale instance still exports — zipped straight from the on-disk
// bundle (the keepsake path, no daemon needed) — while a live instance takes
// the normal REST route.
export function exportTarget(
  config: Config,
  parsed: { token?: string; instance?: string },
): ExportTarget | string {
  const sel = selectInstance(config, parsed.instance);
  if (typeof sel === "string") {
    return sel;
  }
  if (sel === null) {
    const token = parsed.token ?? envToken();
    if (token === undefined) {
      return NO_TOKEN;
    }
    return {
      mode: "rest",
      baseUrl: originUrlFor(config.host, config.port),
      token,
    };
  }
  // F3 (audit): the url is settled first — an OPEN no-url entry never
  // finished booting and is refused (its db may be mid-migration; `board
  // down <id>` is the cleanup); a CLOSED one was down'ed mid-boot and the
  // disk keepsake path is exactly what export exists for.
  const url = sel.entry.url;
  if (url === undefined) {
    if (sel.entry.closedAt === undefined) {
      return bootingRefusal(sel);
    }
    return { mode: "disk", selection: sel };
  }
  const state = instanceState(sel);
  if (state === "live") {
    const token = instanceToken(sel, parsed.token);
    if (token === undefined) {
      return noInstanceToken(sel);
    }
    if (!isLoopbackUrl(url)) {
      return loopbackRefusal(sel);
    }
    return { mode: "rest", baseUrl: url, token };
  }
  if (state === "foreign") {
    return foreignRefusal(sel);
  }
  return { mode: "disk", selection: sel };
}

export interface OpenTarget {
  baseUrl: string;
  dataDir: string;
}

// open's dead-instance answer: nothing is serving, so there is no keepsake
// consolation to offer (unlike notServing above) — just the state and why it
// matters for this command.
function notRunning(sel: Selection, state: InstanceState): string {
  return `instance "${sel.entry.id}" is not running (${stateText(sel, state)}) — nothing serves the human link`;
}

// open needs a LIVE daemon — the human link is served by it — and mints the
// exchange token on the target db (the sanctioned local-db exception: no API
// route mints exchange tokens by design, docs/api.md).
export function openTarget(
  config: Config,
  instanceFlag?: string,
): OpenTarget | string {
  const sel = selectInstance(config, instanceFlag);
  if (typeof sel === "string") {
    return sel;
  }
  if (sel === null) {
    return {
      baseUrl: originUrlFor(config.host, config.port),
      dataDir: config.dataDir,
    };
  }
  // F3 (audit): the url is settled first — an OPEN no-url entry never
  // finished booting (nothing serves the link); a CLOSED one gets the
  // ordinary not-running answer.
  const url = sel.entry.url;
  if (url === undefined) {
    if (sel.entry.closedAt !== undefined) {
      return notRunning(sel, "closed");
    }
    return bootingRefusal(sel);
  }
  const state = instanceState(sel);
  if (state === "foreign") {
    return foreignRefusal(sel);
  }
  if (state !== "live") {
    return notRunning(sel, state);
  }
  return { baseUrl: url, dataDir: sel.entry.dataDir };
}

// token add|list|revoke need only the instance's db FILE — a closed instance
// with --keep-data still works; a purged one (down without --keep-data) has
// no db left, and openDb would silently create a fresh empty one (the
// existsSync check is the difference between an error and a lie).
export function dbTarget(
  config: Config,
  instanceFlag?: string,
): { dataDir: string } | string {
  const sel = selectInstance(config, instanceFlag);
  if (typeof sel === "string") {
    return sel;
  }
  if (sel === null) {
    return { dataDir: config.dataDir };
  }
  if (!existsSync(join(sel.entry.dataDir, "board.db"))) {
    return `instance "${sel.entry.id}"'s data dir is gone (${sel.entry.dataDir} was purged at teardown) — token rows live in the instance db`;
  }
  return { dataDir: sel.entry.dataDir };
}
