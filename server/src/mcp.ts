// MCP Streamable HTTP endpoint (M5-lite, D16): thirteen server tools mapping
// 1:1 onto the service layer — the same functions the REST routes call, so the
// event log
// never distinguishes MCP agents from REST agents. Transport is the SDK's
// web-standard server transport in stateless JSON mode: every POST gets a
// fresh server + transport (no sessions), responses are application/json,
// and no SSE stream is ever held open on the daemon. Tool METADATA (names,
// descriptions, schemas) lives in mcp-tools.ts — the manifest the agent-side
// stdio connector also reads (it additionally lists the two connector-local
// tools, D23 D4); this file owns the handlers.
import type { Database } from "bun:sqlite";
import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import { ingestAssetFromPath } from "./assets.ts";
import { resolveActor, resolveRequestToken } from "./auth.ts";
import {
  createBoard,
  endBoard,
  filterBoards,
  listVersions,
  publishVersion,
  requireBoard,
  restoreVersion,
  StoreError,
  VersionConflict,
} from "./boards.ts";
import { buildBundle } from "./bundle-export.ts";
import {
  boardStatusSummary,
  boardsWithCounts,
  listCommentsPage,
  replyComment,
  resolveComment,
} from "./comments.ts";
import type { Actor } from "./domain.ts";
import { errText } from "./err-text.ts";
import { HttpError, readJsonBody } from "./http.ts";
import {
  connectorLocalToolMessage,
  isConnectorLocalName,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
  type McpToolDef,
  type ServerToolName,
} from "./mcp-tools.ts";
import { subscribeWebhook } from "./webhooks.ts";

// MCP export carries the zip base64-encoded through JSON (≈ ×4/3 inflation).
// The daemon's 8 MB body-cap convention bounds it: bigger bundles go through
// REST GET /boards/:id/export, which streams the raw zip — the tool error
// says exactly that.
const MCP_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

interface McpContext {
  db: Database;
  dataDir: string;
  actor: Actor;
}

// Agent-only surface (D16): browser sessions are valid credentials elsewhere
// but never here (docs/security.md — the MCP endpoint is not a browser
// surface). Wraps the shared resolveActor and rejects the human kind —
// agent tokens only, header or ?token= (D13's EventSource rationale applies
// to MCP tooling too).
export function requireMcpActor(req: Request, db: Database): Actor {
  const token = resolveRequestToken(req);
  if (token === null || token.length === 0) {
    throw new HttpError(401, "unauthorized", "missing bearer token");
  }
  const actor = resolveActor(db, token);
  if (actor === null || actor.kind === "human") {
    throw new HttpError(401, "unauthorized", "invalid or revoked token");
  }
  return actor;
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// Store errors are tool results (isError), never JSON-RPC protocol errors —
// the agent reads the message and retries. VersionConflict carries
// current_version so the retry can proceed without a second round-trip.
function toolErrorResult(err: unknown): CallToolResult {
  const message =
    err instanceof VersionConflict
      ? `${err.message} (current_version: ${err.current})`
      : errText(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(
  fn: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolErrorResult(err);
  }
}

// Version metadata only — full content never rides back through MCP (publish
// payloads can be megabytes; the agent already holds what it published).
// content_bytes is the published source's byte length: the same measure the
// store's size cap applies to.
function versionMetaResult(
  version: Awaited<ReturnType<typeof publishVersion>>,
  contentBytes: number,
): CallToolResult {
  return textResult({
    board_id: version.board_id,
    n: version.n,
    label: version.label,
    note: version.note,
    anchors: version.anchors,
    created_by: version.created_by,
    created_at: version.created_at,
    content_bytes: contentBytes,
  });
}

// Handler argument shapes, type-only. The RUNTIME validation is the
// manifest's zod schema (the SDK parses tool arguments against it before the
// callback runs — mcp.js validateToolInput); ToolArgs mirrors it so each
// handler keeps destructured, typed params. Drift between the two surfaces
// as argument-validation failures in the end-to-end tool tests.
interface ToolArgs {
  board_create: {
    title: string;
    format: "markdown" | "html";
    tags?: string[];
  };
  board_publish: {
    board_id: string;
    format: "markdown" | "html";
    content: string;
    expected_version: number;
    label?: string;
    note?: string;
  };
  board_list: { status?: "open" | "ended"; tag?: string; author?: string };
  board_get: { board_id: string };
  board_get_comments: { board_id: string; since: number };
  board_reply: { comment_id: string; body: string };
  board_resolve: { comment_id: string };
  board_restore: {
    board_id: string;
    from_n: number;
    expected_version: number;
  };
  board_end: { board_id: string };
  board_subscribe: {
    board_id: string;
    webhook_url: string;
    webhook_secret?: string;
  };
  board_status: { board_id?: string };
  board_upload_image: { board_id: string; path: string };
  board_export: { board_id: string };
}

// Handlers under the same keys as the manifest, built per-request context.
// publishVersion is the one async service call (the render pipeline); handlers
// await uniformly regardless.
const TOOL_HANDLERS: {
  [K in ServerToolName]: (
    ctx: McpContext,
  ) => (args: ToolArgs[K]) => CallToolResult | Promise<CallToolResult>;
} = {
  board_create:
    (ctx) =>
    ({ title, format, tags }) =>
      run(() =>
        textResult(
          createBoard(ctx.db, ctx.dataDir, {
            title,
            format,
            tags,
            actor: ctx.actor.name,
          }),
        ),
      ),
  board_publish:
    (ctx) =>
    ({ board_id, format, content, expected_version, label, note }) =>
      run(async () => {
        const version = await publishVersion(ctx.db, ctx.dataDir, board_id, {
          format,
          content,
          expected_version,
          label,
          note,
          actor: ctx.actor.name,
        });
        return versionMetaResult(version, Buffer.byteLength(content, "utf8"));
      }),
  board_list:
    (ctx) =>
    ({ status, tag, author }) =>
      run(() =>
        textResult(
          filterBoards(boardsWithCounts(ctx.db), { status, tag, author }),
        ),
      ),
  board_get:
    (ctx) =>
    ({ board_id }) =>
      run(() => {
        const board = requireBoard(ctx.db, board_id);
        return textResult({
          board,
          versions: listVersions(ctx.db, board_id),
        });
      }),
  board_get_comments:
    (ctx) =>
    ({ board_id, since }) =>
      run(() =>
        textResult(listCommentsPage(ctx.db, board_id, ctx.actor, since)),
      ),
  board_reply:
    (ctx) =>
    ({ comment_id, body }) =>
      run(() =>
        textResult(
          replyComment(ctx.db, ctx.dataDir, comment_id, {
            body,
            actor: ctx.actor.name,
          }),
        ),
      ),
  board_resolve:
    (ctx) =>
    ({ comment_id }) =>
      run(() =>
        textResult(
          resolveComment(ctx.db, ctx.dataDir, comment_id, ctx.actor.name),
        ),
      ),
  board_restore:
    (ctx) =>
    ({ board_id, from_n, expected_version }) =>
      run(() =>
        textResult(
          restoreVersion(ctx.db, ctx.dataDir, board_id, {
            from_n,
            expected_version,
            actor: ctx.actor.name,
          }),
        ),
      ),
  board_end:
    (ctx) =>
    ({ board_id }) =>
      run(() =>
        textResult(endBoard(ctx.db, ctx.dataDir, board_id, ctx.actor.name)),
      ),
  board_subscribe:
    (ctx) =>
    ({ board_id, webhook_url, webhook_secret }) =>
      run(() =>
        textResult(
          subscribeWebhook(ctx.db, ctx.dataDir, board_id, {
            webhook_url,
            webhook_secret,
            actor: ctx.actor.name,
          }),
        ),
      ),
  board_status:
    (ctx) =>
    ({ board_id }) =>
      run(() => textResult(boardStatusSummary(ctx.db, board_id))),
  board_upload_image:
    (ctx) =>
    ({ board_id, path }) =>
      run(() => {
        const asset = ingestAssetFromPath(ctx.db, ctx.dataDir, board_id, {
          path,
          actor: ctx.actor.name,
        });
        return textResult({
          asset_id: asset.id,
          board_id: asset.board_id,
          mime: asset.mime,
          size: asset.size,
          embed_markdown: `![image](asset:${asset.id})`,
          embed_html: `<img src="/assets/${asset.id}">`,
        });
      }),
  board_export:
    (ctx) =>
    ({ board_id }) =>
      run(() => {
        // no board pre-check: buildBundle gates on requireBoard itself
        const zip = buildBundle(ctx.db, ctx.dataDir, board_id);
        if (zip.byteLength > MCP_EXPORT_MAX_BYTES) {
          throw new StoreError(
            `bundle for board "${board_id}" is ${zip.byteLength} bytes, over the ${MCP_EXPORT_MAX_BYTES} byte MCP export cap — use REST GET /api/boards/${board_id}/export`,
          );
        }
        return textResult({
          board_id,
          bytes: zip.byteLength,
          encoding: "base64",
          data: Buffer.from(zip).toString("base64"),
        });
      }),
};

function registerBoardTools(server: McpServer, ctx: McpContext): void {
  for (const tool of SERVER_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      // Bounded cast: registerTool's overloads infer the callback's arg type
      // from a schema expression at the call site, but the dynamic loop hands
      // it the widened ZodRawShape. TOOL_HANDLERS is keyed by the same
      // ServerToolName union as the manifest, and the SDK validates arguments
      // against the manifest schema before the callback runs — the connector
      // tests pin schema/handler agreement against the live tools/list.
      TOOL_HANDLERS[tool.name](ctx) as unknown as ToolCallback<ZodRawShape>,
    );
  }
}

export function handleMcpNonPost(): Response {
  // Stateless endpoint: no GET SSE stream and no sessions to DELETE
  // (Streamable HTTP spec — 405 for both, Allow: POST).
  return new Response(
    JSON.stringify({
      error: {
        code: "method_not_allowed",
        message: "MCP endpoint accepts POST only",
      },
    }),
    {
      status: 405,
      headers: { allow: "POST", "content-type": "application/json" },
    },
  );
}

// The daemon's registrable tools: the shared manifest minus the two
// connector-local tools (D23 D4) — they never register here, so the
// daemon's tools/list advertises exactly what it can execute.
const SERVER_TOOLS = MCP_TOOLS.filter(
  (tool): tool is McpToolDef & { name: ServerToolName } =>
    tool.connectorLocal !== true,
);

// D23 D4: a direct tools/call for a connector-local tool (board_servers /
// board_connect) on the daemon surface gets the same isError envelope the
// SDK emits for unknown tools, but with the honest "connector-local" message
// naming the fix. Notifications (no id) fall through — the transport
// consumes them silently, as it would any unknown-tool notification.
function connectorLocalCallResponse(body: unknown): Response | null {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    (body as { method?: unknown }).method !== "tools/call" ||
    (body as { id?: unknown }).id === undefined
  ) {
    return null;
  }
  const params = (body as { params?: unknown }).params;
  const name =
    typeof params === "object" && params !== null
      ? (params as { name?: unknown }).name
      : undefined;
  if (typeof name !== "string" || !isConnectorLocalName(name)) {
    return null;
  }
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: (body as { id: unknown }).id,
      result: {
        content: [{ type: "text", text: connectorLocalToolMessage(name) }],
        isError: true,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function handleMcpPost(
  req: Request,
  ctx: McpContext,
): Promise<Response> {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });
  registerBoardTools(server, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  // Read through readJsonBody so the 8 MB cap applies before the transport
  // sees the bytes; an empty body is left for the transport to reject as a
  // JSON-RPC parse error.
  const body = await readJsonBody(req);
  const local = connectorLocalCallResponse(body);
  if (local !== null) {
    return local;
  }
  return transport.handleRequest(req, { parsedBody: body });
}
