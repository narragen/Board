import {
  type BoardFilters,
  createBoard,
  endBoard,
  filterBoards,
  getVersion,
  listVersions,
  publishVersion,
  requireBoard,
  restoreVersion,
  VersionNotFound,
} from "../boards.ts";
import { buildBundle } from "../bundle-export.ts";
import { importBoard, readImportBody } from "../bundle-import.ts";
import { boardsWithCounts, countUnresolvedRoots } from "../comments.ts";
import { HttpError, jsonOk } from "../http.ts";
import {
  asEnum,
  asInt,
  asNonNegativeIntString,
  asOptionalString,
  asString,
  asStringArray,
} from "../validate.ts";
import {
  actorName,
  bodyFields,
  type RequestContext,
  type Route,
} from "./route.ts";

const BOARD_FORMATS = ["markdown", "html"] as const;
const BOARD_STATUSES = ["open", "ended"] as const;

function createBoardHandler(_req: Request, ctx: RequestContext): Response {
  const body = bodyFields(ctx.body);
  const board = createBoard(ctx.db, ctx.dataDir, {
    title: asString(body.title, "title"),
    format: asEnum(body.format, "format", BOARD_FORMATS),
    tags:
      body.tags === undefined ? undefined : asStringArray(body.tags, "tags"),
    actor: actorName(ctx),
  });
  return jsonOk(board, 201);
}

function listBoardsHandler(req: Request, ctx: RequestContext): Response {
  const query = new URL(req.url).searchParams;
  const status = query.get("status");
  const tag = query.get("tag");
  const author = query.get("author");
  const filters: BoardFilters = {
    status:
      status === null ? undefined : asEnum(status, "status", BOARD_STATUSES),
    tag: tag === null ? undefined : asString(tag, "tag"),
    author: author === null ? undefined : asString(author, "author"),
  };
  // unresolved root-thread counts ride along on the list (docs/plan.md REST API)
  return jsonOk(filterBoards(boardsWithCounts(ctx.db), filters));
}

// unresolved_comments rides the ENVELOPE (F15), not the board object, so a
// client never re-derives the server's counting rule: it is countUnresolvedRoots,
// the same function behind the list route's column, so the two cannot disagree.
//
// Why the envelope and not inside `board`: the board_get MCP tool returns
// {board, versions} with a plain Board, so decorating `board` here would make
// that field mean two different things depending on the surface you came
// through — the exact MCP/REST divergence A10 exists to close. The list route
// decorates its rows instead because a list has no envelope to hang a per-board
// count on.
function getBoardHandler(_req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  const board = requireBoard(ctx.db, boardId);
  return jsonOk({
    board,
    versions: listVersions(ctx.db, boardId),
    unresolved_comments: countUnresolvedRoots(ctx.db, boardId),
  });
}

// The board check stays even though getVersion below also 404s: it is what
// distinguishes an unknown board (404 board_not_found) from a known board
// without that version (404 version_not_found).
function getVersionHandler(_req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  requireBoard(ctx.db, boardId);
  const n = asNonNegativeIntString(ctx.params.n, "n");
  if (n === undefined) {
    throw new HttpError(
      400,
      "invalid_request",
      "n must be a non-negative integer",
    );
  }
  const version = getVersion(ctx.db, boardId, n);
  if (version === null) {
    throw new VersionNotFound(boardId, n);
  }
  return jsonOk(version);
}

async function publishHandler(
  _req: Request,
  ctx: RequestContext,
): Promise<Response> {
  const body = bodyFields(ctx.body);
  const version = await publishVersion(ctx.db, ctx.dataDir, ctx.params.id, {
    format: asEnum(body.format, "format", BOARD_FORMATS),
    content: asString(body.content, "content"),
    expected_version: asInt(body.expected_version, "expected_version"),
    label: asOptionalString(body.label, "label"),
    note: asOptionalString(body.note, "note"),
    actor: actorName(ctx),
  });
  return jsonOk(version, 201);
}

function endHandler(_req: Request, ctx: RequestContext): Response {
  const board = endBoard(ctx.db, ctx.dataDir, ctx.params.id, actorName(ctx));
  return jsonOk(board);
}

function restoreHandler(_req: Request, ctx: RequestContext): Response {
  const body = bodyFields(ctx.body);
  const version = restoreVersion(ctx.db, ctx.dataDir, ctx.params.id, {
    from_n: asInt(body.from_n, "from_n"),
    expected_version: asInt(body.expected_version, "expected_version"),
    actor: actorName(ctx),
  });
  return jsonOk(version, 201);
}

// Export is a read: bearer-authed like every /api read, and allowed on ended
// boards (end → writes 409, reads stay — docs/plan.md).
function exportHandler(_req: Request, ctx: RequestContext): Response {
  const id = ctx.params.id;
  // no board pre-check: buildBundle gates on requireBoard and throws the same
  // BoardNotFound
  const zip = buildBundle(ctx.db, ctx.dataDir, id);
  // Uint8Array.from copies into an ArrayBuffer-backed body (Response wants
  // Uint8Array<ArrayBuffer>; boards are small — buffering is the deal)
  return new Response(Uint8Array.from(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${id}.zip"`,
    },
  });
}

// Import (M6, docs/plan.md): the raw zip IS the body — no JSON envelope can
// carry binary bytes, hence rawBody. Auth applies to both principals (agent
// or human); the D18 quarantine (re-render, re-verify, strict manifest) is
// all in importBoard (docs/security.md "Import quarantine").
async function importHandler(
  req: Request,
  ctx: RequestContext,
): Promise<Response> {
  const zipBytes = await readImportBody(req);
  const board = await importBoard(
    ctx.db,
    ctx.dataDir,
    zipBytes,
    actorName(ctx),
  );
  return jsonOk(board, 201);
}

export const boardRoutes: Route[] = [
  { method: "GET", path: "/api/boards", handler: listBoardsHandler },
  { method: "POST", path: "/api/boards", handler: createBoardHandler },
  // literal before parameter patterns: "/import" must never read as an :id
  // if a future POST /api/boards/:id route lands
  {
    method: "POST",
    path: "/api/boards/import",
    handler: importHandler,
    rawBody: true,
  },
  { method: "GET", path: "/api/boards/:id", handler: getBoardHandler },
  {
    method: "GET",
    path: "/api/boards/:id/versions/:n",
    handler: getVersionHandler,
  },
  {
    method: "POST",
    path: "/api/boards/:id/publish",
    handler: publishHandler,
  },
  { method: "POST", path: "/api/boards/:id/end", handler: endHandler },
  {
    method: "POST",
    path: "/api/boards/:id/restore",
    handler: restoreHandler,
  },
  { method: "GET", path: "/api/boards/:id/export", handler: exportHandler },
];
