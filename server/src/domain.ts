// Domain types per docs/plan.md "Data model" — defined once, imported everywhere (style guide).

export type BoardFormat = "markdown" | "html";
export type BoardStatus = "open" | "ended";

export interface Board {
  id: string;
  title: string;
  format: BoardFormat;
  status: BoardStatus;
  tags: string[];
  created_by: string;
  created_at: string;
  current_version: number;
}

export interface VersionMeta {
  board_id: string;
  n: number;
  label: string | null;
  note: string | null;
  anchors: ExtractedAnchor[];
  created_by: string;
  created_at: string;
}

export interface Version extends VersionMeta {
  content: string;
  source_md: string | null;
}

// Assets are board-scoped image files (docs/plan.md "Image annotation"): the
// file lives in the board bundle (boards/<id>/assets/<file>), the row is the
// index that serving (GET /assets/:id) resolves across boards.
export type AssetSource = "copy" | "binary";

export interface Asset {
  id: string;
  board_id: string;
  file: string;
  mime: string;
  size: number;
  source: AssetSource;
  created_by: string;
  created_at: string;
}

// Anchors extracted from a published document (data-ba ids); comment anchors reference these.
export interface ExtractedAnchor {
  id: string;
  kind: "block" | "heading" | "row";
  label?: string;
}

// Comment anchor variants per docs/plan.md (plannotator's block+offset+quote model).
export type Anchor =
  | BoardAnchor
  | SectionAnchor
  | TextAnchor
  | RowAnchor
  | ImageAnchor;

export interface BoardAnchor {
  type: "board";
}

export interface SectionAnchor {
  type: "section";
  section_id: string;
}

export interface TextAnchor {
  type: "text";
  section_id: string;
  originalText: string;
  startOffset: number;
  endOffset: number;
}

export interface RowAnchor {
  type: "row";
  section_id: string;
  row_id: string;
}

export interface ImageAnchor {
  type: "image";
  asset_id: string;
  overlay?: ImageOverlay;
}

export interface ImageOverlay {
  arrows: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  boxes: Array<{ x: number; y: number; text: string }>;
}

export interface Comment {
  id: string;
  board_id: string;
  version_n: number;
  seq: number;
  anchor: Anchor;
  body: string;
  author: string;
  in_reply_to: string | null;
  created_at: string;
  edited_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

export type EventType =
  | "board.created"
  | "board.imported"
  | "board.published"
  | "board.ended"
  | "board.restored"
  | "comment.created"
  | "comment.replied"
  | "comment.resolved"
  | "asset.added"
  | "agent.subscribed"
  | "webhook.failed";

export interface BoardEvent {
  seq: number;
  ts: string;
  actor: string;
  type: EventType;
  board_id: string | null;
  payload: Record<string, unknown>;
}

// Only the kinds that are actually written: cursor polls and webhook
// registrations stamp subscribers rows. The schema's `sse` kind (plan.md data
// model) was never written — the stream is global while presence rows are
// board-scoped, so there is no board to stamp — and the kind is removed from
// the domain (D19); the v1 CHECK constraint keeps it (migrations are
// immutable history), nothing writes it.
export type SubscriberKind = "cursor" | "webhook";

export interface Subscriber {
  id: string | null;
  board_id: string;
  principal: string;
  kind: SubscriberKind;
  webhook_url: string | null;
  last_seq: number;
  last_seen: string;
}

export interface TokenInfo {
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// Session-inventory row for the M7 audit view (docs/security.md "Audit view").
// Lifecycle metadata only. `id` is the token_hash (the row's PK — a session
// has no other stable key): exposing the sha256 reveals nothing usable since
// the token material is 256-bit random, and the plaintext never survives
// minting (invariant 7).
export interface SessionInfo {
  id: string;
  kind: "exchange" | "session";
  created_at: string;
  used_at: string | null;
  expires_at: string | null;
}

export interface Actor {
  kind: "human" | "agent";
  name: string;
}
