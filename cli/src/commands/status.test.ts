import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "../../../server/src/config.ts";
import { runStatusCommand, STATUS_USAGE } from "./status.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-cli-status-test-"));
  dirs.push(dir);
  return dir;
}

function testConfig() {
  return makeConfig({
    BOARD_DATA_DIR: tempDir(),
    BOARD_HOST: "127.0.0.1",
    BOARD_PORT: "7800",
  });
}

// boards.test.ts's capture pattern: every request is recorded and answered
// from `routes` — nothing touches a network.
function capture(routes: (path: string) => Response): {
  out: string[];
  err: string[];
  requests: Array<{ url: string; init?: RequestInit }>;
  run(
    argv: string[],
    env?: Record<string, string | undefined>,
  ): Promise<number>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const path = String(url).replace(/^http:\/\/127\.0\.0\.1:7800/, "");
    return Promise.resolve(routes(path));
  };
  const savedToken = process.env.BOARD_TOKEN;
  return {
    out,
    err,
    requests,
    async run(argv, env = {}) {
      // assigning undefined to process.env stringifies it — delete instead
      if (env.BOARD_TOKEN === undefined) {
        delete process.env.BOARD_TOKEN;
      } else {
        process.env.BOARD_TOKEN = env.BOARD_TOKEN;
      }
      try {
        return await runStatusCommand({
          config: testConfig(),
          argv,
          io: {
            stdout: (text) => {
              out.push(text);
            },
            stderr: (text) => {
              err.push(text);
            },
          },
          fetchImpl,
        });
      } finally {
        if (savedToken === undefined) {
          delete process.env.BOARD_TOKEN;
        } else {
          process.env.BOARD_TOKEN = savedToken;
        }
      }
    },
  };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

// Mocks of the real daemon response shapes (server/src/routes/*.ts).
const BOARD_ID = "abc123def9";

const OPEN_BOARD = {
  id: BOARD_ID,
  title: "Sprint notes",
  format: "markdown",
  status: "open",
  tags: [],
  created_by: "agent",
  created_at: "2026-09-10T08:15:00.000Z",
  current_version: 4,
};

const SUBSCRIBERS = [
  {
    id: null,
    board_id: BOARD_ID,
    principal: "cli",
    kind: "cursor",
    webhook_url: null,
    last_seq: 12,
    last_seen: "2026-09-15T10:00:00.000Z",
  },
  {
    id: "wh-1",
    board_id: BOARD_ID,
    principal: "ci-bot",
    kind: "webhook",
    webhook_url: "http://127.0.0.1:9000/hook",
    last_seq: 9,
    last_seen: "2026-09-15T09:00:00.000Z",
  },
];

function boardRoutes(board: typeof OPEN_BOARD): (path: string) => Response {
  return (path) => {
    if (path === `/api/boards/${BOARD_ID}`) {
      // unresolved_comments rides the detail envelope (F15) — the CLI prints
      // the server's count and never re-derives it from a comments read.
      return okJson({ board, versions: [], unresolved_comments: 2 });
    }
    if (path === `/api/boards/${BOARD_ID}/subscribers`) {
      return okJson(SUBSCRIBERS);
    }
    if (path === `/api/boards/${BOARD_ID}/events`) {
      return okJson({ events: [], last_seq: 0 });
    }
    return okJson({ error: { code: "no_mock", message: path } });
  };
}

describe("board status", () => {
  test("renders the health table and the subscribers table with bearer auth", async () => {
    const cap = capture(boardRoutes(OPEN_BOARD));
    const code = await cap.run([BOARD_ID], { BOARD_TOKEN: "tok-123" });
    expect(code).toBe(0);
    expect(cap.err).toEqual([]);
    // one request per surface: board, subscribers — no events fetch for an
    // open board, and no comments fetch at all (F15: the count rides the
    // detail envelope, so status never registers a cursor poll of its own)
    expect(cap.requests.map((r) => r.url)).toEqual([
      `http://127.0.0.1:7800/api/boards/${BOARD_ID}`,
      `http://127.0.0.1:7800/api/boards/${BOARD_ID}/subscribers`,
    ]);
    expect(
      new Headers(cap.requests[0]?.init?.headers).get("authorization"),
    ).toBe("Bearer tok-123");
    expect(cap.out[0]).toContain("FIELD");
    expect(cap.out).toContain("ID          abc123def9");
    expect(cap.out).toContain("TITLE       Sprint notes");
    expect(cap.out).toContain("STATUS      open");
    expect(cap.out).toContain("VERSION     4");
    expect(cap.out).toContain("UNRESOLVED  2");
    expect(cap.out).toContain("CREATED     2026-09-10T08:15:00.000Z");
    expect(cap.out.join("\n")).toContain("ENDED");
    const subHeader = cap.out.find((line) => line.startsWith("KIND"));
    expect(subHeader).toContain("PRINCIPAL");
    expect(subHeader).toContain("LAST SEQ");
    expect(subHeader).toContain("LAST SEEN");
    const hookRow = cap.out.find((line) => line.includes("ci-bot"));
    expect(hookRow).toContain("webhook");
    expect(hookRow).toContain("2026-09-15T09:00:00.000Z");
  });

  test("an ended board reads the end timestamp from the board.ended event", async () => {
    const cap = capture((path) => {
      if (path === `/api/boards/${BOARD_ID}/events`) {
        return okJson({
          events: [
            { seq: 1, ts: "2026-09-10T08:15:00.000Z", type: "board.created" },
            { seq: 9, ts: "2026-09-16T10:00:00.000Z", type: "board.ended" },
          ],
          last_seq: 9,
        });
      }
      return boardRoutes({ ...OPEN_BOARD, status: "ended" })(path);
    });
    const code = await cap.run([BOARD_ID], { BOARD_TOKEN: "t" });
    expect(code).toBe(0);
    expect(cap.requests.map((r) => r.url)).toContain(
      `http://127.0.0.1:7800/api/boards/${BOARD_ID}/events`,
    );
    expect(cap.out).toContain("STATUS      ended");
    expect(cap.out).toContain("ENDED       2026-09-16T10:00:00.000Z");
  });

  test("an open board shows an empty ENDED field without fetching events", async () => {
    const cap = capture(boardRoutes(OPEN_BOARD));
    const code = await cap.run([BOARD_ID], { BOARD_TOKEN: "t" });
    expect(code).toBe(0);
    expect(cap.requests.some((r) => r.url.endsWith("/events"))).toBe(false);
    expect(cap.out).toContain("ENDED       -");
  });

  test("an empty presence view prints the none line", async () => {
    const cap = capture((path) => {
      if (path === `/api/boards/${BOARD_ID}/subscribers`) {
        return okJson([]);
      }
      return boardRoutes(OPEN_BOARD)(path);
    });
    const code = await cap.run([BOARD_ID], { BOARD_TOKEN: "t" });
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("no subscribers");
  });

  test("a 404 surfaces the daemon's error message and stops after one request", async () => {
    const cap = capture(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "board_not_found",
              message: 'board "nope" not found',
            },
          }),
          { status: 404 },
        ),
    );
    const code = await cap.run(["nope"], { BOARD_TOKEN: "t" });
    expect(code).toBe(1);
    expect(cap.requests).toHaveLength(1);
    expect(cap.err.join("\n")).toContain("not found");
  });

  test("no token anywhere: usage error, no request, exit 1", async () => {
    const cap = capture(boardRoutes(OPEN_BOARD));
    const code = await cap.run([BOARD_ID]);
    expect(code).toBe(1);
    expect(cap.requests).toHaveLength(0);
    expect(cap.err.join("\n")).toContain("no token");
    expect(cap.err.join("\n")).toContain("make token add");
    expect(cap.err.join("\n")).toContain(STATUS_USAGE);
  });

  test("a missing board id prints usage and exits 1 without a request", async () => {
    const cap = capture(boardRoutes(OPEN_BOARD));
    const code = await cap.run([], { BOARD_TOKEN: "t" });
    expect(code).toBe(1);
    expect(cap.requests).toHaveLength(0);
    expect(cap.err.join("\n")).toContain("status needs a board id");
    expect(cap.err.join("\n")).toContain(STATUS_USAGE);
  });

  test("--token wins over BOARD_TOKEN", async () => {
    const cap = capture(boardRoutes(OPEN_BOARD));
    const code = await cap.run(["--token", "flag-token", BOARD_ID], {
      BOARD_TOKEN: "env-token",
    });
    expect(code).toBe(0);
    expect(
      new Headers(cap.requests[0]?.init?.headers).get("authorization"),
    ).toBe("Bearer flag-token");
  });
});
