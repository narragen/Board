import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, useRef } from "react";
import type { Board, Version } from "../../server/src/domain.ts";
import type { BoardWithVersions } from "./api.ts";
import * as boardMount from "./board-mount.ts";
import * as mermaidModule from "./mermaid.ts";
import { createComponentHarness, installDom } from "./test-dom.ts";
import { useBoardDocument } from "./use-board-document.ts";

installDom();

// bun 1.4.2 runs every test file in one process, and a module mock leaks
// FORWARD into every later file — mock.restore() does not undo a mock.module
// (verified: BoardView.test.tsx's html mount tests fail if this file leaves
// these two mocked). api.test.ts guards the same hazard for global fetch.
// Capture the real modules before mocking, hand them back when this file ends.
const realBoardMount = { ...boardMount };
const realMermaid = { ...mermaidModule };
afterAll(() => {
  mock.module("./board-mount.ts", () => realBoardMount);
  mock.module("./mermaid.ts", () => realMermaid);
});

// Both collaborators are mocked at the module boundary, because what these
// tests are about is the hook's ORDERING and its abort: the mount promise has
// to settle when the test says so, and a mermaid render has to be a call the
// test can count. (bun 1.4.2 mock() exposes no call log — hand-rolled
// recorders, as in BoardView.test.tsx.)
interface MountCall {
  content: string;
  container: HTMLElement;
  resolve: () => void;
}
const mountCalls: MountCall[] = [];
mock.module("./board-mount.ts", () => ({
  mountBoardDocument: (content: string, container: HTMLElement) =>
    new Promise<void>((resolve) => {
      mountCalls.push({ content, container, resolve });
    }),
}));

const mermaidCalls: Array<{ root: HTMLElement; isCancelled: () => boolean }> =
  [];
mock.module("./mermaid.ts", () => ({
  renderMermaidBlocks: async (
    root: HTMLElement,
    isCancelled: () => boolean,
  ) => {
    mermaidCalls.push({ root, isCancelled });
  },
}));

const { render, rerender, cleanup } = createComponentHarness();
afterEach(async () => {
  await cleanup();
  mountCalls.length = 0;
  mermaidCalls.length = 0;
});

function boardData(format: Board["format"]): BoardWithVersions {
  return {
    board: {
      id: "b1",
      title: "Plan",
      format,
      status: "open",
      tags: [],
      created_by: "agent-1",
      created_at: "2026-09-15T10:00:00.000Z",
      current_version: 2,
    },
    versions: [],
  };
}

function versionAt(n: number): Version {
  return {
    board_id: "b1",
    n,
    label: null,
    note: null,
    anchors: [],
    created_by: "agent-1",
    created_at: "2026-09-15T10:00:00.000Z",
    content: `<html><body>v${n}</body></html>`,
    source_md: null,
  };
}

// The container the hook works over, wired exactly as BoardView wires it.
function Probe({
  version,
  data,
}: {
  version: Version | null;
  data: BoardWithVersions | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useBoardDocument(ref, version, data);
  return createElement("div", { ref, className: "board-content" });
}

const content = (container: HTMLElement): HTMLElement =>
  container.querySelector("div.board-content") as HTMLElement;

describe("useBoardDocument", () => {
  test("a markdown board renders its diagrams in place and never mounts", async () => {
    const container = render(
      createElement(Probe, {
        version: versionAt(2),
        data: boardData("markdown"),
      }),
    );
    await act(async () => {});
    expect(mountCalls).toHaveLength(0);
    expect(mermaidCalls).toHaveLength(1);
    expect(mermaidCalls[0].root).toBe(content(container));
    expect(mermaidCalls[0].isCancelled()).toBe(false);
  });

  test("a markdown version switch cancels the render it superseded", async () => {
    const data = boardData("markdown");
    render(createElement(Probe, { version: versionAt(2), data }));
    await act(async () => {});
    const superseded = mermaidCalls[0];
    await act(async () => {
      rerender(createElement(Probe, { version: versionAt(1), data }));
    });
    // mermaid.ts polls this between its own awaits — a true reading is what
    // stops it drawing into content that has already been replaced
    expect(superseded.isCancelled()).toBe(true);
    expect(mermaidCalls).toHaveLength(2);
    expect(mermaidCalls[1].isCancelled()).toBe(false);
  });

  test("an html board mounts first and renders diagrams only once the mount resolves (D26)", async () => {
    const version = versionAt(2);
    const container = render(
      createElement(Probe, { version, data: boardData("html") }),
    );
    await act(async () => {});
    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0].content).toBe(version.content);
    expect(mountCalls[0].container).toBe(content(container));
    // the mount is still in flight — nothing may be drawn into it yet
    expect(mermaidCalls).toHaveLength(0);
    await act(async () => {
      mountCalls[0].resolve();
    });
    expect(mermaidCalls).toHaveLength(1);
    expect(mermaidCalls[0].root).toBe(content(container));
  });

  test("a version switch mid-mount aborts the superseded sequence", async () => {
    const data = boardData("html");
    render(createElement(Probe, { version: versionAt(2), data }));
    await act(async () => {});
    expect(mountCalls).toHaveLength(1);
    // the switch lands BEFORE the first mount resolves: that effect is torn
    // down and a second mount starts
    await act(async () => {
      rerender(createElement(Probe, { version: versionAt(1), data }));
    });
    expect(mountCalls).toHaveLength(2);
    // the superseded mount resolving into a container that now holds the other
    // version must draw nothing
    await act(async () => {
      mountCalls[0].resolve();
    });
    expect(mermaidCalls).toHaveLength(0);
    // …while the live mount still does
    await act(async () => {
      mountCalls[1].resolve();
    });
    expect(mermaidCalls).toHaveLength(1);
  });

  test("an unmount mid-mount aborts the sequence", async () => {
    render(
      createElement(Probe, { version: versionAt(2), data: boardData("html") }),
    );
    await act(async () => {});
    expect(mountCalls).toHaveLength(1);
    await cleanup();
    await act(async () => {
      mountCalls[0].resolve();
    });
    expect(mermaidCalls).toHaveLength(0);
  });

  test("nothing runs before the board and its version are both loaded", async () => {
    render(createElement(Probe, { version: null, data: boardData("html") }));
    render(createElement(Probe, { version: versionAt(2), data: null }));
    await act(async () => {});
    expect(mountCalls).toHaveLength(0);
    expect(mermaidCalls).toHaveLength(0);
  });
});
