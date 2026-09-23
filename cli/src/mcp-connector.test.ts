// MCP connector tests (wave 1). The proxy path runs against REAL daemons
// (the repo's integration precedent: REST + MCP via the SDK client) — the
// connector's own resolution logic runs in-process through handleMessage,
// plus real subprocess proofs for both runtimes it ships as: bun via the
// cli dispatch, and node (the opencode path: `node cli/src/mcp-connector.ts`
// with NO bun on PATH — the environment fact that motivated the connector).
// Temp BOARD_DATA_DIR everywhere — never ~/.board.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../../server/test/helpers.ts";
import { parseInstanceEnv, parseInstanceJson } from "./instance-registry.ts";
import {
  instancePaths,
  spawnInstance,
  writeInstanceEntry,
} from "./instances.ts";
import {
  type ConnectorContext,
  connectorContext,
  handleLine,
  handleMessage,
} from "./mcp-connector.ts";

const dirs: string[] = [];
const spawned: Array<{ pid: number; dataDir: string }> = [];

afterAll(async () => {
  for (const { pid, dataDir } of spawned) {
    if (existsSync(`/proc/${pid}`)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// A loopback port with nothing on it (closed immediately) — the "shared
// daemon down" fixture.
function closedPort(): number {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  server.close();
  return port;
}

function connectorEnv(opts: {
  dataDir: string;
  port: number;
  token?: string;
}): Record<string, string> {
  return {
    BOARD_DATA_DIR: opts.dataDir,
    BOARD_HOST: "127.0.0.1",
    BOARD_PORT: String(opts.port),
    ...(opts.token === undefined ? {} : { BOARD_MCP_TOKEN: opts.token }),
  };
}

function contextFor(opts: { dataDir: string; port: number; token?: string }): {
  ctx: ConnectorContext;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  return {
    ctx: connectorContext(connectorEnv(opts), (m) => diagnostics.push(m)),
    diagnostics,
  };
}

// One JSON-RPC request through the connector; returns the parsed response.
async function rpc(
  ctx: ConnectorContext,
  method: string,
  params?: Record<string, unknown>,
  id: number | null = 1,
): Promise<Record<string, unknown>> {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (id !== null) {
    message.id = id;
  }
  if (params !== undefined) {
    message.params = params;
  }
  const out = await handleMessage(message, ctx);
  if (out === null) {
    throw new Error(`expected a response for ${method}, got none`);
  }
  return JSON.parse(out) as Record<string, unknown>;
}

async function callTool(
  ctx: ConnectorContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await rpc(ctx, "tools/call", { name, arguments: args });
  return res.result as Record<string, unknown>;
}

function toolText(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0]?.text ?? "";
}

async function liveToolsList(
  s: TestServer,
  token: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${s.hostUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  return body.result.tools;
}

describe("mcp connector — proxy path (real daemon)", () => {
  test("tools/call board_create works end to end against a real temp daemon", async () => {
    const s = startTestServer();
    try {
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token: (await s.createAgent("connector-agent")).token,
      });
      const result = await callTool(ctx, "board_create", {
        title: "Via connector",
        format: "markdown",
      });
      expect(result.isError).toBeUndefined();
      const created = JSON.parse(toolText(result)) as { id: string };
      expect(created.id).toBeTruthy();
      // The board really exists on the proxied daemon.
      const token = (await s.createAgent("connector-verifier")).token;
      const res = await s.api.get(`/api/boards/${created.id}`, { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        board: { title: string; current_version: number };
      };
      expect(body.board.title).toBe("Via connector");
      expect(body.board.current_version).toBe(0);
    } finally {
      await s.stop();
    }
  });

  test("relayed response and diagnostics never contain the token", async () => {
    const s = startTestServer();
    try {
      const token = (await s.createAgent("hygiene-agent")).token;
      const { ctx, diagnostics } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token,
      });
      // Drive initialize, tools/list, and a proxied call — the full message
      // surface — collecting every stdout line the connector would emit.
      const lines: Array<string | null> = [];
      for (const message of [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "board_list", arguments: {} },
        },
        "not json at all",
      ]) {
        lines.push(await handleMessage(message, ctx));
      }
      const stdout = lines.filter((l): l is string => l !== null).join("\n");
      expect(stdout.length).toBeGreaterThan(0);
      expect(stdout).not.toContain(token);
      // Per-request backend diagnostics (they name the resolved backend, by
      // design) never carry credential material — same invariant as stdout.
      expect(diagnostics.join("\n")).not.toContain(token);
    } finally {
      await s.stop();
    }
  });
});

describe("mcp connector — no backend", () => {
  test("tools/call answers isError with the start-one guidance", async () => {
    const { ctx } = contextFor({
      dataDir: freshDir("board-connector-test-"),
      port: closedPort(),
    });
    const result = await callTool(ctx, "board_create", { title: "x" });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toBe(
      "no board server is running. Start one: run `make up` (or `board up`) " +
        "for a task-scoped session board you own, or ask the human to start " +
        "the shared library (`make serve`). Discover what IS up with " +
        "board_servers, or pin an explicit target with board_connect. The " +
        "connector re-resolves on every call — retry after starting one.",
    );
  });

  test("tools/list is answered locally and equals the live daemon's listing plus the two connector-local tools", async () => {
    const s = startTestServer();
    try {
      const token = (await s.createAgent("parity-agent")).token;
      const live = await liveToolsList(s, token);
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: closedPort(),
      });
      const res = await rpc(ctx, "tools/list");
      const offline = (res.result as { tools: Array<Record<string, unknown>> })
        .tools;
      // The connector lists 15: the daemon's 13 (same order, names,
      // descriptions, schemas — the parity hard requirement) + the two
      // connector-local tools (D23 D4), which the daemon never advertises.
      expect(offline).toHaveLength(15);
      expect(offline.slice(0, 13)).toEqual(live);
      const offlineNames = offline.map((tool) => tool.name);
      expect(offlineNames.slice(13)).toEqual([
        "board_servers",
        "board_connect",
      ]);
      // And the same holds with a backend UP: tools/list never proxies, so a
      // client's tool list cannot flap with backend state.
      const liveCtx = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token,
      }).ctx;
      const upRes = await rpc(liveCtx, "tools/list");
      expect(upRes.result).toEqual(res.result);
    } finally {
      await s.stop();
    }
  });

  test("other methods get -32601 with no backend; unparsable lines get -32700 id null", async () => {
    const { ctx } = contextFor({
      dataDir: freshDir("board-connector-test-"),
      port: closedPort(),
    });
    const res = await rpc(ctx, "resources/list");
    expect(res.error).toEqual({
      code: -32601,
      message: expect.stringContaining("resources/list"),
    });
    // -32700 is the FRAMING layer's answer (JSON.parse happens on the line,
    // before message logic) — handleLine is that seam.
    const bad = await handleLine("{{{", ctx);
    expect(bad).not.toBeNull();
    expect(JSON.parse(bad as string)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: expect.any(String) },
    });
  });

  test("initialize answers immediately without any backend", async () => {
    const { ctx } = contextFor({
      dataDir: freshDir("board-connector-test-"),
      port: closedPort(),
    });
    const res = await rpc(ctx, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "opencode", version: "1.18.31" },
    });
    expect(res.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "board", version: "0.7.0" },
    });
    // notifications get no response at all
    expect(
      await handleMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        ctx,
      ),
    ).toBeNull();
  });

  test("invalid BOARD_* environment degrades to offline mode with one diagnostic", async () => {
    const diagnostics: string[] = [];
    const ctx = connectorContext(
      { BOARD_DATA_DIR: "/tmp/opencode/unused", BOARD_PORT: "not-a-port" },
      (m) => diagnostics.push(m),
    );
    expect(ctx.sharedUrl).toBeNull();
    expect(ctx.instancesDir).toBeNull();
    expect(diagnostics).toHaveLength(1);
    const res = await rpc(ctx, "tools/list");
    expect((res.result as { tools: unknown[] }).tools).toHaveLength(15);
  });
});

describe("mcp connector — backend resolution order", () => {
  test("shared daemon preferred when healthy AND BOARD_MCP_TOKEN present", async () => {
    const s = startTestServer();
    try {
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "instance-agent",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      const { ctx } = contextFor({
        dataDir: registry,
        port: Number(new URL(s.hostUrl).port),
        token: (await s.createAgent("shared-agent")).token,
      });
      const result = await callTool(ctx, "board_create", {
        title: "Shared wins",
      });
      const created = JSON.parse(toolText(result)) as { id: string };
      // The board landed on the SHARED daemon, not the instance.
      const token = (await s.createAgent("shared-verifier")).token;
      const res = await s.api.get(`/api/boards/${created.id}`, { token });
      expect(res.status).toBe(200);
      const instRes = await fetch(
        `${instance.entry.url}/api/boards/${created.id}`,
        { headers: { authorization: `Bearer ${instance.token}` } },
      );
      expect(instRes.status).toBe(404);
    } finally {
      await s.stop();
    }
  });

  test("instance used when shared daemon is down", async () => {
    const registry = freshDir("board-connector-test-");
    const instance = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "instance-agent",
    });
    spawned.push({ pid: instance.entry.pid, dataDir: instance.entry.dataDir });
    const { ctx } = contextFor({
      dataDir: registry,
      port: closedPort(), // shared: down
    });
    const result = await callTool(ctx, "board_create", {
      title: "Instance serves",
    });
    expect(result.isError).toBeUndefined();
    const created = JSON.parse(toolText(result)) as { id: string };
    const res = await fetch(`${instance.entry.url}/api/boards/${created.id}`, {
      headers: { authorization: `Bearer ${instance.token}` },
    });
    expect(res.status).toBe(200);
  });

  test("empty-string BOARD_MCP_TOKEN counts as absent: instance serves", async () => {
    // {env:VAR} interpolation in opencode configs yields "" when the variable
    // is unset — an empty credential must not pin routing to the shared daemon.
    const s = startTestServer();
    try {
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "empty-token-agent",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      const { ctx } = contextFor({
        dataDir: registry,
        port: Number(new URL(s.hostUrl).port), // shared: healthy
        token: "",
      });
      const result = await callTool(ctx, "board_create", {
        title: "Empty token falls through",
      });
      expect(result.isError).toBeUndefined();
      const created = JSON.parse(toolText(result)) as { id: string };
      const res = await fetch(
        `${instance.entry.url}/api/boards/${created.id}`,
        {
          headers: { authorization: `Bearer ${instance.token}` },
        },
      );
      expect(res.status).toBe(200); // landed on the instance, not shared
    } finally {
      await s.stop();
    }
  });

  test("shared healthy but unwired with an instance up: container-case diagnostic fires (silent when wired)", async () => {
    // The container case: make install could not wire the shared token
    // (read-only opencode.jsonc, EROFS), so no BOARD_MCP_TOKEN reaches the
    // connector while the shared daemon is healthy and a session instance
    // exists — resolution falls through to the instance, and the diagnostic
    // must name the split-brain and the fix.
    const s = startTestServer();
    try {
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "unwired-diag-agent",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      const unwired = contextFor({
        dataDir: registry,
        port: Number(new URL(s.hostUrl).port), // shared: healthy, NO token
      });
      const result = await callTool(unwired.ctx, "board_create", {
        title: "Container case",
      });
      expect(result.isError).toBeUndefined();
      const created = JSON.parse(toolText(result)) as { id: string };
      const onInstance = await fetch(
        `${instance.entry.url}/api/boards/${created.id}`,
        { headers: { authorization: `Bearer ${instance.token}` } },
      );
      expect(onInstance.status).toBe(200); // fell through to the instance
      const joined = unwired.diagnostics.join("\n");
      expect(joined).toContain("healthy but unwired (BOARD_MCP_TOKEN not set)");
      expect(joined).toContain("export BOARD_MCP_TOKEN");
      // diagnostics never carry credential material (invariant 7)
      expect(joined).not.toContain(instance.token);
      // Wired case: with the shared token in scope the diagnostic is silent.
      const wired = contextFor({
        dataDir: registry,
        port: Number(new URL(s.hostUrl).port),
        token: (await s.createAgent("wired-diag-agent")).token,
      });
      await callTool(wired.ctx, "board_list", {});
      expect(wired.diagnostics.join("\n")).not.toContain("healthy but unwired");
    } finally {
      await s.stop();
    }
  });

  test("shared 401 relays the re-mint hint (credential missing or rejected)", async () => {
    const s = startTestServer();
    try {
      // Well-formed but unknown credential: shared healthy, branch 1 routes
      // there, the daemon 401s — the relay must name the fix. (A proxied
      // call, since tools/list is answered locally since D23 D4. The HTTP 401
      // surfaces as a JSON-RPC error, not a tool result.)
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token: "tok_revoked0000000000000000000000000000000000000",
      });
      const res = await rpc(ctx, "tools/call", {
        name: "board_list",
        arguments: {},
      });
      const message = (res.error as { message: string }).message;
      expect(message).toContain("returned HTTP 401");
      expect(message).toContain(
        "re-mint + rewire with: make install FLAGS=--force",
      );
      // Same hint on the no-token path (shared healthy, nothing wired): its
      // 401 is the honest misconfiguration signal — now with the fix attached.
      const { ctx: bare } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
      });
      const bareRes = await rpc(bare, "tools/call", {
        name: "board_list",
        arguments: {},
      });
      expect((bareRes.error as { message: string }).message).toContain(
        "re-mint + rewire with: make install FLAGS=--force",
      );
    } finally {
      await s.stop();
    }
  });

  test("multiple healthy instances: newest createdAt wins", async () => {
    const registry = freshDir("board-connector-test-");
    const older = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "older-agent",
    });
    const newer = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "newer-agent",
    });
    spawned.push(
      { pid: older.entry.pid, dataDir: older.entry.dataDir },
      { pid: newer.entry.pid, dataDir: newer.entry.dataDir },
    );
    // Deterministic recency: stamp the entries' own createdAt fields.
    const olderPaths = instancePaths(registry, older.entry.id);
    const newerPaths = instancePaths(registry, newer.entry.id);
    writeInstanceEntry(olderPaths, {
      ...older.entry,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    writeInstanceEntry(newerPaths, {
      ...newer.entry,
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const { ctx } = contextFor({ dataDir: registry, port: closedPort() });
    const result = await callTool(ctx, "board_create", {
      title: "Newest wins",
    });
    const created = JSON.parse(toolText(result)) as { id: string };
    const onNewer = await fetch(`${newer.entry.url}/api/boards/${created.id}`, {
      headers: { authorization: `Bearer ${newer.token}` },
    });
    expect(onNewer.status).toBe(200);
    const onOlder = await fetch(`${older.entry.url}/api/boards/${created.id}`, {
      headers: { authorization: `Bearer ${older.token}` },
    });
    expect(onOlder.status).toBe(404);
    // Flip the stamps: routing follows recency, not scan order.
    writeInstanceEntry(olderPaths, {
      ...older.entry,
      createdAt: "2026-09-03T00:00:00.000Z",
    });
    writeInstanceEntry(newerPaths, {
      ...newer.entry,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const flipped = await callTool(ctx, "board_create", {
      title: "Older now newest",
    });
    const created2 = JSON.parse(toolText(flipped)) as { id: string };
    const onOlder2 = await fetch(
      `${older.entry.url}/api/boards/${created2.id}`,
      {
        headers: { authorization: `Bearer ${older.token}` },
      },
    );
    expect(onOlder2.status).toBe(200);
  });

  test("structural guard: non-loopback/malformed urls are skipped and never fetched", async () => {
    // The trap: a LIVE server behind a url that must NEVER be fetched
    // ("localhost" is not the literal 127.0.0.1 the guard demands).
    let hits = 0;
    const trap = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits++;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const registry = freshDir("board-connector-test-");
      const instances = join(registry, "instances");
      const write = (id: string, url: string): void => {
        mkdirSync(join(instances, id), { recursive: true });
        writeFileSync(
          join(instances, id, "instance.json"),
          JSON.stringify({
            id,
            pid: 1,
            url,
            dataDir: "/tmp/opencode/unused",
            agentTokenName: "trap",
            createdAt: "2026-09-02T00:00:00.000Z",
          }),
        );
      };
      write("s-trapurl0001", `http://localhost:${trap.port}`); // alias — must be skipped
      write("s-trapbind0002", `http://0.0.0.0:${trap.port}`); // wildcard — skipped
      write("s-trapschm0003", `https://127.0.0.1:${trap.port}`); // wrong scheme — skipped
      write("s-trapgarb0004", "not-a-url"); // malformed — skipped
      // A shape-valid instance that is simply DOWN: proves the isError below
      // comes from the guard having skipped the trap, not from "no entries".
      write("s-trapdead0005", `http://127.0.0.1:${closedPort()}`);
      const { ctx } = contextFor({ dataDir: registry, port: closedPort() });
      const result = await callTool(ctx, "board_create", { title: "x" });
      expect(result.isError).toBe(true);
      expect(hits).toBe(0); // the trap was never fetched, not even health-checked
    } finally {
      await trap.stop(true);
    }
  });
});

// A fake registry entry with a given (typically dead) url — the structural-
// guard test's pattern — plus an optional credential env file, for the D23 D4
// discovery/connect tests. pid/dataDir mimic a real entry; the connector
// (health-probe based, no pid identity) never inspects them.
function writeFakeInstance(
  registry: string,
  id: string,
  url: string,
  opts: { token?: string; createdAt?: string } = {},
): void {
  const dir = join(registry, "instances", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "instance.json"),
    JSON.stringify({
      id,
      pid: 1,
      url,
      dataDir: "/tmp/opencode/unused",
      agentTokenName: "fake",
      createdAt: opts.createdAt ?? "2026-09-02T00:00:00.000Z",
    }),
  );
  if (opts.token !== undefined) {
    writeFileSync(
      join(dir, "env"),
      `# fake instance env\nexport BOARD_INSTANCE=${id}\nexport BOARD_PORT=${new URL(url).port}\nexport BOARD_TOKEN=${opts.token}\n`,
    );
  }
}

// The published-board shape discovery reports per server.
interface DiscoveredBoard {
  id: string;
  title: string;
  status: string;
  current_version: number;
  unresolved_comments: number;
}

// A defined-or-fail helper: finds a fixture in a report and narrows TS — a
// missing entry fails the test with a name instead of an undefined deref.
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`fixture missing: ${what}`);
  }
  return value;
}

describe("mcp connector — D23 D4 discovery + explicit connect", () => {
  test("board_servers enumerates shared + instances, lists boards where a credential exists, never leaks tokens", async () => {
    const s = startTestServer();
    try {
      const sharedToken = (await s.createAgent("discover-shared")).token;
      // A board on the shared daemon and one on the instance — each must
      // appear under its own server only.
      const sharedRes = await s.api.post(
        "/api/boards",
        { title: "Shared library board", format: "markdown" },
        { token: sharedToken },
      );
      expect(sharedRes.status).toBe(201);
      const sharedBoard = (await sharedRes.json()) as { id: string };
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "discover-instance",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      const created = await fetch(`${instance.entry.url}/api/boards`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${instance.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Instance board", format: "markdown" }),
      });
      expect(created.status).toBe(201);
      const instanceBoard = (await created.json()) as { id: string };
      // A dead fake instance — listed status-only.
      writeFakeInstance(
        registry,
        "s-deadserver1",
        `http://127.0.0.1:${closedPort()}`,
        {
          token: "tok_neverreported0000000000000000000000000000",
        },
      );
      const { ctx } = contextFor({
        dataDir: registry,
        port: Number(new URL(s.hostUrl).port),
        token: sharedToken,
      });
      const result = await callTool(ctx, "board_servers");
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(toolText(result)) as {
        servers: Array<{
          kind: string;
          id?: string;
          url?: string;
          status: string;
          credential: boolean;
          boards?: DiscoveredBoard[];
          hint?: string;
        }>;
      };
      const shared = must(
        payload.servers.find((srv) => srv.kind === "shared"),
        "shared entry",
      );
      expect(shared.status).toBe("up");
      expect(shared.credential).toBe(true);
      expect(shared.boards?.some((b) => b.id === sharedBoard.id)).toBe(true);
      const live = must(
        payload.servers.find((srv) => srv.id === instance.entry.id),
        "live instance entry",
      );
      expect(live.status).toBe("up");
      expect(live.url).toBe(instance.entry.url);
      expect(live.boards?.some((b) => b.id === instanceBoard.id)).toBe(true);
      const dead = must(
        payload.servers.find((srv) => srv.id === "s-deadserver1"),
        "dead instance entry",
      );
      expect(dead.status).toBe("down");
      expect(dead.boards).toBeUndefined();
      expect(dead.hint).toContain("board down s-deadserver1");
      // No secrets, ever: no credential material appears anywhere in the
      // report (invariant 7).
      const text = toolText(result);
      expect(text).not.toContain(sharedToken);
      expect(text).not.toContain(instance.token);
      expect(text).not.toContain("tok_neverreported");
      // Only loopback urls are ever reported.
      for (const srv of payload.servers) {
        expect(srv.url ?? "http://127.0.0.1:0").toMatch(
          /^http:\/\/127\.0\.0\.1:\d+$/,
        );
      }
    } finally {
      await s.stop();
    }
  });

  test("board_servers works with NOTHING up: status-only shared + hint, no boards", async () => {
    const registry = freshDir("board-connector-test-");
    const { ctx } = contextFor({ dataDir: registry, port: closedPort() });
    const result = await callTool(ctx, "board_servers");
    expect(result.isError).toBeUndefined(); // discovery needs no backend
    const payload = JSON.parse(toolText(result)) as {
      servers: Array<{
        kind: string;
        status: string;
        boards?: unknown;
        hint?: string;
      }>;
    };
    expect(payload.servers).toHaveLength(1);
    const shared = must(payload.servers[0], "shared entry");
    expect(shared.kind).toBe("shared");
    expect(shared.status).toBe("down");
    expect(shared.hint).toContain("make serve");
    expect(shared.boards).toBeUndefined();
  });

  test("board_servers: credential-less shared is status-only with a wiring hint", async () => {
    const s = startTestServer();
    try {
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port), // shared: up, NO token
      });
      const result = await callTool(ctx, "board_servers");
      const payload = JSON.parse(toolText(result)) as {
        servers: Array<{
          status: string;
          credential: boolean;
          boards?: unknown;
          hint?: string;
        }>;
      };
      const shared = must(payload.servers[0], "shared entry");
      expect(shared.status).toBe("up");
      expect(shared.credential).toBe(false);
      expect(shared.boards).toBeUndefined();
      expect(shared.hint).toContain("BOARD_MCP_TOKEN");
    } finally {
      await s.stop();
    }
  });

  test("board_servers: shared down with a token in scope stays status-only — hint branches never leak (audit 2026-09-22)", async () => {
    // The one hint branch no no-leak assertion covered: the shared daemon
    // DOWN while ctx.sharedToken exists. The token must not reach the hint,
    // the entry, or anywhere in the payload (invariant 7).
    const secret = "tok_downbranch00000000000000000000000000";
    const { ctx } = contextFor({
      dataDir: freshDir("board-connector-test-"),
      port: closedPort(),
      token: secret,
    });
    const result = await callTool(ctx, "board_servers");
    expect(result.isError).toBeUndefined();
    const text = toolText(result);
    const payload = JSON.parse(text) as {
      servers: Array<{
        status: string;
        credential: boolean;
        boards?: unknown;
        hint?: string;
      }>;
    };
    const shared = must(payload.servers[0], "shared entry");
    expect(shared.status).toBe("down");
    expect(shared.credential).toBe(true);
    expect(shared.boards).toBeUndefined();
    expect(shared.hint).toContain("make serve");
    expect(text).not.toContain(secret);
  });

  test("board_connect {url, token}: validates then pins; pin beats newest-instance auto-resolution", async () => {
    const s = startTestServer();
    try {
      const sharedToken = (await s.createAgent("connect-shared")).token;
      const verifier = (await s.createAgent("connect-verifier")).token;
      // Auto-resolution (closed shared port, no token) would pick the live
      // instance — the pin must override it.
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "connect-instance",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      const { ctx, diagnostics } = contextFor({
        dataDir: registry,
        port: closedPort(), // shared: down
      });
      const connect = await callTool(ctx, "board_connect", {
        url: s.hostUrl,
        token: sharedToken,
      });
      expect(connect.isError).toBeUndefined();
      const echo = JSON.parse(toolText(connect)) as {
        connected: boolean;
        target: { kind: string; url: string };
        boards: DiscoveredBoard[];
      };
      expect(echo.connected).toBe(true);
      expect(echo.target).toEqual({ kind: "direct", url: s.hostUrl });
      expect(Array.isArray(echo.boards)).toBe(true);
      expect(toolText(connect)).not.toContain(sharedToken);
      // Pin persistence: a subsequent board_create routes to the PINNED
      // server, not the newest healthy instance.
      const result = await callTool(ctx, "board_create", { title: "Pinned" });
      expect(result.isError).toBeUndefined();
      const board = JSON.parse(toolText(result)) as { id: string };
      const onShared = await s.api.get(`/api/boards/${board.id}`, {
        token: verifier,
      });
      expect(onShared.status).toBe(200);
      const onInstance = await fetch(
        `${instance.entry.url}/api/boards/${board.id}`,
        { headers: { authorization: `Bearer ${instance.token}` } },
      );
      expect(onInstance.status).toBe(404);
      // The per-request diagnostic marks the connected target and stays
      // token-free.
      const joined = diagnostics.join("\n");
      expect(joined).toContain(`backend ${s.hostUrl} (connected)`);
      expect(joined).not.toContain(sharedToken);
    } finally {
      await s.stop();
    }
  });

  test("board_connect {url, token}: non-loopback urls refused structurally, nothing pinned", async () => {
    const registry = freshDir("board-connector-test-");
    const instance = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "guard-instance",
    });
    spawned.push({
      pid: instance.entry.pid,
      dataDir: instance.entry.dataDir,
    });
    const { ctx } = contextFor({ dataDir: registry, port: closedPort() });
    for (const url of [
      "http://192.168.1.50:7800", // another host
      "https://127.0.0.1:7800", // wrong scheme — board daemons are http
      "http://example.com:7800", // a name that could resolve anywhere
      "not a url at all",
      // Loopback-HOSTED but still refused (audit 2026-09-22): a query or
      // userinfo component would ride into fetch-failure error text — a
      // URL-embedded credential is a leak channel (invariant 7). The token
      // belongs in board_connect's token param, never the URL.
      "http://127.0.0.1:7800/?q=1",
      "http://tok@127.0.0.1:7800",
      "http://user:pass@127.0.0.1:7800",
      // Non-root path — MCP endpoint URL is not a server base URL; accepting
      // it caused false-positive health (SPA fallback 200) → misleading JSON
      // parse error (board_connect {url, token} guard 2026-09-23).
      "http://127.0.0.1:7800/mcp",
      "http://127.0.0.1:7800/api/boards",
    ]) {
      const rejected = await callTool(ctx, "board_connect", {
        url,
        token: "tok_whatever",
      });
      expect(rejected.isError).toBe(true);
      expect(toolText(rejected)).toContain("loopback");
      expect(toolText(rejected)).toContain("nothing pinned");
    }
    // The pin never took: the next call still auto-resolves to the instance.
    const result = await callTool(ctx, "board_create", { title: "Still auto" });
    expect(result.isError).toBeUndefined();
    const board = JSON.parse(toolText(result)) as { id: string };
    const onInstance = await fetch(
      `${instance.entry.url}/api/boards/${board.id}`,
      { headers: { authorization: `Bearer ${instance.token}` } },
    );
    expect(onInstance.status).toBe(200);
  });

  test("board_connect: dead or wrong-token target errors honestly and pins nothing", async () => {
    const s = startTestServer();
    try {
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "nopin-instance",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      const { ctx } = contextFor({ dataDir: registry, port: closedPort() });
      // Dead target: nothing listens there.
      const dead = await callTool(ctx, "board_connect", {
        url: `http://127.0.0.1:${closedPort()}`,
        token: "tok_deadtarget000000000000000000000000000",
      });
      expect(dead.isError).toBe(true);
      expect(toolText(dead)).toContain("no board server answered");
      // Wrong token: the server is up but the credential does not
      // authenticate — verified BEFORE pinning.
      const wrong = await callTool(ctx, "board_connect", {
        url: s.hostUrl,
        token: "tok_revoked0000000000000000000000000000000000000",
      });
      expect(wrong.isError).toBe(true);
      expect(toolText(wrong)).toContain("rejected (HTTP 401)");
      expect(toolText(wrong)).toContain("nothing pinned");
      // Both failures left the pin unset: the next call auto-resolves to the
      // instance.
      const result = await callTool(ctx, "board_create", { title: "Unpinned" });
      expect(result.isError).toBeUndefined();
      const board = JSON.parse(toolText(result)) as { id: string };
      const onInstance = await fetch(
        `${instance.entry.url}/api/boards/${board.id}`,
        { headers: { authorization: `Bearer ${instance.token}` } },
      );
      expect(onInstance.status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  test("board_connect: a redirecting target is refused — the connector never follows it (invariant 1, audit 2026-09-22)", async () => {
    // The hole this pins shut: fetch follows redirects by default, so a
    // target that 30x-redirects — anywhere, non-loopback included — would be
    // silently fetched, and validation would pass THROUGH the redirect (the
    // decoy answers health + boards). Pre-fix, this connect succeeds and
    // pins; post-fix it must fail like an unreachable target. All connector
    // fetches send redirect: "error".
    const decoy = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.url.endsWith("/api/health")) {
          return new Response('{"ok":true}', {
            headers: { "content-type": "application/json" },
          });
        }
        if (req.url.endsWith("/api/boards")) {
          return new Response(
            '[{"id":"b_decoy0000","title":"Decoy","status":"open","current_version":0,"unresolved_comments":0}]',
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    const redirector = Bun.serve({
      port: 0,
      fetch: (req) => {
        // Preserve the path: /api/health redirects to the decoy's
        // /api/health, so a redirect-FOLLOWING client validates successfully
        // (that is the hole — the connector must fetch a host it never
        // validated).
        const path = new URL(req.url).pathname;
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${decoy.port}${path}` },
        });
      },
    });
    try {
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: closedPort(),
      });
      const connect = await callTool(ctx, "board_connect", {
        url: `http://127.0.0.1:${redirector.port}`,
        token: "tok_redirtest0000000000000000000000000000",
      });
      expect(connect.isError).toBe(true);
      expect(toolText(connect)).toContain("no board server answered");
      // The pin never took: the status echo names no target.
      const echo = toolText(await callTool(ctx, "board_connect", {}));
      expect(echo).not.toContain(`:${redirector.port}`);
    } finally {
      redirector.stop(true);
      decoy.stop(true);
    }
  });

  test("board_connect {instance_id}: pins a live instance; unknown/dead/malformed ids error", async () => {
    const registry = freshDir("board-connector-test-");
    const instance = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "instapin-instance",
    });
    spawned.push({
      pid: instance.entry.pid,
      dataDir: instance.entry.dataDir,
    });
    writeFakeInstance(
      registry,
      "s-deadinst00",
      `http://127.0.0.1:${closedPort()}`,
      { token: "tok_deadinstance00000000000000000000000000000" },
    );
    const { ctx } = contextFor({ dataDir: registry, port: closedPort() });
    // unknown id (plausible shape, no such registry entry)
    const unknown = await callTool(ctx, "board_connect", {
      instance_id: "s-missing000",
    });
    expect(unknown.isError).toBe(true);
    expect(toolText(unknown)).toContain("not an open entry in the registry");
    // dead id
    const dead = await callTool(ctx, "board_connect", {
      instance_id: "s-deadinst00",
    });
    expect(dead.isError).toBe(true);
    expect(toolText(dead)).toContain("not healthy");
    // malformed id (path-traversal shape — never becomes a registry path)
    const malformed = await callTool(ctx, "board_connect", {
      instance_id: "../escape",
    });
    expect(malformed.isError).toBe(true);
    expect(toolText(malformed)).toContain("not an instance id");
    // the live instance pins, and a subsequent call routes there
    const connect = await callTool(ctx, "board_connect", {
      instance_id: instance.entry.id,
    });
    expect(connect.isError).toBeUndefined();
    const echo = JSON.parse(toolText(connect)) as {
      connected: boolean;
      target: { kind: string; id: string; url: string };
    };
    expect(echo).toMatchObject({
      connected: true,
      target: { kind: "instance", id: instance.entry.id },
    });
    const result = await callTool(ctx, "board_create", { title: "Instapin" });
    expect(result.isError).toBeUndefined();
    const board = JSON.parse(toolText(result)) as { id: string };
    const onInstance = await fetch(
      `${instance.entry.url}/api/boards/${board.id}`,
      { headers: { authorization: `Bearer ${instance.token}` } },
    );
    expect(onInstance.status).toBe(200);
  });

  test("board_connect {shared: true}: pins shared when healthy + token; honest errors otherwise", async () => {
    const s = startTestServer();
    try {
      const sharedToken = (await s.createAgent("sharepin-agent")).token;
      // happy: pinned shared
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token: sharedToken,
      });
      const connect = await callTool(ctx, "board_connect", { shared: true });
      expect(connect.isError).toBeUndefined();
      const echo = JSON.parse(toolText(connect)) as {
        connected: boolean;
        target: { kind: string; url: string };
      };
      expect(echo.connected).toBe(true);
      expect(echo.target).toEqual({ kind: "shared", url: s.hostUrl });
      // no credential wired
      const bare = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
      }).ctx;
      const noToken = await callTool(bare, "board_connect", { shared: true });
      expect(noToken.isError).toBe(true);
      expect(toolText(noToken)).toContain("BOARD_MCP_TOKEN is not set");
      // daemon down
      const down = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: closedPort(),
        token: sharedToken,
      }).ctx;
      const downRes = await callTool(down, "board_connect", { shared: true });
      expect(downRes.isError).toBe(true);
      expect(toolText(downRes)).toContain("not healthy");
    } finally {
      await s.stop();
    }
  });

  test("board_connect {} echoes status; {reset: true} clears the pin", async () => {
    const s = startTestServer();
    try {
      const sharedToken = (await s.createAgent("echo-agent")).token;
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token: sharedToken,
      });
      // unpinned echo
      const bare = JSON.parse(
        toolText(await callTool(ctx, "board_connect", {})),
      ) as { connected: boolean; board_instance_env: string | null };
      expect(bare).toEqual({ connected: false, board_instance_env: null });
      // pin, then echo shows it
      await callTool(ctx, "board_connect", { shared: true });
      const pinned = JSON.parse(
        toolText(await callTool(ctx, "board_connect", {})),
      ) as { connected: boolean; target?: { kind: string } };
      expect(pinned.connected).toBe(true);
      expect(pinned.target?.kind).toBe("shared");
      // reset returns to auto-resolution
      const reset = JSON.parse(
        toolText(await callTool(ctx, "board_connect", { reset: true })),
      ) as { connected: boolean; reset: boolean };
      expect(reset).toEqual({ connected: false, reset: true });
      const cleared = JSON.parse(
        toolText(await callTool(ctx, "board_connect", {})),
      ) as { connected: boolean };
      expect(cleared.connected).toBe(false);
      // mixed form is refused (be explicit, not clever)
      const mixed = await callTool(ctx, "board_connect", {
        shared: true,
        reset: true,
      });
      expect(mixed.isError).toBe(true);
      expect(toolText(mixed)).toContain(
        "{reset: true} takes no other arguments",
      );
    } finally {
      await s.stop();
    }
  });

  test("BOARD_INSTANCE env is strict: dead/missing instance errors with no fallthrough — even past a pin", async () => {
    const registry = freshDir("board-connector-test-");
    const instance = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "strict-instance",
    });
    spawned.push({
      pid: instance.entry.pid,
      dataDir: instance.entry.dataDir,
    });
    const deadId = "s-deadstrict0";
    writeFakeInstance(registry, deadId, `http://127.0.0.1:${closedPort()}`, {
      token: "tok_deadstrict000000000000000000000000000000",
    });
    // env → a DEAD instance: honest error even though a healthy instance (and,
    // below, a pin) is available — strict means no fallthrough.
    const ctx = connectorContext(
      {
        BOARD_DATA_DIR: registry,
        BOARD_HOST: "127.0.0.1",
        BOARD_PORT: String(closedPort()),
        BOARD_INSTANCE: deadId,
      },
      () => {},
    );
    const dead = await callTool(ctx, "board_create", { title: "x" });
    expect(dead.isError).toBe(true);
    expect(toolText(dead)).toContain(`BOARD_INSTANCE=${deadId}`);
    expect(toolText(dead)).toContain("not healthy");
    expect(toolText(dead)).toContain("will not fall through");
    // env → an UNKNOWN id (no such registry entry at all)
    const unknownCtx = connectorContext(
      {
        BOARD_DATA_DIR: registry,
        BOARD_HOST: "127.0.0.1",
        BOARD_PORT: String(closedPort()),
        BOARD_INSTANCE: "s-unknownid1",
      },
      () => {},
    );
    const missing = await callTool(unknownCtx, "board_list", {});
    expect(missing.isError).toBe(true);
    expect(toolText(missing)).toContain("no such open instance exists");
    // env dead BEATS a live pin (env > pin): pin the healthy instance, the
    // strict env error still governs.
    await callTool(ctx, "board_connect", { instance_id: instance.entry.id });
    const stillStrict = await callTool(ctx, "board_create", { title: "y" });
    expect(stillStrict.isError).toBe(true);
    expect(toolText(stillStrict)).toContain("will not fall through");
    // env → the LIVE instance: routes there.
    const liveCtx = connectorContext(
      {
        BOARD_DATA_DIR: registry,
        BOARD_HOST: "127.0.0.1",
        BOARD_PORT: String(closedPort()),
        BOARD_INSTANCE: instance.entry.id,
      },
      () => {},
    );
    const result = await callTool(liveCtx, "board_create", { title: "Strict" });
    expect(result.isError).toBeUndefined();
    const board = JSON.parse(toolText(result)) as { id: string };
    const onInstance = await fetch(
      `${instance.entry.url}/api/boards/${board.id}`,
      { headers: { authorization: `Bearer ${instance.token}` } },
    );
    expect(onInstance.status).toBe(200);
    // echo names the governing env id
    const echo = JSON.parse(
      toolText(await callTool(liveCtx, "board_connect", {})),
    ) as { board_instance_env: string | null; note?: string };
    expect(echo.board_instance_env).toBe(instance.entry.id);
    expect(echo.note).toContain("BOARD_INSTANCE");
  });

  test("pin beats shared auto-resolution (pin > shared in the amended order)", async () => {
    const s = startTestServer();
    try {
      const sharedToken = (await s.createAgent("pinbeats-agent")).token;
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "pinbeats-instance",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      // Shared healthy WITH token — auto would pick shared. Pin the instance;
      // the pin must win.
      const { ctx, diagnostics } = contextFor({
        dataDir: registry,
        port: Number(new URL(s.hostUrl).port),
        token: sharedToken,
      });
      const connect = await callTool(ctx, "board_connect", {
        instance_id: instance.entry.id,
      });
      expect(connect.isError).toBeUndefined();
      const result = await callTool(ctx, "board_create", { title: "PinWins" });
      expect(result.isError).toBeUndefined();
      const board = JSON.parse(toolText(result)) as { id: string };
      const onInstance = await fetch(
        `${instance.entry.url}/api/boards/${board.id}`,
        { headers: { authorization: `Bearer ${instance.token}` } },
      );
      expect(onInstance.status).toBe(200);
      const onShared = await s.api.get(`/api/boards/${board.id}`, {
        token: sharedToken,
      });
      expect(onShared.status).toBe(404);
      // the diagnostic marks the connected instance
      expect(diagnostics.join("\n")).toContain(
        `backend ${instance.entry.url} (instance ${instance.entry.id}, connected)`,
      );
    } finally {
      await s.stop();
    }
  });
});

describe("mcp connector — subprocess proofs", () => {
  test("node spawn (the opencode path): initialize, local tools/list, instance-proxied call", async () => {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error(
        "node not found on PATH — the opencode-path test needs it",
      );
    }
    // Instance-resolved call: no BOARD_MCP_TOKEN and a closed shared port —
    // the D21 default shape (shared daemon down, a session instance live).
    // This is the routing branch whose silent wrongness (newest-first across
    // concurrent instances) the per-request stderr diagnostic exists to
    // surface, so the real-opencode path must show the diagnostic too.
    const registry = freshDir("board-connector-test-");
    const instance = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "node-spawn-agent",
    });
    spawned.push({
      pid: instance.entry.pid,
      dataDir: instance.entry.dataDir,
    });
    const proc = Bun.spawn([node, join(import.meta.dir, "mcp-connector.ts")], {
      // opencode's environment shape: node on PATH, bun nowhere in it.
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: tmpdir(),
        BOARD_DATA_DIR: registry,
        BOARD_HOST: "127.0.0.1",
        BOARD_PORT: String(closedPort()), // shared: down
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (message: unknown): void => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "opencode", version: "1.18.31" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    // A PROXIED call too: tools/list is answered locally since D23 D4, so
    // the backend-resolution diagnostic needs an actual backend-bound tool.
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "board_list", arguments: {} },
    });

    const lines: string[] = [];
    let rawStdout = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 15_000;
    while (lines.length < 3 && Date.now() < deadline) {
      const chunk = (await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
      ])) as Awaited<ReturnType<typeof reader.read>> | "timeout";
      if (chunk === "timeout" || chunk.done) {
        break;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      rawStdout += text;
      buffer += text;
      const split = buffer.split("\n");
      buffer = split.pop() ?? "";
      for (const line of split) {
        if (line.trim().length > 0) {
          lines.push(line);
        }
      }
    }
    expect(lines.length).toBe(3); // initialize + tools/list + board_list
    const init = JSON.parse(lines[0] ?? "{}") as {
      id: number;
      result: Record<string, unknown>;
    };
    expect(init.id).toBe(1);
    expect(init.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "board", version: "0.7.0" },
    });
    const list = JSON.parse(lines[1] ?? "{}") as {
      id: number;
      result: { tools: unknown[] };
    };
    expect(list.id).toBe(2);
    // 15 = the daemon's 13 + the two connector-local tools (D23 D4), listed
    // from the local manifest even though the proxy target is live.
    expect(list.result.tools).toHaveLength(15);
    // The proxied board_list really reached the instance's daemon.
    const listed = JSON.parse(lines[2] ?? "{}") as {
      id: number;
      result: { content: Array<{ text: string }> };
    };
    expect(listed.id).toBe(3);
    expect(listed.result.content[0].text).toBe("[]");

    proc.stdin.end();
    expect(await proc.exited).toBe(0); // stdin EOF → exit 0
    // Credential + diagnostic hygiene across both streams of the real
    // subprocess (stdout already accumulated above — the stream is consumed):
    // the per-request diagnostic names the resolved backend but never the
    // instance credential it read from the registry env file.
    const stderr = await new Response(proc.stderr).text();
    expect(rawStdout).not.toContain(instance.token);
    expect(stderr).not.toContain(instance.token);
    expect(stderr).toContain(
      `board connector: backend ${instance.entry.url} (instance ${instance.entry.id})`,
    );
  });

  test("SIGTERM exits 0 promptly (the harness's shutdown signal)", async () => {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error(
        "node not found on PATH — the opencode-path test needs it",
      );
    }
    const proc = Bun.spawn([node, join(import.meta.dir, "mcp-connector.ts")], {
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: tmpdir(),
        BOARD_DATA_DIR: freshDir("board-connector-test-"),
        BOARD_PORT: String(closedPort()),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Wait until the connector is serving (it answers initialize) — a signal
    // during module load would take the default action, which is not the
    // scenario being tested (opencode signals an ESTABLISHED session).
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    );
    proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const initDeadline = Date.now() + 5_000;
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
      ]);
      if (Date.now() > initDeadline || (chunk !== "timeout" && chunk.done)) {
        throw new Error("connector never answered initialize");
      }
      if (chunk !== "timeout" && chunk.value.length > 0) {
        reader.cancel();
        break;
      }
    }
    proc.kill("SIGTERM");
    const exitedBefore = Promise.race([
      proc.exited,
      new Promise<1500>((r) => setTimeout(() => r(1500), 1500)),
    ]);
    expect(await exitedBefore).toBe(0);
    if (existsSync(`/proc/${proc.pid}`)) {
      proc.kill("SIGKILL"); // only if the prompt-exit assert failed
      await proc.exited;
    }
  });

  test("bun dispatch: `board mcp` (cli main) serves initialize + proxies a call", async () => {
    const s = startTestServer();
    try {
      const token = (await s.createAgent("dispatch-agent")).token;
      const registry = freshDir("board-connector-test-");
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, "main.ts"), "mcp"],
        {
          env: connectorEnv({
            dataDir: registry,
            port: Number(new URL(s.hostUrl).port),
            token,
          }),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const send = (message: unknown): void => {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        proc.stdin.flush();
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cli", version: "0" },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "board_create", arguments: { title: "Dispatched" } },
      });
      const lines: string[] = [];
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const deadline = Date.now() + 15_000;
      while (lines.length < 2 && Date.now() < deadline) {
        const chunk = (await Promise.race([
          reader.read(),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
        ])) as Awaited<ReturnType<typeof reader.read>> | "timeout";
        if (chunk === "timeout" || chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const split = buffer.split("\n");
        buffer = split.pop() ?? "";
        for (const line of split) {
          if (line.trim().length > 0) {
            lines.push(line);
          }
        }
      }
      expect(lines.length).toBe(2);
      const created = JSON.parse(lines[1]) as {
        id: number;
        result: { content: Array<{ text: string }> };
      };
      expect(created.id).toBe(2);
      const board = JSON.parse(created.result.content[0].text) as {
        id: string;
      };
      // The dispatched call really landed on the daemon.
      const verifier = (await s.createAgent("dispatch-verifier")).token;
      const res = await s.api.get(`/api/boards/${board.id}`, {
        token: verifier,
      });
      expect(res.status).toBe(200);
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).not.toContain(token);
    } finally {
      await s.stop();
    }
  });
});

// The shared parser module the connector depends on — pinned here because
// the connector's instance discovery and hygiene ride on its exact
// semantics (the same file instances.ts writes).
describe("instance-registry parsers", () => {
  test("parseInstanceEnv reads the writer's line discipline; garbage ignored", () => {
    const envText = [
      "# board session s-abc — source me; purged by board down",
      "export BOARD_INSTANCE=s-abc1234567",
      "export BOARD_PORT=7913",
      "export BOARD_TOKEN=tok_abcdef123456",
    ].join("\n");
    expect(parseInstanceEnv(envText)).toEqual({
      instance: "s-abc1234567",
      port: 7913,
      token: "tok_abcdef123456",
    });
    expect(parseInstanceEnv("export BOARD_TOKEN=")).toEqual({});
    expect(parseInstanceEnv("export  BOARD_TOKEN=x")).toEqual({}); // two spaces: not the writer's format
    expect(parseInstanceJson("not json")).toBeNull();
  });
});
