import type { Database } from "bun:sqlite";
import type { Document, Element } from "happy-dom";
import { Window } from "happy-dom";
import { getAsset } from "./assets.ts";
import {
  getVersion,
  listBoards,
  requireBoard,
  requireOpenBoard,
  StoreError,
  VersionNotFound,
} from "./boards.ts";
import type {
  Actor,
  Anchor,
  Board,
  BoardStatus,
  Comment,
  ImageOverlay,
  Version,
} from "./domain.ts";
import { appendEventDb, type EventInput, mirrorEventFiles } from "./events.ts";
import { shortId } from "./ids.ts";
import { countSubscribersByBoard } from "./webhooks.ts";

export class InvalidAnchor extends StoreError {
  constructor(message: string) {
    super(`invalid anchor: ${message}`);
    this.name = "InvalidAnchor";
  }
}

export class CommentNotFound extends StoreError {
  constructor(commentId: string) {
    super(`comment "${commentId}" not found`);
    this.name = "CommentNotFound";
  }
}

export class CommentBodyRequired extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "CommentBodyRequired";
  }
}

export interface CreateCommentInput {
  anchor: Anchor;
  body: string;
  version_n: number;
  in_reply_to?: string;
  actor: string;
}

interface CommentRow {
  id: string;
  board_id: string;
  version_n: number;
  anchor: string;
  body: string;
  author: string;
  in_reply_to: string | null;
  created_at: string;
  edited_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  seq: number | null;
}

function mapCommentRow(row: CommentRow): Comment {
  return {
    id: row.id,
    board_id: row.board_id,
    version_n: row.version_n,
    seq: row.seq ?? 0,
    anchor: JSON.parse(row.anchor) as Anchor,
    body: row.body,
    author: row.author,
    in_reply_to: row.in_reply_to,
    created_at: row.created_at,
    edited_at: row.edited_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
  };
}

const window = new Window();

// Lookup by iterating [data-ba] elements: agent-supplied ids never touch a
// CSS selector string (injection surface — never build selectors from input).
function findDataBa(doc: Document, id: string): Element | null {
  for (const el of [...doc.body.querySelectorAll("[data-ba]")]) {
    if (el.getAttribute("data-ba") === id) {
      return el;
    }
  }
  return null;
}

// Offsets are informational; the quoted originalText is the re-anchor truth
// (plannotator's block+offset+quote model, docs/plan.md "Data model").
export function validateAnchor(
  db: Database,
  anchor: Anchor,
  version: Version,
): void {
  if (anchor.type === "board") {
    return;
  }
  if (anchor.type === "image") {
    validateImageAnchor(db, anchor, version);
    return;
  }
  const doc = new window.DOMParser().parseFromString(
    version.content,
    "text/html",
  );
  if (anchor.type === "section") {
    if (findDataBa(doc, anchor.section_id) === null) {
      throw new InvalidAnchor(
        `section "${anchor.section_id}" not found in v${version.n}`,
      );
    }
    return;
  }
  if (anchor.type === "row") {
    if (findDataBa(doc, anchor.row_id) === null) {
      throw new InvalidAnchor(
        `row "${anchor.row_id}" not found in v${version.n}`,
      );
    }
    return;
  }
  const section = findDataBa(doc, anchor.section_id);
  if (section === null) {
    throw new InvalidAnchor(
      `section "${anchor.section_id}" not found in v${version.n}`,
    );
  }
  if (!section.textContent.includes(anchor.originalText)) {
    throw new InvalidAnchor(
      `quoted text not found in section "${anchor.section_id}" of v${version.n}`,
    );
  }
}

// Overlay caps on untrusted input: the overlay renders as SVG for every
// viewer of the board, so item counts and label length are bounded — 50 items
// and a 200-char label (a positioned label is terse; there is no precedent
// body cap in this codebase to mirror). Labels over the cap reject.
const MAX_OVERLAY_ITEMS = 50;
const MAX_OVERLAY_TEXT_LENGTH = 200;

// Image anchors reference an asset, not a data-ba id — so unlike section/row/
// text anchors they validate against the assets table: the asset must exist
// and belong to the anchor's own board (cross-board asset refs are the image
// analogue of the cross-board parent check).
function validateImageAnchor(
  db: Database,
  anchor: Extract<Anchor, { type: "image" }>,
  version: Version,
): void {
  const overlay = anchor.overlay;
  if (overlay !== undefined) {
    validateOverlay(overlay);
  }
  const asset = getAsset(db, anchor.asset_id);
  if (asset === null) {
    throw new InvalidAnchor(`asset "${anchor.asset_id}" not found`);
  }
  if (asset.board_id !== version.board_id) {
    throw new InvalidAnchor(
      `asset "${anchor.asset_id}" belongs to a different board`,
    );
  }
}

function inUnitRange(value: number): boolean {
  return value >= 0 && value <= 1;
}

function validateOverlay(overlay: ImageOverlay): void {
  if (overlay.arrows.length > MAX_OVERLAY_ITEMS) {
    throw new InvalidAnchor(
      `overlay has ${overlay.arrows.length} arrows, exceeding the ${MAX_OVERLAY_ITEMS} item cap`,
    );
  }
  for (const arrow of overlay.arrows) {
    if (
      !inUnitRange(arrow.x1) ||
      !inUnitRange(arrow.y1) ||
      !inUnitRange(arrow.x2) ||
      !inUnitRange(arrow.y2)
    ) {
      throw new InvalidAnchor("overlay arrow coordinates must be in [0, 1]");
    }
  }
  if (overlay.boxes.length > MAX_OVERLAY_ITEMS) {
    throw new InvalidAnchor(
      `overlay has ${overlay.boxes.length} boxes, exceeding the ${MAX_OVERLAY_ITEMS} item cap`,
    );
  }
  for (const box of overlay.boxes) {
    if (!inUnitRange(box.x) || !inUnitRange(box.y)) {
      throw new InvalidAnchor("overlay box coordinates must be in [0, 1]");
    }
    if (box.text.length > MAX_OVERLAY_TEXT_LENGTH) {
      throw new InvalidAnchor(
        `overlay box text is ${box.text.length} chars, exceeding the ${MAX_OVERLAY_TEXT_LENGTH} char cap`,
      );
    }
  }
}

const INSERT_COMMENT =
  "INSERT INTO comments (id, board_id, version_n, anchor, body, author, in_reply_to, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

interface CommentFields {
  board_id: string;
  version_n: number;
  anchor: Anchor;
  body: string;
  author: string;
  in_reply_to: string | null;
}

// The atomicity rule for comment writes, in one place: no comment row without
// the event that announced it, so the row and the event commit in the SAME
// transaction and the row carries that event's seq (which is also the cursor
// agents page by). The jsonl mirrors are written AFTER the commit — mirrors
// may lag the db, never lead it (mirrorEventFiles in events.ts). Callers mint
// the id because the event payload names it too.
function insertCommentWithEvent(
  db: Database,
  dataDir: string,
  id: string,
  fields: CommentFields,
  event: EventInput,
): Comment {
  const write = db.transaction(() => {
    const ev = appendEventDb(db, event);
    db.prepare(INSERT_COMMENT).run(
      id,
      fields.board_id,
      fields.version_n,
      JSON.stringify(fields.anchor),
      fields.body,
      fields.author,
      fields.in_reply_to,
      new Date().toISOString(),
      ev.seq,
    );
    return ev;
  });
  const ev = write();
  mirrorEventFiles(dataDir, ev);
  return getComment(db, id) as Comment;
}

// The overlay IS the payload — a root comment anchored to an image with at
// least one drawn arrow or box may have an empty/absent body (forcing text
// produced "." posts in dogfood). Everything else still requires text:
// replies, non-image anchors, and image anchors without overlay items.
// Decision comment lives here (the validation site) rather than a new
// decisions.md entry: this tightens an implementation detail, not the plan.
function overlayCarriesPayload(anchor: Anchor): boolean {
  return (
    anchor.type === "image" &&
    anchor.overlay !== undefined &&
    anchor.overlay.arrows.length + anchor.overlay.boxes.length > 0
  );
}

export function createComment(
  db: Database,
  dataDir: string,
  boardId: string,
  input: CreateCommentInput,
): Comment {
  // comments are writes: ended boards are read-only (docs/plan.md end → writes 409)
  requireOpenBoard(db, boardId);
  const version = getVersion(db, boardId, input.version_n);
  if (version === null) {
    throw new VersionNotFound(boardId, input.version_n);
  }
  validateAnchor(db, input.anchor, version);
  if (input.body.trim().length === 0 && !overlayCarriesPayload(input.anchor)) {
    throw new CommentBodyRequired(
      "comment body must not be empty (only an image anchor with overlay items may post without text)",
    );
  }
  if (input.in_reply_to !== undefined) {
    const parent = getComment(db, input.in_reply_to);
    if (parent === null) {
      throw new CommentNotFound(input.in_reply_to);
    }
    if (parent.board_id !== boardId) {
      throw new InvalidAnchor("parent comment belongs to a different board");
    }
  }
  const id = shortId();
  return insertCommentWithEvent(
    db,
    dataDir,
    id,
    {
      board_id: boardId,
      version_n: input.version_n,
      anchor: input.anchor,
      body: input.body,
      author: input.actor,
      in_reply_to: input.in_reply_to ?? null,
    },
    {
      actor: input.actor,
      type: "comment.created",
      boardId,
      payload: {
        comment_id: id,
        version_n: input.version_n,
        anchor: input.anchor,
      },
    },
  );
}

export function getComment(db: Database, id: string): Comment | null {
  const row = db
    .prepare("SELECT * FROM comments WHERE id = ?")
    .get(id) as CommentRow | null;
  return row === null ? null : mapCommentRow(row);
}

export function listComments(
  db: Database,
  boardId: string,
  since?: number,
): Comment[] {
  const rows =
    since === undefined
      ? (db
          .prepare("SELECT * FROM comments WHERE board_id = ? ORDER BY seq ASC")
          .all(boardId) as CommentRow[])
      : (db
          .prepare(
            "SELECT * FROM comments WHERE board_id = ? AND seq > ? ORDER BY seq ASC",
          )
          .all(boardId, since) as CommentRow[]);
  return rows.map(mapCommentRow);
}

interface ReplyInput {
  body: string;
  actor: string;
}

// Replies inherit the parent's anchor + version_n: a thread stays one anchor.
export function replyComment(
  db: Database,
  dataDir: string,
  commentId: string,
  input: ReplyInput,
): Comment {
  const parent = getComment(db, commentId);
  if (parent === null) {
    throw new CommentNotFound(commentId);
  }
  // replies always carry text — the overlay exemption is root-comments only
  if (input.body.trim().length === 0) {
    throw new CommentBodyRequired("reply body must not be empty");
  }
  requireOpenBoard(db, parent.board_id);
  const id = shortId();
  return insertCommentWithEvent(
    db,
    dataDir,
    id,
    {
      board_id: parent.board_id,
      version_n: parent.version_n,
      anchor: parent.anchor,
      body: input.body,
      author: input.actor,
      in_reply_to: commentId,
    },
    {
      actor: input.actor,
      type: "comment.replied",
      boardId: parent.board_id,
      payload: { comment_id: id, parent_id: commentId },
    },
  );
}

// Idempotent: an already-resolved comment returns as-is, no second event.
export function resolveComment(
  db: Database,
  dataDir: string,
  commentId: string,
  actor: string,
): Comment {
  const comment = getComment(db, commentId);
  if (comment === null) {
    throw new CommentNotFound(commentId);
  }
  if (comment.resolved_at !== null) {
    return comment;
  }
  requireOpenBoard(db, comment.board_id);
  const write = db.transaction(() => {
    const ev = appendEventDb(db, {
      actor,
      type: "comment.resolved",
      boardId: comment.board_id,
      payload: { comment_id: commentId },
    });
    db.prepare(
      "UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?",
    ).run(ev.ts, actor, commentId);
    return ev;
  });
  const ev = write();
  mirrorEventFiles(dataDir, ev);
  return getComment(db, commentId) as Comment;
}

export function countUnresolvedRoots(db: Database, boardId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM comments WHERE board_id = ? AND in_reply_to IS NULL AND resolved_at IS NULL",
    )
    .get(boardId) as { c: number };
  return row.c;
}

export function maxCommentSeq(db: Database, boardId: string): number {
  const row = db
    .prepare("SELECT MAX(seq) AS m FROM comments WHERE board_id = ?")
    .get(boardId) as { m: number | null };
  return row.m ?? 0;
}

// The shared cursor read: board must exist (404 via BoardNotFound), an agent
// poll counts as presence, then the page plus its last_seq cursor. REST
// GET /boards/:id/comments and MCP board_get_comments were byte-identical
// copies of this sequence; THREE surfaces consume it once the M7 audit view
// lands (docs/plan.md) — that third consumer is why this is extracted now.
export function listCommentsPage(
  db: Database,
  boardId: string,
  actor: Actor | undefined,
  since?: number,
): { comments: Comment[]; last_seq: number } {
  requireBoard(db, boardId);
  recordCursorPresence(db, boardId, actor);
  const comments = listComments(db, boardId, since);
  const lastSeq = maxCommentSeq(db, boardId);
  return {
    comments,
    last_seq: comments.length > 0 ? (comments.at(-1)?.seq ?? lastSeq) : lastSeq,
  };
}

export interface BoardWithCommentCounts extends Board {
  unresolved_comments: number;
  subscriber_count: number;
}

// The board list with unresolved root-comment counts + live subscriber
// counts attached (docs/plan.md REST API — the "live subscriber count" claim
// became true with the M7 audit work) — shared by REST GET /boards and MCP
// board_list; the M7 audit view is the planned third consumer (same
// rationale as listCommentsPage).
export function boardsWithCounts(db: Database): BoardWithCommentCounts[] {
  const subscribers = countSubscribersByBoard(db);
  return listBoards(db).map((board) => ({
    ...board,
    unresolved_comments: countUnresolvedRoots(db, board.id),
    subscriber_count: subscribers.get(board.id) ?? 0,
  }));
}

export interface BoardStatusSummary {
  status: "ok";
  boards: { open: number; ended: number };
  subscribers: number;
  board?: {
    id: string;
    status: BoardStatus;
    current_version: number;
    unresolved_comments: number;
  };
}

// The board_status payload. board_status is the one MCP tool with no REST
// counterpart, which is exactly why it belongs here and not in mcp.ts: the
// transport layer runs no SQL of its own, so docs/architecture.md's claim that
// MCP tools "call the same service-layer functions the REST routes call" holds
// for every tool. Lives in comments.ts (not boards.ts) for the same reason
// boardsWithCounts does — it joins boards with comment and subscriber counts,
// and boards.ts must not import either.
export function boardStatusSummary(
  db: Database,
  boardId?: string,
): BoardStatusSummary {
  const boards = listBoards(db);
  let subscribers = 0;
  for (const count of countSubscribersByBoard(db).values()) {
    subscribers += count;
  }
  const summary: BoardStatusSummary = {
    status: "ok",
    boards: {
      open: boards.filter((board) => board.status === "open").length,
      ended: boards.filter((board) => board.status === "ended").length,
    },
    subscribers,
  };
  if (boardId !== undefined) {
    const board = requireBoard(db, boardId);
    summary.board = {
      id: board.id,
      status: board.status,
      current_version: board.current_version,
      unresolved_comments: countUnresolvedRoots(db, board.id),
    };
  }
  return summary;
}

// Cursor reads double as agent presence (docs/plan.md "Subscriptions, callbacks
// & presence"): a poll with an agent token refreshes the cursor subscriber row.
// No-op for human actors. Lives here (not the route layer) so the MCP
// board_get_comments poll counts as presence too.
export function recordCursorPresence(
  db: Database,
  boardId: string,
  actor: Actor | undefined,
): void {
  if (actor?.kind !== "agent") {
    return;
  }
  db.prepare(
    `INSERT INTO subscribers (board_id, agent, kind, last_seq, last_seen)
     VALUES (?, ?, 'cursor', ?, ?)
     ON CONFLICT (board_id, agent, kind)
     DO UPDATE SET last_seq = excluded.last_seq, last_seen = excluded.last_seen`,
  ).run(
    boardId,
    actor.name,
    maxCommentSeq(db, boardId),
    new Date().toISOString(),
  );
}
