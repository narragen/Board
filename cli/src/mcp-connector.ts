// Agent-side stdio MCP connector (wave 1): the local MCP server agent
// harnesses (opencode) spawn — always connects, tools always listed — and
// which resolves a REAL backend per request: an explicit target when one is
// set (the BOARD_INSTANCE env or a board_connect pin, D23 D4), else the
// shared daemon when healthy (with its token), else the newest healthy
// session instance (D20), else an honest offline answer. The user's opencode
// has no bun on PATH, so the
// wiring runs this file as `node cli/src/mcp-connector.ts` under node ≥24
// type-stripping — the whole import graph must stay Bun-free and
// erasable-syntax-only (no enums, namespaces, or parameter properties; no
// bun: sqlite/Bun APIs; the SDK is not resolvable from cli/ under node).
//
// Wire protocol: newline-delimited JSON-RPC on stdin/stdout. stdout is
// protocol ONLY; stderr carries rare diagnostics and never tokens
// (invariant 7). The connector never writes to disk (invariant 3). Loopback
// discipline (invariant 1) holds in three different ways: registry-derived
// (instance) URLs are enforced structurally — only a literal
// http://127.0.0.1:<port> is ever fetched; a board_connect {url, token} pin
// is refused unless it is a loopback http URL; and the shared-daemon URL is
// built from the BOARD_* environment and trusted as explicit configuration
// (invariant 1's carve-out: the documented Docker opt-out in
// docs/deployment.md).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeConfig } from "../../server/src/config.ts";
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  offlineToolList,
} from "../../server/src/mcp-tools.ts";
import { parseInstanceEnv, parseInstanceJson } from "./instance-registry.ts";

// The SDK 1.30 LATEST_PROTOCOL_VERSION. Hardcoded because the SDK package is
// not node-resolvable from cli/src; it only matters for clients that omit
// protocolVersion in initialize (opencode always sends one, which we echo).
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const HEALTH_TIMEOUT_MS = 1_000;
const PROXY_TIMEOUT_MS = 60_000;

// The structural guard for registry urls (M8 audit lesson: a crafted entry
// can falsify identity, not filesystem shape). Only a LITERAL loopback http
// URL is ever fetched — localhost aliases, other hosts, other schemes, and
// malformed strings are skipped without a single request.
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d+$/;

const NO_BACKEND_GUIDANCE =
  "no board server is running. Start one: run `make up` (or `board up`) " +
  "for a task-scoped session board you own, or ask the human to start the " +
  "shared library (`make serve`). Discover what IS up with board_servers, " +
  "or pin an explicit target with board_connect. The connector re-resolves " +
  "on every call — retry after starting one.";

export interface ConnectorContext {
  // The shared daemon's config-derived URL (http://<host>:<port>); null when
  // the BOARD_* environment is invalid.
  sharedUrl: string | null;
  // Shared-library credential from BOARD_MCP_TOKEN (what `make install`
  // wires into agent configs) — never logged, only forwarded as a bearer.
  sharedToken: string | null;
  // <dataDir>/instances — the D20 registry to scan for session daemons.
  instancesDir: string | null;
  // D23 D4 — the scripted path: when BOARD_INSTANCE is set, resolution
  // targets that instance STRICTLY (dead/missing = honest error, never a
  // silent fallthrough — a script's boards must not silently land elsewhere).
  // The env is static for the process's lifetime, so the id parses once;
  // the instance's health is probed per request. Same variable the CLI
  // honors (cli/src/resolve.ts).
  envInstanceId: string | null;
  // D23 D4 — the explicit-connect pin: set by board_connect, cleared by
  // {reset: true}. This context object is created once per connector
  // process, so it IS the process-scoped state the pin calls for; it is
  // in-memory only (never persisted, never logged — invariant 7). A pin
  // amends D22's stateless per-request auto-resolution (explicit beats
  // auto) but not the strict BOARD_INSTANCE env, which stays first.
  pin: Backend | null;
  // Diagnostic channel for per-request backend lines (stderr in the real
  // process, a collector in tests) — the same channel as the invalid-env
  // diagnostic below.
  diagnose: (message: string) => void;
}

// Resolution provenance, carried end to end: the per-request stderr
// diagnostic labels the backend `(shared)` / `(instance <id>)` / `(connected)`
// — marking a pinned target with ", connected" — and a shared-backend 401
// appends the re-mint hint; a direct-pin 401 names the manager instead. An
// instance token is ephemeral and re-resolved per request, so it gets neither.
// The "direct" kind is a board_connect {url, token} pin — the manager-minted
// flow (D23 D4): neither config-derived like "shared" nor in the registry
// like "instance".
export type Backend =
  | { kind: "shared"; url: string; token: string | null }
  | { kind: "instance"; id: string; url: string; token: string | null }
  | { kind: "direct"; url: string; token: string | null };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Environment → connector context. The env is static for the process's
// lifetime, so this parses ONCE; the BACKENDS it points at are re-resolved
// per request (health changes, instances come and go).
export function connectorContext(
  env: Record<string, string | undefined>,
  diagnose: (message: string) => void,
): ConnectorContext {
  try {
    const config = makeConfig(env);
    // Empty string counts as absent: {env:VAR} interpolation in opencode
    // configs yields "" when the variable is unset, and an empty credential
    // must not pin routing to the shared daemon (it would 401 there instead
    // of falling through to the session instances).
    const sharedToken = env.BOARD_MCP_TOKEN;
    // D23 D4: BOARD_INSTANCE — the scripted target. Same trim/empty rule as
    // BOARD_MCP_TOKEN below: {env:VAR} interpolation in agent configs yields
    // "" when unset, and an empty id must not turn resolution strict.
    const rawInstance = env.BOARD_INSTANCE;
    return {
      sharedUrl: `http://${config.host}:${config.port}`,
      sharedToken:
        sharedToken !== undefined && sharedToken.trim().length > 0
          ? sharedToken
          : null,
      instancesDir: join(config.dataDir, "instances"),
      envInstanceId:
        rawInstance !== undefined && rawInstance.trim().length > 0
          ? rawInstance.trim()
          : null,
      pin: null,
      diagnose,
    };
  } catch (err) {
    // Invalid BOARD_* env must never crash the client's spawn: one stderr
    // diagnostic, then the connector serves the offline manifest.
    diagnose(
      `board mcp: ignoring invalid BOARD_* environment (${errText(err)})`,
    );
    return {
      sharedUrl: null,
      sharedToken: null,
      instancesDir: null,
      envInstanceId: null,
      pin: null,
      diagnose,
    };
  }
}

// Registry scan → candidate backends, newest-first by the entry's own
// createdAt (the field `board up` stamps). Sync, cheap, re-run per request.
// Everything here is an instance backend by construction — the shared daemon
// never comes from the registry. Returns the candidate shape (a structural
// subtype of Backend) so the id-addressed consumers (the strict
// BOARD_INSTANCE lookup, board_connect {instance_id}, board_servers) can
// read the id without narrowing.
interface InstanceCandidate {
  kind: "instance";
  id: string;
  url: string;
  token: string | null;
  createdAtMs: number;
}

function instanceCandidates(instancesDir: string | null): InstanceCandidate[] {
  if (instancesDir === null) {
    return [];
  }
  let ids: string[];
  try {
    ids = readdirSync(instancesDir);
  } catch {
    return []; // no registry yet — no instances
  }
  const candidates: InstanceCandidate[] = [];
  for (const id of ids) {
    let entry: ReturnType<typeof parseInstanceJson>;
    try {
      entry = parseInstanceJson(
        readFileSync(join(instancesDir, id, "instance.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (entry === null) {
      continue; // unreadable/torn entry — corrupt, never fetched
    }
    if (entry.closedAt !== undefined) {
      continue; // torn down: env purged, daemon dead by construction
    }
    if (typeof entry.url !== "string" || !LOOPBACK_URL.test(entry.url)) {
      continue; // structural guard: skip without fetching
    }
    let token: string | null = null;
    try {
      token =
        parseInstanceEnv(readFileSync(join(instancesDir, id, "env"), "utf8"))
          .token ?? null;
    } catch {
      token = null; // env file unreadable → no credential; health still checked
    }
    const createdAtMs = Date.parse(entry.createdAt);
    candidates.push({
      kind: "instance",
      id,
      url: entry.url,
      token,
      createdAtMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs,
    });
  }
  return candidates.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      // Audit 2026-09-22: fetch follows redirects by default — a loopback
      // server that 30x-redirects outward would make the connector fetch a
      // non-loopback host (invariant 1 broken via redirect). Every connector
      // fetch refuses redirects; all targets are loopback by construction.
      redirect: "error",
    });
    return res.ok;
  } catch {
    return false; // not listening / timed out
  }
}

// D23 D4: the structural guard for a board_connect {url, token} target — only
// loopback is ever pinned or fetched (invariant 1), fail-closed like the
// registry guard above. For explicit configuration it accepts the loopback
// hostname forms the CLI's own resolution accepts (cli/src/resolve.ts
// isLoopbackUrl: 127.0.0.1, localhost, ::1); other hosts, other schemes, and
// malformed strings are refused without a single request.
function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    // Userinfo and query are refused (audit 2026-09-22): a URL like
    // http://x:secret@127.0.0.1:7800 is loopback-hosted, but its credential
    // component would ride into error text on a failed fetch (invariant 7) —
    // the token belongs in board_connect's token param, never the URL.
    return (
      parsed.protocol === "http:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      (host === "127.0.0.1" || host === "localhost" || host === "::1")
    );
  } catch {
    return false;
  }
}

// Same id-shape discipline as cli/src/instances.ts plausibleId (F1 guard 2):
// a user-supplied id becomes a registry path, so only ids `board up` could
// have minted are ever looked up. The regex is duplicated rather than
// imported because instances.ts is Bun-graph (bun:sqlite) and this file must
// stay node-runnable.
function plausibleInstanceId(id: string): boolean {
  return /^s-[0-9A-Za-z]{10}$/.test(id);
}

// Resolution order (D23 D4, amending D22) — per request, never cached:
//   1. BOARD_INSTANCE env → that instance, STRICT: dead/missing returns an
//      honest error string, never a silent fallthrough (the scripted path
//      must fail loudly or it lies about where boards land);
//   2. the explicit board_connect pin → the connected target (also strict:
//      a pinned target that dies fails the call rather than rerouting);
//   3. shared daemon healthy + BOARD_MCP_TOKEN → shared wins (the
//      persistent library, D21);
//   4. else session instances, newest-first, first healthy wins (we hold the
//      instance env file's credential) — the unchanged zero-config
//      single-agent default (D22);
//   5. shared healthy but NO token env → route to shared anyway so its 401
//      surfaces the misconfiguration honestly, unless an instance can serve.
// A returned string is the strict path's honest error (the CLI's
// message-string error convention); null means nothing is up.
async function resolveBackend(
  ctx: ConnectorContext,
): Promise<Backend | string | null> {
  if (ctx.envInstanceId !== null) {
    const wanted = ctx.envInstanceId;
    const candidate = instanceCandidates(ctx.instancesDir).find(
      (c) => c.id === wanted,
    );
    if (candidate === undefined) {
      return (
        `BOARD_INSTANCE=${wanted} is set, but no such open instance exists in ` +
        "the registry — it is dead, torn down, or misnamed (inspect: board " +
        "instances --all). Resolution will not fall through while " +
        "BOARD_INSTANCE is set."
      );
    }
    if (!(await isHealthy(candidate.url))) {
      return (
        `BOARD_INSTANCE=${wanted} is set, but its daemon at ${candidate.url} ` +
        "is not healthy. Restart it (board down, then board up) or unset " +
        "BOARD_INSTANCE; resolution will not fall through."
      );
    }
    return candidate;
  }
  if (ctx.pin !== null) {
    return ctx.pin;
  }
  const sharedHealthy =
    ctx.sharedUrl !== null && (await isHealthy(ctx.sharedUrl));
  if (sharedHealthy && ctx.sharedToken !== null && ctx.sharedUrl !== null) {
    return { kind: "shared", url: ctx.sharedUrl, token: ctx.sharedToken };
  }
  for (const candidate of instanceCandidates(ctx.instancesDir)) {
    if (await isHealthy(candidate.url)) {
      return candidate;
    }
  }
  if (sharedHealthy && ctx.sharedUrl !== null) {
    return { kind: "shared", url: ctx.sharedUrl, token: null };
  }
  return null;
}

function errorResponse(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Stateless JSON mode (D16) on the backend: one POST = one complete
// JSON-RPC response, relayed verbatim. Never throws.
async function proxyToBackend(
  backend: Backend,
  message: Record<string, unknown>,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${backend.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The Streamable HTTP transport requires both accept types on POST;
        // the stateless JSON endpoint (D16) still answers application/json.
        accept: "application/json, text/event-stream",
        ...(backend.token !== null
          ? { authorization: `Bearer ${backend.token}` }
          : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      redirect: "error", // invariant 1 — see isHealthy
    });
  } catch (err) {
    return JSON.stringify(
      errorResponse(
        message.id ?? null,
        -32603,
        `board server at ${backend.url} is unreachable: ${errText(err)}`,
      ),
    );
  }
  const body = await res.text();
  if (!res.ok) {
    // The daemon's HTTP-level rejections (401/405/413…) carry its own
    // {error:{code,message}} envelope, not a JSON-RPC response — relaying
    // those verbatim would hand the client a non-protocol object, so the
    // failure surfaces as a JSON-RPC error naming the status instead. A
    // shared-backend 401 is the revoked/unwired-credential case, so the
    // relay appends the re-mint fix; a direct pin's 401 names the manager
    // instead (D23 D4 — the token was handed over, not wired). Other
    // statuses (405/413 — not credential problems) and instance backends
    // (ephemeral credentials, re-resolved per request) get no hint.
    const reMintHint =
      res.status === 401 && backend.kind === "shared"
        ? " — the shared-library credential is missing or rejected; " +
          "re-mint + rewire with: make install FLAGS=--force"
        : res.status === 401 && backend.kind === "direct"
          ? " — the pinned credential was rejected; ask the board's " +
            "manager for a fresh token, then board_connect again"
          : "";
    return JSON.stringify(
      errorResponse(
        message.id ?? null,
        -32603,
        `board server at ${backend.url} returned HTTP ${res.status}${reMintHint}`,
      ),
    );
  }
  return body;
}

// --- Connector-local tools (D23 D4) -----------------------------------------
// board_servers and board_connect are handled HERE, in the connector process,
// never proxied: discovery must work when nothing is up, and the connect pin
// is this process's state. Results use the daemon's tool-result envelope
// ({content:[{type:"text", text:<JSON>}]}), errors the isError variant — so
// an agent reads local and proxied tools identically. No result ever carries
// token material (invariant 7).

function localToolPayload(id: unknown, payload: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });
}

function localToolError(id: unknown, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: message }], isError: true },
  });
}

// The per-board shape discovery/connect report (the daemon's
// BoardWithCommentCounts, narrowed to what an agent needs to pick a board).
interface BoardSummary {
  id: string;
  title: string;
  status: string;
  current_version: number;
  unresolved_comments: number;
}

function summarizeBoard(value: unknown): BoardSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, title, status, current_version, unresolved_comments } = value;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof status !== "string" ||
    typeof current_version !== "number" ||
    typeof unresolved_comments !== "number"
  ) {
    return null;
  }
  return { id, title, status, current_version, unresolved_comments };
}

// Authenticated boards listing against a backend's REST surface — doubles as
// board_connect's token verification (a boards list proves the credential
// actually authenticates, not just that the server is up). Returns the
// summaries or an honest one-line failure reason; the failure text carries
// the url and status only, never the credential (invariant 7).
async function listBoards(
  url: string,
  token: string | null,
): Promise<{ boards: BoardSummary[] } | string> {
  if (token === null) {
    return "no credential available";
  }
  try {
    const res = await fetch(`${url}/api/boards`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      redirect: "error", // invariant 1 — see isHealthy
    });
    if (res.status === 401) {
      return `the credential was rejected (HTTP 401) at ${url}`;
    }
    if (!res.ok) {
      return `boards listing at ${url} returned HTTP ${res.status}`;
    }
    const value: unknown = await res.json();
    if (!Array.isArray(value)) {
      return `boards listing at ${url} returned an unexpected shape`;
    }
    return {
      boards: value
        .map(summarizeBoard)
        .filter((board): board is BoardSummary => board !== null),
    };
  } catch (err) {
    return `board server at ${url} is unreachable: ${errText(err)}`;
  }
}

// One entry per local server in the board_servers report. `hint` explains a
// missing boards list (down, or no credential) or how to start the server;
// `boards` is present only when the server is up AND a credential listed.
interface ServerReport {
  kind: "shared" | "instance";
  id?: string; // instances only
  url?: string; // absent when the shared url could not be derived at all
  status: "up" | "down";
  credential: boolean;
  boards?: BoardSummary[];
  hint?: string;
}

// board_servers — enumerate the shared daemon + every open registry instance,
// probe liveness, and list boards where a credential lets us. Enumerating
// costs a few local probes; there is no backend dependency, so this works
// with nothing up (the D23 D4 discovery mandate).
async function boardServersResult(
  ctx: ConnectorContext,
  id: unknown,
): Promise<string> {
  const servers: ServerReport[] = [];
  if (ctx.sharedUrl === null) {
    servers.push({
      kind: "shared",
      status: "down",
      credential: ctx.sharedToken !== null,
      hint: "the shared daemon's url could not be derived (invalid BOARD_* environment)",
    });
  } else if (!(await isHealthy(ctx.sharedUrl))) {
    servers.push({
      kind: "shared",
      url: ctx.sharedUrl,
      status: "down",
      credential: ctx.sharedToken !== null,
      hint: "not running — start the shared library with: make serve",
    });
  } else if (ctx.sharedToken === null) {
    servers.push({
      kind: "shared",
      url: ctx.sharedUrl,
      status: "up",
      credential: false,
      hint: "no BOARD_MCP_TOKEN credential wired to this connector — set it to list boards here (make install wires it)",
    });
  } else {
    const listed = await listBoards(ctx.sharedUrl, ctx.sharedToken);
    servers.push(
      typeof listed === "string"
        ? {
            kind: "shared",
            url: ctx.sharedUrl,
            status: "up",
            credential: true,
            hint: `boards not listed: ${listed}`,
          }
        : {
            kind: "shared",
            url: ctx.sharedUrl,
            status: "up",
            credential: true,
            boards: listed.boards,
          },
    );
  }
  for (const candidate of instanceCandidates(ctx.instancesDir)) {
    if (!(await isHealthy(candidate.url))) {
      servers.push({
        kind: "instance",
        id: candidate.id,
        url: candidate.url,
        status: "down",
        credential: candidate.token !== null,
        hint: `not healthy — dead or stale; clean it up with: board down ${candidate.id}`,
      });
    } else if (candidate.token === null) {
      servers.push({
        kind: "instance",
        id: candidate.id,
        url: candidate.url,
        status: "up",
        credential: false,
        hint: "its credential env file is missing — boards not listed",
      });
    } else {
      const listed = await listBoards(candidate.url, candidate.token);
      servers.push(
        typeof listed === "string"
          ? {
              kind: "instance",
              id: candidate.id,
              url: candidate.url,
              status: "up",
              credential: true,
              hint: `boards not listed: ${listed}`,
            }
          : {
              kind: "instance",
              id: candidate.id,
              url: candidate.url,
              status: "up",
              credential: true,
              boards: listed.boards,
            },
      );
    }
  }
  return localToolPayload(id, { servers });
}

// board_connect's argument forms — exactly one per call ("let's not try to
// be too clever, let's just be explicit" — the owner's ruling).
type ConnectForm =
  | { form: "url"; url: string; token: string }
  | { form: "instance"; id: string }
  | { form: "shared" }
  | { form: "status" }
  | { form: "reset" };

function parseConnectArgs(args: unknown): ConnectForm | string {
  if (!isRecord(args)) {
    return "board_connect needs an arguments object";
  }
  const { url, token, instance_id, shared, reset } = args;
  const given: string[] = [];
  if (url !== undefined || token !== undefined) {
    given.push("{url, token}");
  }
  if (instance_id !== undefined) {
    given.push("{instance_id}");
  }
  if (shared !== undefined) {
    given.push("{shared: true}");
  }
  if (reset !== undefined) {
    given.push("{reset: true}");
  }
  if (given.length === 0) {
    return { form: "status" };
  }
  if (reset !== undefined) {
    return reset === true && given.length === 1
      ? { form: "reset" }
      : "board_connect: {reset: true} takes no other arguments";
  }
  if (given.length > 1) {
    return (
      `board_connect: pass exactly one connect form, got ${given.join(" + ")} — ` +
      "forms: {url, token} | {instance_id} | {shared: true} | {} (status echo) | {reset: true}"
    );
  }
  if (url !== undefined || token !== undefined) {
    if (
      typeof url !== "string" ||
      typeof token !== "string" ||
      url.length === 0 ||
      token.length === 0
    ) {
      return "board_connect: {url, token} needs both a non-empty url and a non-empty token";
    }
    return { form: "url", url, token };
  }
  if (instance_id !== undefined) {
    if (typeof instance_id !== "string" || instance_id.length === 0) {
      return "board_connect: instance_id must be a non-empty string";
    }
    return { form: "instance", id: instance_id };
  }
  return shared === true
    ? { form: "shared" }
    : "board_connect: shared must be true when provided";
}

// The connect echo's target shape — kind names mirror the resolution
// diagnostics ("direct" = a {url, token} pin).
function targetEcho(backend: Backend): Record<string, unknown> {
  switch (backend.kind) {
    case "shared":
      return { kind: "shared", url: backend.url };
    case "instance":
      return { kind: "instance", id: backend.id, url: backend.url };
    case "direct":
      return { kind: "direct", url: backend.url };
  }
}

// board_connect — validate, then pin (a bad target pins NOTHING; the prior
// state survives). Validation is always: structural guard → health probe →
// an authenticated boards list (the token must actually authenticate, not
// just exist). The captured token lives only in the in-memory pin.
async function boardConnectResult(
  ctx: ConnectorContext,
  id: unknown,
  args: unknown,
): Promise<string> {
  const parsed = parseConnectArgs(args);
  if (typeof parsed === "string") {
    return localToolError(id, parsed);
  }
  switch (parsed.form) {
    case "status": {
      const echo: Record<string, unknown> = {
        connected: ctx.pin !== null,
        board_instance_env: ctx.envInstanceId,
      };
      if (ctx.pin !== null) {
        echo.target = targetEcho(ctx.pin);
      }
      if (ctx.envInstanceId !== null) {
        echo.note =
          "BOARD_INSTANCE is set and governs resolution strictly — it takes precedence over any pin";
      }
      return localToolPayload(id, echo);
    }
    case "reset":
      ctx.pin = null;
      return localToolPayload(id, { connected: false, reset: true });
    case "shared": {
      if (ctx.sharedUrl === null) {
        return localToolError(
          id,
          "cannot connect: the shared daemon's url could not be derived (invalid BOARD_* environment)",
        );
      }
      if (ctx.sharedToken === null) {
        return localToolError(
          id,
          "cannot connect: BOARD_MCP_TOKEN is not set — no shared credential to connect with (mint one with `make token add <name>`; `make install` wires it)",
        );
      }
      if (!(await isHealthy(ctx.sharedUrl))) {
        return localToolError(
          id,
          `cannot connect: the shared daemon at ${ctx.sharedUrl} is not healthy — start it with: make serve`,
        );
      }
      const listed = await listBoards(ctx.sharedUrl, ctx.sharedToken);
      if (typeof listed === "string") {
        return localToolError(
          id,
          `cannot connect: ${listed} — nothing pinned (re-mint + rewire with: make install FLAGS=--force)`,
        );
      }
      ctx.pin = { kind: "shared", url: ctx.sharedUrl, token: ctx.sharedToken };
      return localToolPayload(id, {
        connected: true,
        target: targetEcho(ctx.pin),
        boards: listed.boards,
      });
    }
    case "url": {
      // A trailing slash (copy-paste common) would make every probe/fetch
      // double-slashed — normalize before validating and pin.
      const url = parsed.url.endsWith("/")
        ? parsed.url.slice(0, -1)
        : parsed.url;
      if (!isLoopbackHttpUrl(url)) {
        return localToolError(
          id,
          `cannot connect: "${parsed.url}" is not a loopback http url — board servers are only ever reachable on this machine at http://127.0.0.1:<port> (or localhost / [::1]); nothing pinned`,
        );
      }
      if (!(await isHealthy(url))) {
        return localToolError(
          id,
          `cannot connect: no board server answered at ${url} — nothing pinned`,
        );
      }
      const listed = await listBoards(url, parsed.token);
      if (typeof listed === "string") {
        return localToolError(
          id,
          `cannot connect: ${listed} — nothing pinned (ask the board's manager for the right token)`,
        );
      }
      ctx.pin = { kind: "direct", url, token: parsed.token };
      return localToolPayload(id, {
        connected: true,
        target: targetEcho(ctx.pin),
        boards: listed.boards,
      });
    }
    case "instance": {
      if (!plausibleInstanceId(parsed.id)) {
        return localToolError(
          id,
          `cannot connect: "${parsed.id}" is not an instance id — ids look like s-<10 alphanumerics> (minted by board up)`,
        );
      }
      const wanted = parsed.id;
      const candidate = instanceCandidates(ctx.instancesDir).find(
        (c) => c.id === wanted,
      );
      if (candidate === undefined) {
        return localToolError(
          id,
          `cannot connect: instance "${wanted}" is not an open entry in the registry — list live instances with: board instances`,
        );
      }
      if (!(await isHealthy(candidate.url))) {
        return localToolError(
          id,
          `cannot connect: instance "${wanted}" at ${candidate.url} is not healthy (dead or stale) — nothing pinned`,
        );
      }
      if (candidate.token === null) {
        return localToolError(
          id,
          `cannot connect: instance "${wanted}" has no credential env file — boards unreachable, nothing pinned`,
        );
      }
      const listed = await listBoards(candidate.url, candidate.token);
      if (typeof listed === "string") {
        return localToolError(id, `cannot connect: ${listed} — nothing pinned`);
      }
      ctx.pin = {
        kind: "instance",
        id: candidate.id,
        url: candidate.url,
        token: candidate.token,
      };
      return localToolPayload(id, {
        connected: true,
        target: targetEcho(ctx.pin),
        boards: listed.boards,
      });
    }
  }
}

// One parsed stdin message → one stdout line (or null: notifications and
// client-initiated chatter never get a response). Local answers (initialize,
// ping, tools/list, and the two connector-local tools) never touch a backend;
// everything else resolves one per request.
export async function handleMessage(
  message: unknown,
  ctx: ConnectorContext,
): Promise<string | null> {
  if (!isRecord(message) || typeof message.method !== "string") {
    // Batch arrays and other non-request shapes are not part of the stdio
    // line protocol — answered as invalid request where an id exists.
    const id = isRecord(message) ? (message.id ?? null) : null;
    return JSON.stringify(errorResponse(id, -32600, "invalid request"));
  }
  if (!("id" in message)) {
    return null; // notification: consume silently, never responded
  }
  const id = message.id ?? null;

  switch (message.method) {
    case "initialize": {
      // Respond immediately without any backend (opencode handshakes before
      // any daemon may exist). Mirrors the daemon's initialize response
      // shape: protocolVersion, capabilities, serverInfo.
      const params = isRecord(message.params) ? message.params : {};
      const requested = params.protocolVersion;
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof requested === "string" ? requested : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      });
    }
    case "ping":
      return JSON.stringify({ jsonrpc: "2.0", id, result: {} });
    default:
      break;
  }

  // tools/list is ALWAYS answered locally from the single-source manifest
  // (D23 D4): the two connector-local tools must be listed whether or not a
  // backend is up — a client's tool list must not flap with backend state —
  // and the manifest's proxied entries are parity-pinned against the live
  // daemon's own listing (connector tests), so nothing is lost by not
  // proxying the listing.
  if (message.method === "tools/list") {
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { tools: offlineToolList() },
    });
  }

  // The connector-local tools (D23 D4) run here regardless of backend state:
  // discovery (board_servers) must work when NOTHING is up, and the pin
  // (board_connect) is this process's state — neither ever touches a backend
  // resolution.
  if (message.method === "tools/call") {
    const params = isRecord(message.params) ? message.params : undefined;
    const name = typeof params?.name === "string" ? params.name : undefined;
    if (name === "board_servers") {
      return boardServersResult(ctx, id);
    }
    if (name === "board_connect") {
      return boardConnectResult(ctx, id, params?.arguments);
    }
  }

  const resolved = await resolveBackend(ctx);
  if (typeof resolved === "string") {
    // Strict-resolution failure (a set BOARD_INSTANCE that is dead/missing):
    // an honest error naming the target and the fix — never a silent
    // fallthrough onto another backend.
    if (message.method === "tools/call") {
      return localToolError(id, resolved);
    }
    return JSON.stringify(errorResponse(id, -32601, resolved));
  }
  const backend = resolved;
  if (backend === null) {
    if (message.method === "tools/call") {
      return localToolError(id, NO_BACKEND_GUIDANCE);
    }
    return JSON.stringify(
      errorResponse(
        id,
        -32601,
        `method "${message.method}" not found: ${NO_BACKEND_GUIDANCE}`,
      ),
    );
  }
  // One stderr line per proxied request naming the resolved backend (D22
  // audit finding): with concurrent session instances the newest-first route
  // can silently land a call on the wrong instance — this surfaces the choice
  // in the harness's MCP log. A pinned target is marked ", connected" (or
  // just "(connected)" for a direct {url, token} pin — D23 D4). stdout stays
  // protocol-only, and no token material ever reaches either stream
  // (invariant 7).
  const connected = ctx.pin !== null && backend === ctx.pin;
  ctx.diagnose(
    backend.kind === "shared"
      ? `board connector: backend ${backend.url} (shared${connected ? ", connected" : ""})`
      : backend.kind === "instance"
        ? `board connector: backend ${backend.url} (instance ${backend.id}${connected ? ", connected" : ""})`
        : `board connector: backend ${backend.url} (connected)`,
  );
  return proxyToBackend(backend, message);
}

// One stdin LINE → one stdout line (or null: notifications never get a
// response). The framing seam: unparsable JSON is a -32700 error with a null
// id here, before any message logic runs.
export async function handleLine(
  line: string,
  ctx: ConnectorContext,
): Promise<string | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return JSON.stringify(
      errorResponse(null, -32700, "parse error: line is not valid JSON"),
    );
  }
  return handleMessage(message, ctx);
}

// Full session: newline-delimited JSON-RPC from stdin until EOF, responses to
// stdout (drained per line so nothing is lost at exit). Returns the process
// exit code — 0 for a clean EOF.
export async function runMcpConnector(): Promise<number> {
  const ctx = connectorContext(process.env, (message) => {
    process.stderr.write(`board mcp: ${message}\n`);
  });
  // Prompt exit on the harness's shutdown signals — no in-flight request is
  // worth lingering for.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  const writeLine = (line: string): Promise<void> =>
    new Promise((resolveWrite) => {
      process.stdout.write(`${line}\n`, () => resolveWrite());
    });

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const out = await handleLine(line, ctx);
      if (out !== null) {
        await writeLine(out);
      }
    }
  }
  if (buffer.length > 0) {
    const out = await handleLine(buffer, ctx); // final line without its newline
    if (out !== null) {
      await writeLine(out);
    }
  }
  return 0;
}

// Direct node entry — the opencode wiring spawns exactly this:
// `node cli/src/mcp-connector.ts`. import.meta.main is a bun-ism (undefined
// under node), so the node case detects the entry by argv comparison.
const entryPath = process.argv[1];
if (
  import.meta.main ||
  (entryPath !== undefined &&
    resolve(entryPath) === fileURLToPath(import.meta.url))
) {
  void runMcpConnector().then((code) => process.exit(code));
}
