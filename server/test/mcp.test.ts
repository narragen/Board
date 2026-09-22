import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createComment } from "../src/comments.ts";
import { createExchangeToken, exchangeSession } from "../src/sessions.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const DOC = "# Plan\n\nA paragraph of substance.\n";

const TOOL_NAMES = [
  "board_create",
  "board_end",
  "board_export",
  "board_get",
  "board_get_comments",
  "board_list",
  "board_publish",
  "board_reply",
  "board_resolve",
  "board_restore",
  "board_status",
  "board_subscribe",
  "board_upload_image",
];

interface ToolPayload {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let current: TestServer | undefined;

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

function server(): TestServer {
  current ??= startTestServer();
  return current;
}

// Fresh SDK client against the live daemon's /mcp endpoint — the conformance
// oracle. Header auth via requestInit; ?token= via the URL itself.
async function connectClient(
  s: TestServer,
  opts: { headerToken?: string; queryToken?: string } = {},
): Promise<Client> {
  const headers: Record<string, string> = {};
  if (opts.headerToken !== undefined) {
    headers.authorization = `Bearer ${opts.headerToken}`;
  }
  const url = new URL(`${s.hostUrl}/mcp`);
  if (opts.queryToken !== undefined) {
    url.searchParams.set("token", opts.queryToken);
  }
  const client = new Client({ name: "mcp-test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  return (await client.callTool({ name, arguments: args })) as ToolPayload;
}

function toolJson(result: ToolPayload): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`tool failed: ${result.content[0]?.text}`);
  }
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function toolText(result: ToolPayload): string {
  return result.content[0]?.text ?? "";
}

async function errorCodeOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

describe("mcp endpoint", () => {
  test("handshake reports board server info and exactly the thirteen tools", async () => {
    const s = server();
    const agent = await s.createAgent("handshake-agent");
    const client = await connectClient(s, { headerToken: agent.token });
    try {
      const version = client.getServerVersion();
      expect(version?.name).toBe("board");
      expect(version?.version).toMatch(/^\d+\.\d+\.\d+$/);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
      for (const tool of tools.tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(0);
      }
    } finally {
      await client.close();
    }
  });

  test("connector-local tools (D23 D4): omitted from the listing, named honestly on a direct call", async () => {
    const s = server();
    const agent = await s.createAgent("local-tool-agent");
    const post = (body: unknown): Promise<Response> =>
      fetch(`${s.hostUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${agent.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    // The daemon's advertised surface stays exactly what it can execute.
    const list = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).not.toContain("board_servers");
    expect(names).not.toContain("board_connect");
    expect(names).toHaveLength(13);
    // A direct call gets the SDK's own unknown-tool ENVELOPE (an isError
    // result) with the honest connector-local message naming the fix.
    for (const name of ["board_servers", "board_connect"]) {
      const call = await post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: {} },
      });
      expect(call.status).toBe(200);
      const body = (await call.json()) as {
        result?: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content[0]?.text).toContain("connector-local");
      expect(body.result?.content[0]?.text).toContain(name);
      expect(body.result?.content[0]?.text).toContain("board mcp");
    }
  });

  test("full agent loop: create, publish, get, list, comments, reply, resolve, restore, end", async () => {
    const s = server();
    const agent = await s.createAgent("loop-agent");
    const client = await connectClient(s, { headerToken: agent.token });
    try {
      const created = toolJson(
        await callTool(client, "board_create", {
          title: "MCP loop",
          format: "markdown",
          tags: ["m5"],
        }),
      );
      const boardId = created.id as string;
      expect(created.status).toBe("open");
      expect(created.current_version).toBe(0);
      expect(created.created_by).toBe("loop-agent");
      expect(created.tags).toEqual(["m5"]);

      const published = toolJson(
        await callTool(client, "board_publish", {
          board_id: boardId,
          format: "markdown",
          content: DOC,
          expected_version: 0,
          label: "v1",
        }),
      );
      expect(published.n).toBe(1);
      expect(published.label).toBe("v1");
      expect(published.board_id).toBe(boardId);
      expect(published.content_bytes).toBe(Buffer.byteLength(DOC, "utf8"));
      // no full-content dump: version metadata + byte length only
      expect(published).not.toHaveProperty("content");
      expect(published).not.toHaveProperty("source_md");

      const got = toolJson(
        await callTool(client, "board_get", { board_id: boardId }),
      );
      const gotBoard = got.board as Record<string, unknown>;
      expect(gotBoard.current_version).toBe(1);
      expect((got.versions as unknown[]).length).toBe(1);

      const listed = toolJson(
        await callTool(client, "board_list", {}),
      ) as unknown;
      const boards = listed as Array<Record<string, unknown>>;
      expect(boards).toHaveLength(1);
      expect(boards[0].id).toBe(boardId);
      expect(boards[0].unresolved_comments).toBe(0);

      // The human side of the loop, seeded in-process (same db handle).
      const comment = createComment(s.db, s.dataDir, boardId, {
        anchor: { type: "board" },
        body: "tighten this",
        version_n: 1,
        actor: "human",
      });

      const feed = toolJson(
        await callTool(client, "board_get_comments", {
          board_id: boardId,
          since: 0,
        }),
      );
      const comments = feed.comments as Array<Record<string, unknown>>;
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(comment.id);
      expect(comments[0].body).toBe("tighten this");
      expect(comments[0].author).toBe("human");
      expect(comments[0].anchor).toEqual({ type: "board" });
      expect(comments[0].in_reply_to).toBeNull();
      expect(feed.last_seq).toBe(comment.seq);

      // MCP polls are presence: the cursor subscriber row was upserted.
      const subscriber = s.db
        .prepare(
          "SELECT agent, kind, last_seq FROM subscribers WHERE board_id = ?",
        )
        .get(boardId) as { agent: string; kind: string; last_seq: number };
      expect(subscriber.agent).toBe("loop-agent");
      expect(subscriber.kind).toBe("cursor");
      expect(subscriber.last_seq).toBe(comment.seq);

      const reply = toolJson(
        await callTool(client, "board_reply", {
          comment_id: comment.id,
          body: "on it",
        }),
      );
      expect(reply.in_reply_to).toBe(comment.id);
      expect(reply.author).toBe("loop-agent");

      const resolved = toolJson(
        await callTool(client, "board_resolve", { comment_id: comment.id }),
      );
      expect(resolved.resolved_at).not.toBeNull();
      expect(resolved.resolved_by).toBe("loop-agent");

      const feedAfter = toolJson(
        await callTool(client, "board_get_comments", { board_id: boardId }),
      );
      const thread = feedAfter.comments as Array<Record<string, unknown>>;
      expect(thread).toHaveLength(2);
      const root = thread.find((c) => c.id === comment.id) as Record<
        string,
        unknown
      >;
      expect(root.resolved_at).not.toBeNull();

      const restored = toolJson(
        await callTool(client, "board_restore", {
          board_id: boardId,
          from_n: 1,
          expected_version: 1,
        }),
      );
      expect(restored.n).toBe(2);
      expect(restored.label).toBe("restore of v1");

      const ended = toolJson(
        await callTool(client, "board_end", { board_id: boardId }),
      );
      expect(ended.status).toBe("ended");

      const refused = await callTool(client, "board_publish", {
        board_id: boardId,
        format: "markdown",
        content: DOC,
        expected_version: 2,
      });
      expect(refused.isError).toBe(true);
      expect(toolText(refused)).toContain("is ended");
    } finally {
      await client.close();
    }
  });

  test("publishing with a stale expected_version errors with current_version", async () => {
    const s = server();
    const agent = await s.createAgent("conflict-agent");
    const client = await connectClient(s, { headerToken: agent.token });
    try {
      const board = toolJson(
        await callTool(client, "board_create", { title: "Conflict" }),
      );
      const boardId = board.id as string;
      await callTool(client, "board_publish", {
        board_id: boardId,
        format: "markdown",
        content: DOC,
        expected_version: 0,
      });
      const stale = await callTool(client, "board_publish", {
        board_id: boardId,
        format: "markdown",
        content: DOC,
        expected_version: 0,
      });
      expect(stale.isError).toBe(true);
      expect(toolText(stale)).toContain("current_version: 1");
    } finally {
      await client.close();
    }
  });

  test("board_status reports counts, subscribers, and per-board detail", async () => {
    const s = server();
    const agent = await s.createAgent("status-agent");
    const client = await connectClient(s, { headerToken: agent.token });
    try {
      const board = toolJson(
        await callTool(client, "board_create", { title: "Status" }),
      );
      const boardId = board.id as string;
      const bare = toolJson(await callTool(client, "board_status", {}));
      expect(bare.status).toBe("ok");
      expect(bare.boards).toEqual({ open: 1, ended: 0 });
      expect(bare.subscribers).toBe(0);
      const detailed = toolJson(
        await callTool(client, "board_status", { board_id: boardId }),
      );
      const detail = detailed.board as Record<string, unknown>;
      expect(detail.status).toBe("open");
      expect(detail.current_version).toBe(0);
      expect(detail.unresolved_comments).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("board_get errors on an unknown board", async () => {
    const s = server();
    const agent = await s.createAgent("missing-agent");
    const client = await connectClient(s, { headerToken: agent.token });
    try {
      const missing = await callTool(client, "board_get", { board_id: "nope" });
      expect(missing.isError).toBe(true);
      expect(toolText(missing)).toContain("not found");
    } finally {
      await client.close();
    }
  });

  test("publish via MCP emits the same board.published event as REST", async () => {
    const s = server();
    const mcpAgent = await s.createAgent("event-agent-mcp");
    const restAgent = await s.createAgent("event-agent-rest");
    const client = await connectClient(s, { headerToken: mcpAgent.token });
    try {
      const board = toolJson(
        await callTool(client, "board_create", { title: "Events" }),
      );
      await callTool(client, "board_publish", {
        board_id: board.id as string,
        format: "markdown",
        content: DOC,
        expected_version: 0,
      });
      const restCreate = await s.api.post(
        "/api/boards",
        { title: "Events REST", format: "markdown" },
        { token: restAgent.token },
      );
      const restBoard = (await restCreate.json()) as { id: string };
      await s.api.post(
        `/api/boards/${restBoard.id}/publish`,
        { format: "markdown", content: DOC, expected_version: 0 },
        { token: restAgent.token },
      );
      const mcpRow = s.db
        .prepare(
          "SELECT actor, type, board_id, payload FROM events WHERE board_id = ? AND type = 'board.published'",
        )
        .get(board.id as string) as {
        actor: string;
        type: string;
        board_id: string;
        payload: string;
      };
      const restRow = s.db
        .prepare(
          "SELECT actor, type, board_id, payload FROM events WHERE board_id = ? AND type = 'board.published'",
        )
        .get(restBoard.id) as {
        actor: string;
        type: string;
        board_id: string;
        payload: string;
      };
      expect(mcpRow.actor).toBe("event-agent-mcp");
      expect(JSON.parse(mcpRow.payload)).toEqual(JSON.parse(restRow.payload));
    } finally {
      await client.close();
    }
  });

  test("GET and DELETE return 405 with allow: POST", async () => {
    const s = server();
    const agent = await s.createAgent("method-agent");
    const getRes = await s.api.get("/mcp", { token: agent.token });
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get("allow")).toBe("POST");
    const deleteRes = await s.api.delete("/mcp", { token: agent.token });
    expect(deleteRes.status).toBe(405);
    expect(deleteRes.headers.get("allow")).toBe("POST");
  });

  test("POST without application/json is rejected with 415", async () => {
    const s = server();
    const agent = await s.createAgent("media-agent");
    const res = await fetch(`${s.hostUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "text/plain",
      },
      body: "not json",
    });
    expect(res.status).toBe(415);
    expect(await errorCodeOf(res)).toBe("unsupported_media_type");
  });

  test("bodies over 8 MB are rejected with 413", async () => {
    const s = server();
    const agent = await s.createAgent("size-agent");
    const res = await fetch(`${s.hostUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pad: "x".repeat(9 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await errorCodeOf(res)).toBe("payload_too_large");
  });

  test("cross-site writes are rejected with 403", async () => {
    const s = server();
    const agent = await s.createAgent("csrf-agent");
    const res = await fetch(`${s.hostUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe("cross_site_blocked");
  });

  test("notifications return 202 empty and JSON-RPC batch arrays get batch responses", async () => {
    const s = server();
    const agent = await s.createAgent("batch-agent");
    const post = (body: unknown): Promise<Response> =>
      fetch(`${s.hostUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${agent.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    // notification (no id): no response expected
    const notification = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
    // batch array: the SDK transport answers with an array of responses
    const batch = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(batch.status).toBe(200);
    expect(batch.headers.get("content-type")).toBe("application/json");
    const responses = (await batch.json()) as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(2);
    expect(responses.map((r) => r.id).sort()).toEqual([1, 2]);
  });
});

describe("mcp auth", () => {
  test("missing token fails the handshake with 401", async () => {
    const s = server();
    const res = await fetch(`${s.hostUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "anon", version: "0.0.1" },
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("unauthorized");
    let httpCode: number | undefined;
    try {
      await connectClient(s);
    } catch (err) {
      httpCode = (err as { code?: number }).code;
    }
    expect(httpCode).toBe(401);
  });

  test("bad token fails the handshake with 401", async () => {
    const s = server();
    const res = await s.api.post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        token: "bogus-token",
      },
    );
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("unauthorized");
  });

  test("human session token is rejected with 401 (agent-only)", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    const sessionToken = exchangeSession(s.db, exchange);
    const res = await s.api.post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        token: sessionToken,
      },
    );
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("unauthorized");
    let httpCode: number | undefined;
    try {
      await connectClient(s, { headerToken: sessionToken });
    } catch (err) {
      httpCode = (err as { code?: number }).code;
    }
    expect(httpCode).toBe(401);
  });

  test("?token= query param authenticates an agent client", async () => {
    const s = server();
    const agent = await s.createAgent("query-agent");
    const client = await connectClient(s, { queryToken: agent.token });
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(13);
    } finally {
      await client.close();
    }
  });
});
