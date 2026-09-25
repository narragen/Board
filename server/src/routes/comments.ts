import { requireBoard } from "../boards.ts";
import {
  createComment,
  listComments,
  listCommentsPage,
  maxCommentSeq,
  replyComment,
  resolveComment,
} from "../comments.ts";
import type { Comment } from "../domain.ts";
import { serializeFeedback, threadRootOf } from "../feedback.ts";
import { jsonOk } from "../http.ts";
import {
  asAnchor,
  asInt,
  asNonNegativeIntString,
  asOptionalString,
  asString,
} from "../validate.ts";
import {
  actorName,
  bodyFields,
  type RequestContext,
  type Route,
} from "./route.ts";

// The board check runs BEFORE argument parsing, and that ordering is the whole
// point of it. createComment does gate on requireOpenBoard and throws the same
// BoardNotFound — but only after asAnchor/asInt have already rejected a
// malformed body, so without this line an unknown board plus a bad body
// answers 400 invalid_request instead of 404 board_not_found. An agent
// retrying against a torn-down board would be told its anchor is wrong.
// (Sibling handlers that delegate to buildBundle need no such line: it takes
// no arguments to parse, so its own requireBoard is already first.)
function createCommentHandler(_req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  requireBoard(ctx.db, boardId);
  const body = bodyFields(ctx.body);
  const comment = createComment(ctx.db, ctx.dataDir, boardId, {
    anchor: asAnchor(body.anchor, "anchor"),
    // absent body reaches the store's emptiness rule, which allows an
    // overlay-only image annotation (CommentBodyRequired maps to 400)
    body: asOptionalString(body.body, "body") ?? "",
    version_n: asInt(body.version_n, "version_n"),
    in_reply_to: asOptionalString(body.in_reply_to, "in_reply_to"),
    actor: actorName(ctx),
  });
  return jsonOk(comment, 201);
}

function replyHandler(_req: Request, ctx: RequestContext): Response {
  const body = bodyFields(ctx.body);
  const comment = replyComment(ctx.db, ctx.dataDir, ctx.params.id, {
    body: asString(body.body, "body"),
    actor: actorName(ctx),
  });
  return jsonOk(comment, 201);
}

function resolveHandler(_req: Request, ctx: RequestContext): Response {
  const comment = resolveComment(
    ctx.db,
    ctx.dataDir,
    ctx.params.id,
    actorName(ctx),
  );
  return jsonOk(comment);
}

// The cursor-read sequence (board exists → presence → page → last_seq) lives
// in the service layer — the MCP tool is the same call now, and the M7 audit
// view becomes a third thin consumer.
function listCommentsHandler(req: Request, ctx: RequestContext): Response {
  const since = asNonNegativeIntString(
    new URL(req.url).searchParams.get("since"),
    "since",
  );
  return jsonOk(listCommentsPage(ctx.db, ctx.params.id, ctx.actor, since));
}

// Threads touched after `since` render IN FULL (root + all replies) — feedback
// is a catch-up artifact, not a diff.
function threadsTouchedSince(comments: Comment[], since: number): Comment[] {
  const keptRoots = new Set<string>();
  for (const comment of comments) {
    if (comment.seq > since) {
      const root = threadRootOf(comments, comment);
      if (root !== null) {
        keptRoots.add(root.id);
      }
    }
  }
  return comments.filter((comment) => {
    const root = threadRootOf(comments, comment);
    return root !== null && keptRoots.has(root.id);
  });
}

function feedbackHandler(req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  const board = requireBoard(ctx.db, boardId);
  const since = asNonNegativeIntString(
    new URL(req.url).searchParams.get("since"),
    "since",
  );
  const all = listComments(ctx.db, boardId);
  const comments = since === undefined ? all : threadsTouchedSince(all, since);
  return jsonOk({
    feedback: serializeFeedback(board, comments),
    last_seq: maxCommentSeq(ctx.db, boardId),
  });
}

export const commentRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/boards/:id/comments",
    handler: createCommentHandler,
  },
  { method: "POST", path: "/api/comments/:id/reply", handler: replyHandler },
  {
    method: "POST",
    path: "/api/comments/:id/resolve",
    handler: resolveHandler,
  },
  {
    method: "GET",
    path: "/api/boards/:id/comments",
    handler: listCommentsHandler,
  },
  {
    method: "GET",
    path: "/api/boards/:id/feedback",
    handler: feedbackHandler,
  },
];
