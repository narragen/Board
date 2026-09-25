// status (P3-6, promised in the usage text since M1): a quick health read of
// one board. REST against the live daemon like the boards.ts commands (no
// local db — invariant 3, writes go through the daemon), built strictly on
// existing routes. Instance-aware per D20 wave 2 (resolve.ts owns the
// precedence).
import type { Config } from "../../../server/src/config.ts";
import { type RestTarget, restTarget } from "../resolve.ts";
import { renderTable } from "../table.ts";
import { bearer, errorMessage, type FetchLike, parseArgs } from "./rest.ts";
import type { CommandIo } from "./token.ts";

export const STATUS_USAGE = "usage: board status <board_id>";

interface StatusCommandInput {
  config: Config;
  argv: string[];
  io: CommandIo;
  // Seam: tests inject a fake so nothing touches the network (boards.ts
  // fetchImpl pattern).
  fetchImpl?: FetchLike;
}

// Narrow views of the daemon's responses — shapes verified against
// server/src/routes/{boards,events,webhooks}.ts; only consumed fields are
// typed (boards.ts ListRow pattern).
interface BoardView {
  id: string;
  title: string;
  status: string;
  current_version: number;
  created_at: string;
}

// GET /api/boards/:id — the count sits on the envelope beside `board`, not
// inside it (server/src/routes/boards.ts getBoardHandler).
interface BoardDetail {
  board: BoardView;
  unresolved_comments: number;
}

interface EventView {
  type: string;
  ts: string;
}

interface SubscriberView {
  kind: string;
  principal: string;
  last_seq: number;
  last_seen: string;
}

async function runStatus(
  input: StatusCommandInput,
  target: RestTarget,
  boardId: string,
): Promise<number> {
  const { io, fetchImpl } = input;
  const doFetch = fetchImpl ?? fetch;
  const headers = bearer(target.token);

  const boardRes = await doFetch(
    new URL(`/api/boards/${boardId}`, target.baseUrl),
    { headers },
  );
  if (!boardRes.ok) {
    io.stderr(`board: ${await errorMessage(boardRes)}`);
    return 1;
  }
  // The unresolved count comes off the envelope (F15): it is the server's own
  // countUnresolvedRoots, so this column can never disagree with `board list`'s.
  // This used to re-derive the rule from a full comments read, which also made
  // a read-only health command register a cursor poll — status would show up in
  // its own subscribers table.
  const { board, unresolved_comments: unresolved } =
    (await boardRes.json()) as BoardDetail;

  // Board rows carry no ended_at — that timestamp lives on the board.ended
  // event (invariant 4, events are append-only — the log is the audit trail),
  // so read the events route, and only for a board that is actually ended.
  let ended: string | null = null;
  if (board.status === "ended") {
    const eventsRes = await doFetch(
      new URL(`/api/boards/${boardId}/events`, target.baseUrl),
      { headers },
    );
    if (!eventsRes.ok) {
      io.stderr(`board: ${await errorMessage(eventsRes)}`);
      return 1;
    }
    const { events } = (await eventsRes.json()) as { events: EventView[] };
    // endBoard never appends a second board.ended event (boards.ts), so the
    // last match is the end timestamp.
    ended = events.filter((ev) => ev.type === "board.ended").at(-1)?.ts ?? null;
  }

  // Agent-visible: /api/boards/:id/subscribers is plain bearer auth (no scope
  // gating in server/src/auth.ts) returning the merged presence view.
  const subsRes = await doFetch(
    new URL(`/api/boards/${boardId}/subscribers`, target.baseUrl),
    { headers },
  );
  if (!subsRes.ok) {
    io.stderr(`board: ${await errorMessage(subsRes)}`);
    return 1;
  }
  const subscribers = (await subsRes.json()) as SubscriberView[];

  for (const line of renderTable(
    ["FIELD", "VALUE"],
    [
      ["ID", board.id],
      ["TITLE", board.title],
      ["STATUS", board.status],
      ["VERSION", String(board.current_version)],
      ["UNRESOLVED", String(unresolved)],
      ["CREATED", board.created_at],
      ["ENDED", ended ?? "-"],
    ],
  )) {
    io.stdout(line);
  }
  io.stdout("");
  if (subscribers.length === 0) {
    io.stdout("no subscribers");
    return 0;
  }
  for (const line of renderTable(
    ["KIND", "PRINCIPAL", "LAST SEQ", "LAST SEEN"],
    subscribers.map((s) => [
      s.kind,
      s.principal,
      String(s.last_seq),
      s.last_seen,
    ]),
  )) {
    io.stdout(line);
  }
  return 0;
}

export async function runStatusCommand(
  input: StatusCommandInput,
): Promise<number> {
  const parsed = parseArgs(input.argv, 1);
  if (typeof parsed === "string") {
    input.io.stderr(`board: ${parsed}`);
    input.io.stderr(STATUS_USAGE);
    return 1;
  }
  const boardId = parsed.positional[0];
  if (boardId === undefined || boardId.length === 0) {
    input.io.stderr("board: status needs a board id");
    input.io.stderr(STATUS_USAGE);
    return 1;
  }
  // Instance-aware target (D20 wave 2): --instance/BOARD_INSTANCE point the
  // status read at the instance's daemon; none = the shared daemon as before.
  const target = restTarget(input.config, parsed);
  if (typeof target === "string") {
    input.io.stderr(`board: ${target}`);
    input.io.stderr(STATUS_USAGE);
    return 1;
  }
  return runStatus(input, target, boardId);
}
