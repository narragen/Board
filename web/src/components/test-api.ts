import { mock } from "bun:test";
import type {
  Anchor,
  Board,
  BoardEvent,
  Comment,
  Version,
  VersionMeta,
} from "../../../server/src/domain.ts";
import type {
  CreateCommentInput,
  EventQuery,
  SessionInfo,
  TokenRow,
} from "../api.ts";

// Shared component-test fixtures + the ../api.ts test double, used by every
// component test file that renders through the api layer.
//
// bun runs every test file in ONE process with ONE module registry (verified
// bun 1.4.2): this module body evaluates once for the whole run, and a
// mock.module installed by one file is still installed for every LATER file —
// mock.restore() does not undo it. So the recorder arrays below are shared
// state, and installApiMock resets every one of them at each file's load. The
// same hazard the other way round: a test file that mocks ../api.ts
// DIFFERENTLY must hand the real module back when it is done, or it answers
// api.test.ts's calls (api.test.ts guards the identical hazard for global
// fetch).

export const versionCalls: Array<[string, number]> = [];
export const exchangeCalls: string[] = [];
export const uploadedAssets: Array<{ boardId: string; file: File }> = [];
export const getCommentsCalls: string[] = [];
export const createdComments: Array<{
  boardId: string;
  input: CreateCommentInput;
}> = [];
export const replied: Array<[string, string]> = [];
export const resolvedIds: string[] = [];

// upload failures are flipped per test — a mutable holder, since the mock
// closure below must always see the current value
export const uploadFailures: { error: Error | null } = { error: null };

// What listBoards rejects with next, if anything. Typed `unknown` on purpose:
// the case worth a fixture is a rejection that is NOT an Error, where the
// caller's domain fallback is the only text a human gets (use-load.ts
// fallbackMessage → errText's `fallback`, server/src/err-text.ts).
export const listBoardsFailure: { thrown: unknown } = { thrown: null };

// What getBoard / getVersion reject with next, if anything: the board view's
// error state has no other way in, and the two loads carry DIFFERENT fallback
// messages, so each needs its own switch. Same mutable-holder shape as
// uploadFailures.
export const getBoardFailure: { thrown: unknown } = { thrown: null };
export const getVersionFailure: { thrown: unknown } = { thrown: null };

// Held loads: holdLoad(key) parks every call for that key until the returned
// release() runs. It is the only way to land a resolve AFTER the effect that
// started it was superseded — a board id change, a version switch, an unmount —
// which is what the loads' `alive` guards exist for. Keys are `board:<id>` and
// `version:<id>:<n>`.
const holds = new Map<string, Promise<void>>();

export function holdLoad(key: string): () => void {
  let release = (): void => {};
  holds.set(
    key,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return () => {
    holds.delete(key);
    release();
  };
}

// Audit view (M7): getEvents records its query object and pops the next page
// off eventPages (empty queue → empty page, so untouched tests see "No events
// yet."). Sessions/tokens read their mutable fixture arrays at call time;
// revokeSession mutates sessionsList so the post-revoke refetch is
// server-faithful and deterministic.
export const eventQueries: EventQuery[] = [];
export const eventPages: Array<{ events: BoardEvent[]; last_seq: number }> = [];
export const sessionsList: SessionInfo[] = [];
export const revokeCalls: string[] = [];
export const tokensList: TokenRow[] = [];

// Restore-to-version (M7): restoreBoard records its call args (the route
// contract is from_n + expected_version) and failures are flipped per test —
// same mutable-holder pattern as uploadFailures. A recorded restore makes the
// subsequent getBoard server-faithful: current_version advances and the
// "restore of vN" pill exists (that refetch is what the SSE board.restored
// event triggers). restoreAttempts records EVERY call — including ones the
// failure switch rejects — so tests can count POSTs, not successes.
export const restoredBoards: Array<{
  boardId: string;
  fromN: number;
  expectedVersion: number;
}> = [];
export const restoreAttempts: Array<{
  boardId: string;
  fromN: number;
  expectedVersion: number;
}> = [];
export const restoreFailures: { error: Error | null } = { error: null };

const MD_BOARD: Board & {
  unresolved_comments: number;
  subscriber_count: number;
} = {
  id: "b1",
  title: "Decision brief",
  format: "markdown",
  status: "open",
  tags: ["plan"],
  created_by: "agent-1",
  created_at: "2026-09-15T10:00:00.000Z",
  current_version: 2,
  unresolved_comments: 2,
  subscriber_count: 3,
};

export const TEXT_ANCHOR: Anchor = {
  type: "text",
  section_id: "b2",
  originalText: "beta",
  startOffset: 6,
  endOffset: 10,
};

const COMMENT_ROOT: Comment = {
  id: "cm1",
  board_id: "b1",
  version_n: 2,
  seq: 10,
  anchor: TEXT_ANCHOR,
  body: "The intro should mention the cache.",
  author: "human",
  in_reply_to: null,
  created_at: "2026-09-15T18:00:00.000Z",
  edited_at: null,
  resolved_at: null,
  resolved_by: null,
};

const COMMENT_REPLY: Comment = {
  ...COMMENT_ROOT,
  id: "cm2",
  seq: 11,
  body: "Fixed in v2.",
  author: "agent-1",
  in_reply_to: "cm1",
  anchor: TEXT_ANCHOR,
};

const COMMENT_RESOLVED: Comment = {
  ...COMMENT_ROOT,
  id: "cm3",
  seq: 12,
  anchor: { type: "section", section_id: "b1" },
  body: "Done.",
  resolved_at: "2026-09-15T19:00:00.000Z",
  resolved_by: "human",
};

export const IMAGE_ANCHOR: Anchor = {
  type: "image",
  asset_id: "assetImg01",
  overlay: {
    arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
    boxes: [{ x: 0.5, y: 0.1, text: "watch this" }],
  },
};

const IMAGE_COMMENT: Comment = {
  ...COMMENT_ROOT,
  id: "cm-img",
  seq: 13,
  anchor: IMAGE_ANCHOR,
  body: "The arrow points at the regression.",
};

const commentFixture: Comment[] = [
  COMMENT_ROOT,
  COMMENT_REPLY,
  COMMENT_RESOLVED,
  IMAGE_COMMENT,
];

// an overlay-only annotation arrives with an empty body (the overlay is the
// payload) — the thread must read fine with the anchor affordance alone
const EMPTY_BODY_COMMENTS: Comment[] = [
  {
    ...IMAGE_COMMENT,
    id: "cm-img-empty",
    seq: 14,
    body: "",
  },
];

const VERSIONS: VersionMeta[] = [
  {
    board_id: "b1",
    n: 1,
    label: null,
    note: null,
    anchors: [],
    created_by: "agent-1",
    created_at: "2026-09-15T10:00:00.000Z",
  },
  {
    board_id: "b1",
    n: 2,
    label: "after review",
    note: null,
    anchors: [],
    created_by: "agent-1",
    created_at: "2026-09-15T11:00:00.000Z",
  },
];

// what a restore appends server-side (boards.ts: label "restore of vN", actor
// is the session's "human")
const RESTORED_META: VersionMeta = {
  board_id: "b1",
  n: 3,
  label: "restore of v1",
  note: null,
  anchors: [],
  created_by: "human",
  created_at: "2026-09-15T19:30:00.000Z",
};

const MD_VERSION: Version = {
  board_id: "b1",
  n: 2,
  label: "after review",
  note: null,
  content:
    '<!doctype html><html><body><h1 data-ba="b1">Plan</h1><p data-ba="b2">alpha beta gamma</p><pre class="mermaid">graph TD</pre><table data-ba="b3"><tbody><tr data-ba="b3r1"><td>one</td></tr></tbody></table><p data-ba="b4"><img src="/assets/assetImg01" alt="shot"></p></body></html>',
  source_md: "# Plan",
  anchors: [],
  created_by: "agent-1",
  created_at: "2026-09-15T11:00:00.000Z",
};

// Full agent documents (head styles + body + scripts) as the publish
// pipeline now stores them (D18): ids injected server-side, scripts kept.
function htmlDoc(heading: string, style: string): string {
  return [
    "<!doctype html><html><head><title>Dashboard</title>",
    `<style>${style}</style>`,
    "</head><body>",
    '<section data-ba="s-header" data-ba-label="Header">',
    `<h1>${heading}</h1></section>`,
    "<p>unlabeled tail</p>",
    // D26: html boards render mermaid too — the block sits AFTER the external
    // script so the test proves rendering waits for the mount to resolve
    '<pre class="mermaid" data-ba="b-diagram">graph TD; A--&gt;B;</pre>',
    '<script src="/libs/chart-4.4.9.umd.min.js"></script>',
    "<script>window.__dashMounted = true;</script>",
    "</body></html>",
  ].join("");
}

const HTML_V1 = htmlDoc("Dashboard v1", ".dash-v1 { color: red; }");
const HTML_V2 = htmlDoc("Dashboard v2", ".dash-note { color: purple; }");

const HTML_VERSION: Version = {
  board_id: "b-html",
  n: 2,
  label: null,
  note: null,
  content: HTML_V2,
  source_md: null,
  anchors: [],
  created_by: "agent-1",
  created_at: "2026-09-15T11:00:00.000Z",
};

const HTML_COMMENTS: Comment[] = [
  {
    ...COMMENT_ROOT,
    anchor: { type: "section", section_id: "s-header" },
  },
];

export function installApiMock(): void {
  versionCalls.length = 0;
  exchangeCalls.length = 0;
  uploadedAssets.length = 0;
  getCommentsCalls.length = 0;
  createdComments.length = 0;
  replied.length = 0;
  resolvedIds.length = 0;
  uploadFailures.error = null;
  listBoardsFailure.thrown = null;
  eventQueries.length = 0;
  eventPages.length = 0;
  sessionsList.length = 0;
  revokeCalls.length = 0;
  tokensList.length = 0;
  restoredBoards.length = 0;
  restoreAttempts.length = 0;
  restoreFailures.error = null;
  getBoardFailure.thrown = null;
  getVersionFailure.thrown = null;
  holds.clear();
  mock.module("../api.ts", () => ({
    listBoards: async () => {
      if (listBoardsFailure.thrown !== null) {
        throw listBoardsFailure.thrown;
      }
      return [MD_BOARD];
    },
    getBoard: async (id: string) => {
      await holds.get(`board:${id}`);
      if (getBoardFailure.thrown !== null) {
        throw getBoardFailure.thrown;
      }
      if (id === "b-html") {
        return {
          board: {
            ...MD_BOARD,
            id: "b-html",
            format: "html",
            title: "Dashboard",
          },
          versions: VERSIONS,
        };
      }
      if (id === "b-ended") {
        return {
          board: { ...MD_BOARD, status: "ended" as const },
          versions: VERSIONS,
        };
      }
      if (restoredBoards.some((call) => call.boardId === id)) {
        return {
          board: { ...MD_BOARD, current_version: 3 },
          versions: [...VERSIONS, RESTORED_META],
        };
      }
      return { board: MD_BOARD, versions: VERSIONS };
    },
    getVersion: async (id: string, n: number) => {
      versionCalls.push([id, n]);
      await holds.get(`version:${id}:${n}`);
      if (getVersionFailure.thrown !== null) {
        throw getVersionFailure.thrown;
      }
      if (id === "b-html") {
        return { ...HTML_VERSION, n, content: n === 1 ? HTML_V1 : HTML_V2 };
      }
      // faithful n — a restore lands the view on the new current version and
      // this is what its fetch returns
      return { ...MD_VERSION, n };
    },
    exchange: async (token: string) => {
      exchangeCalls.push(token);
      return `session-for-${token}`;
    },
    getComments: async (boardId: string) => {
      getCommentsCalls.push(boardId);
      const comments =
        boardId === "b-html"
          ? HTML_COMMENTS
          : boardId === "b-empty"
            ? EMPTY_BODY_COMMENTS
            : commentFixture;
      return {
        comments,
        last_seq: comments.at(-1)?.seq ?? 0,
      };
    },
    createComment: async (boardId: string, input: CreateCommentInput) => {
      createdComments.push({ boardId, input });
      return { ...COMMENT_ROOT, id: "cm-new", body: input.body, seq: 99 };
    },
    replyComment: async (commentId: string, body: string) => {
      replied.push([commentId, body]);
      return { ...COMMENT_REPLY, id: "cm-r", body };
    },
    resolveComment: async (commentId: string) => {
      resolvedIds.push(commentId);
      return { ...COMMENT_RESOLVED, id: commentId };
    },
    uploadAsset: async (boardId: string, file: File) => {
      if (uploadFailures.error !== null) {
        throw uploadFailures.error;
      }
      uploadedAssets.push({ boardId, file });
      return {
        id: "uploadedAsset",
        board_id: boardId,
        file: "uploadedAsset.png",
        mime: file.type,
        size: 64,
        source: "binary" as const,
        created_by: "human",
        created_at: "2026-09-15T20:00:00.000Z",
      };
    },
    restoreBoard: async (
      boardId: string,
      fromN: number,
      expectedVersion: number,
    ) => {
      restoreAttempts.push({ boardId, fromN, expectedVersion });
      if (restoreFailures.error !== null) {
        throw restoreFailures.error;
      }
      restoredBoards.push({ boardId, fromN, expectedVersion });
      // the 201 body IS the new current version (boards.ts restoreVersion)
      return { ...MD_VERSION, n: 3, label: `restore of v${fromN}` };
    },
    streamUrl: () => "/api/stream?token=stub",
    onUnauthorized: () => () => {},
    ApiError: class ApiError extends Error {},
    getEvents: async (query: EventQuery = {}) => {
      eventQueries.push(query);
      return eventPages.shift() ?? { events: [], last_seq: 0 };
    },
    listSessions: async () => [...sessionsList],
    revokeSession: async (id: string) => {
      revokeCalls.push(id);
      // server-faithful: a revoked session row disappears from the listing
      const i = sessionsList.findIndex((session) => session.id === id);
      if (i >= 0) {
        sessionsList.splice(i, 1);
      }
    },
    listTokens: async () => [...tokensList],
  }));
}
