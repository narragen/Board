import type {
  Asset,
  Board,
  BoardEvent,
  Comment,
  EventType,
  Version,
  VersionMeta,
} from "../../server/src/domain.ts";
import {
  clearSessionToken,
  getSessionToken,
  setSessionToken,
} from "./token.ts";

export interface BoardWithVersions {
  board: Board;
  versions: VersionMeta[];
}

export type BoardWithCounts = Board & {
  unresolved_comments: number;
  subscriber_count: number;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    unauthorizedHandler = null;
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionToken();
  const headers = new Headers(init?.headers);
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  // Every write carries the JSON content-type label — the daemon rejects
  // unlabeled writes (415, docs/security.md CSRF defense); browsers default
  // fetch bodies to text/plain. The label rides on bodyless writes too (e.g.
  // DELETE /api/sessions/:id); a caller-set content-type (binary asset upload)
  // is never overridden, and bodyless GET/HEAD stay unlabeled.
  const isWrite =
    init?.method !== undefined &&
    init.method !== "GET" &&
    init.method !== "HEAD";
  if (
    (isWrite || init?.body !== undefined) &&
    headers.get("content-type") === null
  ) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    // the session died — drop it and let the app show the gate (run make open)
    clearSessionToken();
    unauthorizedHandler?.();
    throw new ApiError(401, "unauthorized", "session expired — run make open");
  }
  // 204 (e.g. DELETE /api/sessions/:id) has no body to parse
  if (res.status === 204) {
    return undefined as T;
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `request failed: ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body — keep the fallback code/message
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

// Bootstrap: swap a one-time exchange token for the session bearer. Uses raw
// fetch — a 401 here IS the handshake failing, not a dead session.
export async function exchange(oneTimeToken: string): Promise<string> {
  const res = await fetch("/api/session/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: oneTimeToken }),
  });
  if (!res.ok) {
    throw new ApiError(
      401,
      "unauthorized",
      "exchange token invalid or expired — run make open",
    );
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

// The paste-gate submit essence, extracted so the flow is unit-testable
// without synthetic DOM input events (happy-dom + React 19 dedupe those).
export async function completePasteExchange(
  oneTimeToken: string,
): Promise<void> {
  setSessionToken(await exchange(oneTimeToken));
}

export function listBoards(): Promise<BoardWithCounts[]> {
  return apiFetch<BoardWithCounts[]>("/api/boards");
}

export function getBoard(id: string): Promise<BoardWithVersions> {
  return apiFetch<BoardWithVersions>(`/api/boards/${id}`);
}

export function getVersion(id: string, n: number): Promise<Version> {
  return apiFetch<Version>(`/api/boards/${id}/versions/${n}`);
}

// Restore-to-version (M7, plan.md "Web UI" → board view): republish version
// `fromN` as a new current version — an append-only COPY, history is kept
// (boards.ts restoreVersion). Mirrors the route contract exactly: BOTH fields are
// required (routes/boards.ts asInt 400s on a missing one) — expected_version
// is the caller's known current_version, and a stale one 409s
// version_conflict with the server's current_version in the error body.
export function restoreBoard(
  boardId: string,
  fromN: number,
  expectedVersion: number,
): Promise<Version> {
  return apiFetch<Version>(`/api/boards/${boardId}/restore`, {
    method: "POST",
    body: JSON.stringify({ from_n: fromN, expected_version: expectedVersion }),
  });
}

export interface CreateCommentInput {
  anchor: Comment["anchor"];
  body: string;
  version_n: number;
}

export function createComment(
  boardId: string,
  input: CreateCommentInput,
): Promise<Comment> {
  return apiFetch<Comment>(`/api/boards/${boardId}/comments`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function replyComment(
  commentId: string,
  body: string,
): Promise<Comment> {
  return apiFetch<Comment>(`/api/comments/${commentId}/reply`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export function resolveComment(commentId: string): Promise<Comment> {
  return apiFetch<Comment>(`/api/comments/${commentId}/resolve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

interface CommentsPage {
  comments: Comment[];
  last_seq: number;
}

export function getComments(
  boardId: string,
  since?: number,
): Promise<CommentsPage> {
  const query = since === undefined ? "" : `?since=${since}`;
  return apiFetch<CommentsPage>(`/api/boards/${boardId}/comments${query}`);
}

// EventSource cannot set Authorization headers — the one-time-session token
// rides as a query param on the stream (docs/security.md session model).
export function streamUrl(): string {
  const token = getSessionToken();
  return token === null ? "" : `/api/stream?token=${encodeURIComponent(token)}`;
}

// Binary asset upload (the human drop/attach path): raw image bytes with the
// file's own mime — the daemon's binary variant is keyed on ?board_id= (raw
// bytes cannot also carry a JSON envelope). A non-image or over-cap file is
// rejected server-side; the ApiError surfaces in the composer.
export function uploadAsset(boardId: string, file: File): Promise<Asset> {
  return apiFetch<Asset>(`/api/assets?board_id=${boardId}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
}

// ── Audit view (M7) ────────────────────────────────────────────────────────

export interface EventsPage {
  events: BoardEvent[];
  last_seq: number;
}

export interface EventQuery {
  boardId?: string;
  type?: EventType;
  since?: number;
  limit?: number;
}

// The global event log, ascending by seq within the page; `last_seq` is the
// GLOBAL max seq (the next-poll cursor), not the last returned seq.
export function getEvents(query: EventQuery = {}): Promise<EventsPage> {
  const params = new URLSearchParams();
  if (query.boardId !== undefined) {
    params.set("board_id", query.boardId);
  }
  if (query.type !== undefined) {
    params.set("type", query.type);
  }
  if (query.since !== undefined) {
    params.set("since", String(query.since));
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const qs = params.toString();
  return apiFetch<EventsPage>(`/api/events${qs === "" ? "" : `?${qs}`}`);
}

// Mirrors the server domain SessionInfo (domain.ts, served by routes/sessions.ts): `id` is the row's
// sha256 token-hash PK, `kind` splits live sessions from unexchanged exchange
// rows — the audit listing ships BOTH (docs/security.md "Audit view").
export interface SessionInfo {
  id: string;
  kind: "exchange" | "session";
  created_at: string;
  used_at: string | null;
  expires_at: string | null;
}

export function listSessions(): Promise<SessionInfo[]> {
  return apiFetch<{ sessions: SessionInfo[] }>("/api/sessions").then(
    (page) => page.sessions,
  );
}

export function revokeSession(id: string): Promise<void> {
  return apiFetch<void>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// The audit tokens listing pins its own narrow shape — deliberately NOT the
// domain TokenInfo (scopes/last_used_at): names + lifecycle timestamps only.
// Token values are SHA-256 hashed server-side and never returned (invariant 7,
// docs/security.md) — the UI has nothing to leak and no value column.
export interface TokenRow {
  name: string;
  created_at: string;
  revoked_at?: string | null;
  last_seen?: string | null;
}

export function listTokens(): Promise<TokenRow[]> {
  return apiFetch<{ tokens: TokenRow[] }>("/api/tokens").then(
    (page) => page.tokens,
  );
}
