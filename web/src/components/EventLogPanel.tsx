import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { BoardEvent, EventType } from "../../../server/src/domain.ts";
import { errText } from "../../../server/src/err-text.ts";
import { getEvents } from "../api.ts";
import { formatDate } from "../format.ts";

// The known event types (server/src/domain.ts EventType). The filter select is
// closed over this list; unknown future types still render as rows — they just
// are not selectable until added here.
const AUDIT_EVENT_TYPES: EventType[] = [
  "board.created",
  "board.imported",
  "board.published",
  "board.ended",
  "board.restored",
  "comment.created",
  "comment.replied",
  "comment.resolved",
  "asset.added",
  "agent.subscribed",
  "webhook.failed",
];

// Failure-class events (dead-letters) get the red chip so they pop in the
// unfiltered "all" view (docs/plan.md M7: dead-letters visible in audit view).
function isFailureType(type: EventType): boolean {
  return type === "webhook.failed";
}

type TypeFilter = EventType | "all";

// Matches the daemon's default page; explicit so the paging contract does not
// depend on a server-side default changing.
const PAGE_LIMIT = 200;

interface EventLogPanelProps {
  // Poll interval; production is 5s, tests pass a small value (or a huge one
  // to prove no poll interferes with a deterministic sequence).
  pollMs?: number;
}

export function EventLogPanel({ pollMs = 5000 }: EventLogPanelProps) {
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [type, setType] = useState<TypeFilter>("all");
  const [boardId, setBoardId] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Refs mirror the cursor + filters so fetchPage is a stable callback: the
  // poll interval and buttons all share one identity, no resubscription.
  const cursorRef = useRef(0);
  const typeRef = useRef<TypeFilter>("all");
  const boardRef = useRef("");
  const inFlight = useRef(false);
  // Bumped on every filter change; the in-flight fetch detects the bump and
  // re-runs itself with the new filters (its stale page is discarded).
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Forward-paging model: one cursor = "the seq position the log has been
  // read up to". "Load more", "refresh", and the 5s poll are the SAME fetch
  // (since=cursor) — the log only grows forward, so catch-up and history
  // paging cannot diverge. Events render ascending, newest at the BOTTOM:
  // chat-like, the poll appends below, matching the forward-only API (no
  // reverse order or upper-bound param exists to page from the tail).
  const fetchPage = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      // The running fetch already covers this cursor; a filter change is
      // picked up by its generation re-check, so dropping this call is safe.
      return;
    }
    inFlight.current = true;
    try {
      for (;;) {
        const gen = genRef.current;
        const filterType = typeRef.current;
        const page = await getEvents({
          type: filterType === "all" ? undefined : filterType,
          boardId: boardRef.current === "" ? undefined : boardRef.current,
          since: cursorRef.current > 0 ? cursorRef.current : undefined,
          limit: PAGE_LIMIT,
        });
        if (gen !== genRef.current) {
          continue; // filters changed mid-flight — discard and refetch
        }
        if (!mountedRef.current) {
          return;
        }
        setLastSeq(page.last_seq);
        if (page.events.length > 0) {
          cursorRef.current = page.events[page.events.length - 1].seq;
          setEvents((prev) => {
            const known = new Set(prev.map((e) => e.seq));
            return [...prev, ...page.events.filter((e) => !known.has(e.seq))];
          });
        } else {
          // Consumed (or filtered-empty) region: jump the cursor to the
          // global max, else poll/load-more would refetch the same empty
          // page forever — the cursor is a log position, not a row count.
          cursorRef.current = page.last_seq;
        }
        setCursor(cursorRef.current);
        setError(null);
        setLoading(false);
        return;
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(errText(err, "failed to load events"));
        setLoading(false);
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  // Poll-while-visible (M7): the audit view live-tails the log every ~5s but
  // only while document.visibilityState === "visible" — a background tab must
  // not generate request traffic for a local tool nobody is watching. Coming
  // back to the tab triggers an immediate catch-up fetch. The interval dies
  // on unmount, so leaving the view stops all traffic.
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === "visible") {
        void fetchPage();
      }
    };
    const id = setInterval(tick, pollMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [fetchPage, pollMs]);

  // Filters restart the page from the log's head: the server filters rows,
  // so the previously loaded tail may not match the new query.
  const applyFilters = (nextType: TypeFilter, nextBoard: string): void => {
    genRef.current += 1;
    typeRef.current = nextType;
    boardRef.current = nextBoard;
    cursorRef.current = 0;
    setType(nextType);
    setBoardId(nextBoard);
    setEvents([]);
    setExpanded(null);
    setLoading(true);
    void fetchPage();
  };

  const caughtUp = !loading && cursor >= lastSeq;

  return (
    <section className="audit-panel event-log" aria-label="Event log">
      <header className="sidebar-header">
        <span className="sidebar-title">Event log</span>
        <span className="sidebar-count">{events.length} loaded</span>
        <button
          type="button"
          className="pill"
          onClick={() => {
            void fetchPage();
          }}
        >
          refresh
        </button>
      </header>
      <div className="audit-toolbar">
        <select
          aria-label="filter by type"
          value={type}
          onChange={(event) => {
            applyFilters(
              event.currentTarget.value as TypeFilter,
              boardRef.current,
            );
          }}
        >
          <option value="all">all types</option>
          {AUDIT_EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          aria-label="filter by board id"
          placeholder="board id"
          defaultValue={boardId}
          onChange={(event) => {
            applyFilters(typeRef.current, event.currentTarget.value);
          }}
        />
      </div>
      {error !== null && <div className="error">{error}</div>}
      {events.length === 0 ? (
        loading ? (
          <div className="status small">loading…</div>
        ) : (
          <div className="empty small">No events yet.</div>
        )
      ) : (
        <div className="event-scroll">
          <table className="event-table">
            <thead>
              <tr>
                <th>seq</th>
                <th>time</th>
                <th>actor</th>
                <th>type</th>
                <th>board</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <Fragment key={ev.seq}>
                  {/* payload detail is collapsed by default — payloads are
                      wide; a row click toggles its own detail row */}
                  <tr
                    className="event-row"
                    title="toggle payload"
                    onClick={() => {
                      setExpanded(expanded === ev.seq ? null : ev.seq);
                    }}
                  >
                    <td className="event-seq">{ev.seq}</td>
                    <td>{formatDate(ev.ts)}</td>
                    <td>{ev.actor}</td>
                    <td>
                      <span
                        className={`event-type${
                          isFailureType(ev.type) ? " failed" : ""
                        }`}
                      >
                        {ev.type}
                      </span>
                    </td>
                    <td className="event-board">{ev.board_id ?? "—"}</td>
                  </tr>
                  {expanded === ev.seq && (
                    <tr className="event-payload-row">
                      <td colSpan={5}>
                        <pre className="event-payload">
                          {JSON.stringify(ev.payload, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!caughtUp && (
        <button
          type="button"
          className="pill load-more"
          onClick={() => {
            void fetchPage();
          }}
        >
          load more
        </button>
      )}
    </section>
  );
}
