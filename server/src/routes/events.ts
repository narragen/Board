import { requireBoard } from "../boards.ts";
import type { BoardEvent } from "../domain.ts";
import { getBoardEvents, getEvents, maxEventSeq } from "../events.ts";
import { jsonOk } from "../http.ts";
import { asNonNegativeIntString } from "../validate.ts";
import type { RequestContext, Route } from "./route.ts";

// Agents persist last_seq as their next cursor: the last returned seq, else
// the caller's since (0 when the channel is empty and no cursor was given).
function lastSeq(events: BoardEvent[], since: number | undefined): number {
  return events.length > 0 ? events[events.length - 1].seq : (since ?? 0);
}

// Audit-view page caps (docs/plan.md M7): a missing limit gets a modest
// page; an over-ask clamps to the max rather than erroring — the UI polls,
// and a 400 would only teach clients to retry with 500.
const AUDIT_DEFAULT_LIMIT = 100;
const AUDIT_MAX_LIMIT = 500;

// The audit view's query route (M7): a pure filter over the events table.
// board_id/type are FILTERS, not resource lookups — an unknown value is an
// empty result, not a 404 (the per-board channel below stays the 404-ing
// resource shape; docs/architecture.md "Audit view").
// last_seq is deliberately maxEventSeq (the GLOBAL max), not lastSeq(): the
// UI's next-poll cursor must advance past everything a filtered or clamped
// page didn't show. That is a semantic difference from the per-board route,
// which keeps the cursor-consumer's page-tail semantics — /api/events is the
// audit substrate, /api/boards/:id/events the agent cursor channel. Agents
// reading the global log is NOT a new exposure: D1/D15 already give them the
// events log (jsonl mirrors + cursors); this endpoint is the query
// convenience the audit UI polls (docs/security.md "Audit view").
function listEventsHandler(req: Request, ctx: RequestContext): Response {
  const query = new URL(req.url).searchParams;
  const since = asNonNegativeIntString(query.get("since"), "since");
  const rawLimit = asNonNegativeIntString(query.get("limit"), "limit");
  const limit =
    rawLimit === undefined
      ? AUDIT_DEFAULT_LIMIT
      : Math.min(rawLimit, AUDIT_MAX_LIMIT);
  const events = getEvents(ctx.db, {
    since,
    limit,
    boardId: query.get("board_id") ?? undefined,
    type: query.get("type") ?? undefined,
  });
  return jsonOk({ events, last_seq: maxEventSeq(ctx.db) });
}

function boardEventsHandler(req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  requireBoard(ctx.db, boardId);
  const since = asNonNegativeIntString(
    new URL(req.url).searchParams.get("since"),
    "since",
  );
  const events = getBoardEvents(ctx.db, boardId, since);
  return jsonOk({ events, last_seq: lastSeq(events, since) });
}

export const eventRoutes: Route[] = [
  { method: "GET", path: "/api/events", handler: listEventsHandler },
  {
    method: "GET",
    path: "/api/boards/:id/events",
    handler: boardEventsHandler,
  },
];
