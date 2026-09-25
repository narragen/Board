import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import type { BoardEvent } from "../../server/src/domain.ts";
import type { BoardWithVersions } from "./api.ts";
import {
  createComponentHarness,
  installDom,
  StubEventSource,
} from "./test-dom.ts";
import { clearSessionToken, setSessionToken } from "./token.ts";
import { useBoardStream } from "./use-board-stream.ts";

installDom();

// The real api layer over a stubbed fetch, rather than a mocked ./api.ts: a
// module mock here would leak forward into api.test.ts (bun runs every file in
// one process and mock.restore() does not undo a mock.module). Same shape as
// api.test.ts's own fetch seam, restored after every test for the same reason.
const realFetch = globalThis.fetch;

interface MetaFetch {
  paths: string[];
  status: number;
}
const metaFetch: MetaFetch = { paths: [], status: 200 };

function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    metaFetch.paths.push(String(input));
    if (metaFetch.status !== 200) {
      return new Response(
        JSON.stringify({
          error: { code: "board_not_found", message: "board gone" },
        }),
        {
          status: metaFetch.status,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify(meta("refreshed")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function meta(title: string): BoardWithVersions {
  return {
    board: {
      id: "b1",
      title,
      format: "markdown",
      status: "open",
      tags: [],
      created_by: "agent-1",
      created_at: "2026-09-15T10:00:00.000Z",
      current_version: 2,
    },
    versions: [],
  };
}

const { render, rerender, cleanup } = createComponentHarness();

beforeEach(() => {
  metaFetch.paths.length = 0;
  metaFetch.status = 200;
  StubEventSource.instances = [];
  setSessionToken("sess-ok");
  stubFetch();
});

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  clearSessionToken();
});

// BoardView's wiring: the board meta in state, its setter (the stable reference
// the subscription needs) handed to the hook, and the refresh key rendered so a
// bump is observable.
function Probe({ boardId }: { boardId: string }) {
  const [board, setBoard] = useState<BoardWithVersions | null>(meta("initial"));
  const refreshKey = useBoardStream(boardId, setBoard);
  return createElement(
    "div",
    null,
    createElement("span", { className: "key" }, String(refreshKey)),
    createElement("span", { className: "title" }, board?.board.title ?? "—"),
  );
}

const read = (container: HTMLElement, css: string): string | undefined =>
  container.querySelector(css)?.textContent ?? undefined;

async function emit(over: Partial<BoardEvent> = {}): Promise<void> {
  const event: BoardEvent = {
    seq: 20,
    ts: "2026-09-15T18:30:00.000Z",
    actor: "human",
    type: "comment.created",
    board_id: "b1",
    payload: {},
    ...over,
  };
  const source = StubEventSource.instances.at(-1);
  await act(async () => {
    source?.emit("board", { data: JSON.stringify(event) });
  });
  await act(async () => {});
}

describe("useBoardStream", () => {
  test("an event for this board bumps the refresh key", async () => {
    const container = render(createElement(Probe, { boardId: "b1" }));
    await act(async () => {});
    expect(read(container, "span.key")).toBe("0");
    await emit();
    expect(read(container, "span.key")).toBe("1");
  });

  test("an event for another board is ignored", async () => {
    const container = render(createElement(Probe, { boardId: "b1" }));
    await act(async () => {});
    // GET /stream is not per-board — one connection carries EVERY board's
    // events, so without the board_id filter another board's traffic would
    // refetch this board's comments on every frame
    await emit({ board_id: "b2" });
    expect(read(container, "span.key")).toBe("0");
    await emit({ board_id: "b2", type: "board.published" });
    expect(read(container, "span.key")).toBe("0");
    expect(metaFetch.paths).toEqual([]);
  });

  test("a board.* event refreshes the meta; a comment event does not", async () => {
    const container = render(createElement(Probe, { boardId: "b1" }));
    await act(async () => {});
    await emit({ type: "comment.created" });
    expect(metaFetch.paths).toEqual([]);
    expect(read(container, "span.title")).toBe("initial");
    await emit({ type: "board.restored" });
    expect(metaFetch.paths).toEqual(["/api/boards/b1"]);
    expect(read(container, "span.title")).toBe("refreshed");
  });

  test("a failed meta refresh leaves the last known meta in place", async () => {
    metaFetch.status = 404;
    const container = render(createElement(Probe, { boardId: "b1" }));
    await act(async () => {});
    await emit({ type: "board.ended" });
    expect(metaFetch.paths).toEqual(["/api/boards/b1"]);
    // the stale header is the deliberate outcome, and the refresh key still
    // bumped, so the comment list refetches either way
    expect(read(container, "span.title")).toBe("initial");
    expect(read(container, "span.key")).toBe("1");
  });

  test("no session token, no stream", async () => {
    clearSessionToken();
    render(createElement(Probe, { boardId: "b1" }));
    await act(async () => {});
    expect(StubEventSource.instances).toHaveLength(0);
  });

  test("unmounting closes the stream", async () => {
    render(createElement(Probe, { boardId: "b1" }));
    await act(async () => {});
    const source = StubEventSource.instances.at(-1);
    expect(source?.listeners.size).toBe(1);
    await cleanup();
    // closed: the frames that keep arriving reach nobody
    expect(source?.listeners.size).toBe(0);
  });

  test("a board id change closes the old stream and filters on the new board", async () => {
    const container = render(createElement(Probe, { boardId: "b1" }));
    await act(async () => {});
    const first = StubEventSource.instances.at(-1);
    await act(async () => {
      rerender(createElement(Probe, { boardId: "b2" }));
    });
    expect(StubEventSource.instances).toHaveLength(2);
    expect(first?.listeners.size).toBe(0);
    // b1's traffic is now somebody else's: it must not move this view
    await emit({ board_id: "b1", type: "board.published" });
    expect(read(container, "span.key")).toBe("0");
    expect(metaFetch.paths).toEqual([]);
    await emit({ board_id: "b2", type: "board.published" });
    expect(metaFetch.paths).toEqual(["/api/boards/b2"]);
  });
});
