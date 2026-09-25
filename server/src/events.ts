import type { Database, SQLQueryBindings } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BoardEvent, EventType } from "./domain.ts";

// Exported because boards.ts's shared commitVersion takes a pre-built event:
// the caller names type/payload, commitVersion owns WHEN it commits (in-tx).
export interface EventInput {
  actor: string;
  type: EventType;
  boardId?: string;
  payload?: Record<string, unknown>;
}

interface EventRow {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  board_id: string | null;
  payload: string;
}

const DEFAULT_EVENT_LIMIT = 200;

export function appendEventDb(db: Database, ev: EventInput): BoardEvent {
  const row = db
    .prepare(
      "INSERT INTO events (ts, actor, type, board_id, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq, ts, actor, type, board_id, payload",
    )
    .get(
      new Date().toISOString(),
      ev.actor,
      ev.type,
      ev.boardId ?? null,
      JSON.stringify(ev.payload ?? {}),
    ) as EventRow;
  const event = mapEventRow(row);
  emit(event);
  return event;
}

// db row first, file mirrors second: on a crash the jsonl files can lag the db
// (a missing tail line) but never lead it (a line whose seq never committed).
export function mirrorEventFiles(dataDir: string, event: BoardEvent): void {
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(join(dataDir, "events.jsonl"), line);
  if (event.board_id !== null) {
    const boardDir = join(dataDir, "boards", event.board_id);
    mkdirSync(boardDir, { recursive: true });
    appendFileSync(join(boardDir, "events.jsonl"), line);
  }
}

export function appendEvent(
  db: Database,
  dataDir: string,
  ev: EventInput,
): BoardEvent {
  const event = appendEventDb(db, ev);
  mirrorEventFiles(dataDir, event);
  return event;
}

type EventCallback = (ev: BoardEvent) => void;
const callbacks = new Set<EventCallback>();

// Live subscribers (SSE). Callbacks run on a microtask so they fire after the
// surrounding db transaction commits (bun:sqlite transactions are synchronous).
// SSE is best-effort (docs/architecture.md) — cursors are the reliable channel.
export function onEvent(callback: EventCallback): () => void {
  callbacks.add(callback);
  return () => {
    callbacks.delete(callback);
  };
}

function emit(event: BoardEvent): void {
  if (callbacks.size === 0) {
    return;
  }
  const snapshot = event;
  queueMicrotask(() => {
    for (const callback of callbacks) {
      callback(snapshot);
    }
  });
}

interface GetEventsOptions {
  since?: number;
  boardId?: string;
  // exact match — the audit view's dead-letter filter is type=webhook.failed
  type?: string;
  limit?: number;
}

export function getEvents(
  db: Database,
  opts: GetEventsOptions = {},
): BoardEvent[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (opts.since !== undefined) {
    where.push("seq > ?");
    params.push(opts.since);
  }
  if (opts.boardId !== undefined) {
    where.push("board_id = ?");
    params.push(opts.boardId);
  }
  if (opts.type !== undefined) {
    where.push("type = ?");
    params.push(opts.type);
  }
  params.push(opts.limit ?? DEFAULT_EVENT_LIMIT);
  const sql = `
    SELECT seq, ts, actor, type, board_id, payload FROM events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY seq ASC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params) as EventRow[];
  return rows.map(mapEventRow);
}

export function getBoardEvents(
  db: Database,
  boardId: string,
  since?: number,
): BoardEvent[] {
  return getEvents(db, { boardId, since });
}

// Bundle export's audit snapshot needs EVERY row of the board, not a cursor
// page — the 200 default is a polling page size, not a truth guarantee.
export function getBoardEventsUnbounded(
  db: Database,
  boardId: string,
): BoardEvent[] {
  return getEvents(db, { boardId, limit: Number.MAX_SAFE_INTEGER });
}

// The audit view's next-poll cursor is the GLOBAL max seq, never the page's
// last row: a filtered or clamped page must still advance the cursor past
// the events it didn't show, and an empty tail must not strand the poll at
// a stale seq (server/test/events-api.test.ts pins this distinction).
export function maxEventSeq(db: Database): number {
  const row = db.prepare("SELECT MAX(seq) AS m FROM events").get() as {
    m: number | null;
  };
  return row.m ?? 0;
}

function mapEventRow(row: EventRow): BoardEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    actor: row.actor,
    type: row.type as EventType,
    board_id: row.board_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}
