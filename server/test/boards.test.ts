import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board, Version, VersionMeta } from "../src/domain.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const MD_V1 = [
  "# V1 heading",
  "",
  "First body paragraph.",
  "",
  "| H1 | H2 |",
  "| --- | --- |",
  "| a | b |",
].join("\n");

const MD_V2 = ["# V2 heading", "", "Second body."].join("\n");

const HTML_DOC = [
  "<!doctype html><html><body>",
  '<section data-ba="s1" data-ba-label="Panel"><p>widget</p></section>',
  "</body></html>",
].join("");

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

let current: TestServer | undefined;

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

function server(): TestServer {
  current ??= startTestServer();
  return current;
}

async function setup(): Promise<{ s: TestServer; token: string }> {
  const s = server();
  const agent = await s.createAgent("boards-agent");
  return { s, token: agent.token };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

async function makeBoard(
  s: TestServer,
  token: string,
  opts: { title?: string; format?: "markdown" | "html"; tags?: string[] } = {},
): Promise<Board> {
  const res = await s.api.post(
    "/api/boards",
    {
      title: opts.title ?? "Untitled board",
      format: opts.format ?? "markdown",
      ...(opts.tags === undefined ? {} : { tags: opts.tags }),
    },
    { token },
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Board;
}

async function publishOk(
  s: TestServer,
  token: string,
  boardId: string,
  body: Record<string, unknown>,
): Promise<Version> {
  const res = await s.api.post(`/api/boards/${boardId}/publish`, body, {
    token,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Version;
}

async function unresolvedCount(
  s: TestServer,
  token: string,
  boardId: string,
): Promise<number> {
  const res = await s.api.get(`/api/boards/${boardId}`, { token });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { unresolved_comments: number };
  return body.unresolved_comments;
}

describe("auth", () => {
  test("POST /api/boards without a token is 401", async () => {
    const s = server();
    const res = await s.api.post("/api/boards", {
      title: "Nope",
      format: "markdown",
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("POST /api/boards with a garbage token is 401", async () => {
    const s = server();
    const res = await s.api.post(
      "/api/boards",
      { title: "Nope", format: "markdown" },
      { token: "definitely-not-a-token" },
    );
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("GET /api/health stays public on the wired stack", async () => {
    const s = server();
    const res = await s.api.get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("every non-health endpoint rejects a missing token with 401", async () => {
    const s = server();
    const cases: Array<{ method: "GET" | "POST"; path: string }> = [
      { method: "POST", path: "/api/boards" },
      { method: "GET", path: "/api/boards" },
      { method: "GET", path: "/api/boards/abcdefghij" },
      { method: "GET", path: "/api/boards/abcdefghij/versions/1" },
      { method: "POST", path: "/api/boards/abcdefghij/publish" },
      { method: "POST", path: "/api/boards/abcdefghij/end" },
      { method: "POST", path: "/api/boards/abcdefghij/restore" },
      { method: "GET", path: "/api/events" },
      { method: "GET", path: "/api/boards/abcdefghij/events" },
      { method: "GET", path: "/api/sessions" },
      { method: "GET", path: "/api/tokens" },
    ];
    for (const { method, path } of cases) {
      const res =
        method === "GET" ? await s.api.get(path) : await s.api.post(path, {});
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("unauthorized");
    }
  });
});

describe("POST /api/boards", () => {
  test("creates an open board attributed to the agent", async () => {
    const { s, token } = await setup();
    const res = await s.api.post(
      "/api/boards",
      { title: "Sprint board", format: "markdown", tags: ["plan", "w3"] },
      { token },
    );
    expect(res.status).toBe(201);
    const board = (await res.json()) as Board;
    expect(board.id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(board.title).toBe("Sprint board");
    expect(board.format).toBe("markdown");
    expect(board.status).toBe("open");
    expect(board.tags).toEqual(["plan", "w3"]);
    expect(board.created_by).toBe("boards-agent");
    expect(board.created_at).toMatch(ISO_RE);
    expect(board.current_version).toBe(0);
  });

  test("rejects a missing title with 400", async () => {
    const { s, token } = await setup();
    const res = await s.api.post(
      "/api/boards",
      { format: "markdown" },
      {
        token,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("title");
  });

  test("rejects a format outside the enum with 400", async () => {
    const { s, token } = await setup();
    const res = await s.api.post(
      "/api/boards",
      { title: "T", format: "pdf" },
      { token },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("format");
  });

  test("rejects tags that are not a string array with 400", async () => {
    const { s, token } = await setup();
    for (const tags of ["oops", ["ok", 3], { not: "array" }]) {
      const res = await s.api.post(
        "/api/boards",
        { title: "T", format: "markdown", tags },
        { token },
      );
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    }
  });

  test("rejects a null body with 400", async () => {
    const { s, token } = await setup();
    const res = await s.api.post("/api/boards", null, { token });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });
});

describe("GET /api/boards", () => {
  test("lists all boards newest first when no filters are given", async () => {
    const { s, token } = await setup();
    const first = await makeBoard(s, token, { title: "First" });
    await sleep(10);
    const second = await makeBoard(s, token, { title: "Second" });
    const res = await s.api.get("/api/boards", { token });
    expect(res.status).toBe(200);
    const boards = (await res.json()) as Board[];
    expect(boards.map((board) => board.id)).toEqual([second.id, first.id]);
  });

  test("filters by status and rejects an unknown status", async () => {
    const { s, token } = await setup();
    const open = await makeBoard(s, token, { title: "Open" });
    await sleep(10);
    const ended = await makeBoard(s, token, { title: "Ended" });
    const endRes = await s.api.post(
      `/api/boards/${ended.id}/end`,
      {},
      { token },
    );
    expect(endRes.status).toBe(200);

    const openOnly = await s.api.get("/api/boards?status=open", { token });
    expect(((await openOnly.json()) as Board[]).map((b) => b.id)).toEqual([
      open.id,
    ]);
    const endedOnly = await s.api.get("/api/boards?status=ended", { token });
    expect(((await endedOnly.json()) as Board[]).map((b) => b.id)).toEqual([
      ended.id,
    ]);
    const bogus = await s.api.get("/api/boards?status=bogus", { token });
    expect(bogus.status).toBe(400);
    expect(await errorCode(bogus)).toBe("invalid_request");
  });

  test("filters by tag", async () => {
    const { s, token } = await setup();
    const alpha = await makeBoard(s, token, {
      title: "Alpha",
      tags: ["alpha", "shared"],
    });
    await sleep(10);
    const beta = await makeBoard(s, token, { title: "Beta", tags: ["beta"] });
    const byAlpha = await s.api.get("/api/boards?tag=alpha", { token });
    expect(((await byAlpha.json()) as Board[]).map((b) => b.id)).toEqual([
      alpha.id,
    ]);
    const byBeta = await s.api.get("/api/boards?tag=beta", { token });
    expect(((await byBeta.json()) as Board[]).map((b) => b.id)).toEqual([
      beta.id,
    ]);
    const none = await s.api.get("/api/boards?tag=nope", { token });
    expect(await none.json()).toEqual([]);
  });

  test("flags subscriber_count: every registry row counts, webhook + cursor alike", async () => {
    const s = server();
    const watcher = await s.createAgent("subscriber-webhook-agent");
    const listener = await s.createAgent("subscriber-cursor-agent");
    const watched = await makeBoard(s, watcher.token, { title: "Watched" });
    const lonely = await makeBoard(s, watcher.token, { title: "Lonely" });
    // webhook registration = one subscribers row
    const sub = await s.api.post(
      `/api/boards/${watched.id}/subscribe`,
      { webhook_url: "http://127.0.0.1:9/hook" },
      { token: watcher.token },
    );
    expect(sub.status).toBe(201);
    // a cursor poll by another agent auto-detects a second presence row
    const poll = await s.api.get(`/api/boards/${watched.id}/comments`, {
      token: listener.token,
    });
    expect(poll.status).toBe(200);
    const res = await s.api.get("/api/boards", { token: watcher.token });
    const boards = (await res.json()) as Array<{
      id: string;
      subscriber_count: number;
    }>;
    const counts = new Map(
      boards.map((board) => [board.id, board.subscriber_count]),
    );
    expect(counts.get(watched.id)).toBe(2);
    expect(counts.get(lonely.id)).toBe(0);
  });

  test("filters by author", async () => {
    const s = server();
    const one = await s.createAgent("agent-one");
    const two = await s.createAgent("agent-two");
    await makeBoard(s, one.token, { title: "By one" });
    await sleep(10);
    const byTwo = await makeBoard(s, two.token, { title: "By two" });
    const res = await s.api.get("/api/boards?author=agent-two", {
      token: one.token,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Board[]).map((b) => b.id)).toEqual([
      byTwo.id,
    ]);
  });
});

describe("GET /api/boards/:id", () => {
  test("returns the board with an embedded version list", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token, { title: "With versions" });

    const beforePublish = await s.api.get(`/api/boards/${board.id}`, {
      token,
    });
    expect(beforePublish.status).toBe(200);
    // `board` stays the plain Board (board_get returns the same shape over MCP);
    // the count rides the envelope — F15
    expect(await beforePublish.json()).toEqual({
      board,
      versions: [],
      unresolved_comments: 0,
    });

    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
      label: "first",
    });

    const afterPublish = await s.api.get(`/api/boards/${board.id}`, {
      token,
    });
    const body = (await afterPublish.json()) as {
      board: Board;
      versions: VersionMeta[];
      unresolved_comments: number;
    };
    expect(body.board.id).toBe(board.id);
    expect(body.board.current_version).toBe(1);
    expect(body.versions.length).toBe(1);
    const meta = body.versions[0];
    expect(meta.board_id).toBe(board.id);
    expect(meta.n).toBe(1);
    expect(meta.label).toBe("first");
    expect(meta.created_by).toBe("boards-agent");
    expect("content" in meta).toBe(false);
    expect("source_md" in meta).toBe(false);
  });

  // F15: the count is the server's own rule (countUnresolvedRoots) so clients
  // — `board status` in the CLI above all — never re-derive it and drift.
  test("unresolved_comments counts root threads only, and drops on resolve", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token, { title: "Counted" });
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });

    const rootRes = await s.api.post(
      `/api/boards/${board.id}/comments`,
      {
        anchor: { type: "board" },
        body: "needs a second look",
        version_n: 1,
      },
      { token },
    );
    expect(rootRes.status).toBe(201);
    const root = (await rootRes.json()) as { id: string };
    expect(await unresolvedCount(s, token, board.id)).toBe(1);

    // a reply is not a thread — the count is roots only
    const replyRes = await s.api.post(
      `/api/comments/${root.id}/reply`,
      { body: "looking" },
      { token },
    );
    expect(replyRes.status).toBe(201);
    expect(await unresolvedCount(s, token, board.id)).toBe(1);

    const resolveRes = await s.api.post(
      `/api/comments/${root.id}/resolve`,
      {},
      { token },
    );
    expect(resolveRes.status).toBe(200);
    expect(await unresolvedCount(s, token, board.id)).toBe(0);
  });

  // The seam a mocked unit test on either side cannot see: the detail route's
  // envelope count and the list route's column must be the same number for the
  // same board, or `board status` and `board list` disagree in front of a human.
  test("unresolved_comments agrees with the list route for the same board", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token, { title: "Agreeing" });
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    for (const body of ["one", "two"]) {
      const res = await s.api.post(
        `/api/boards/${board.id}/comments`,
        { anchor: { type: "board" }, body, version_n: 1 },
        { token },
      );
      expect(res.status).toBe(201);
    }

    const detail = await s.api.get(`/api/boards/${board.id}`, { token });
    const detailBody = (await detail.json()) as { unresolved_comments: number };
    const list = await s.api.get("/api/boards", { token });
    const listBody = (await list.json()) as Array<{
      id: string;
      unresolved_comments: number;
    }>;
    const listed = listBody.find((b) => b.id === board.id);
    expect(detailBody.unresolved_comments).toBe(2);
    expect(listed?.unresolved_comments).toBe(detailBody.unresolved_comments);
  });

  test("returns 404 board_not_found for an unknown id", async () => {
    const { s, token } = await setup();
    const res = await s.api.get("/api/boards/zzzzzzzzzz", { token });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });
});

describe("POST /api/boards/:id/publish", () => {
  test("publishes markdown v1 as a full HTML document with data-ba anchors, source, and bundle files", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token, {
      title: "Lifecycle",
      tags: ["w3"],
    });
    const version = await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
      label: "first",
      note: "initial publish",
    });
    expect(version.board_id).toBe(board.id);
    expect(version.n).toBe(1);
    expect(version.label).toBe("first");
    expect(version.note).toBe("initial publish");
    expect(version.created_by).toBe("boards-agent");
    expect(version.created_at).toMatch(ISO_RE);
    expect(version.source_md).toBe(MD_V1);
    expect(version.content.startsWith("<!doctype html>")).toBe(true);
    expect(version.content).toContain('data-ba="b1"');
    expect(version.content).toContain('data-ba="b3r1"');
    expect(version.anchors).toEqual([
      { id: "b1", kind: "heading", label: "V1 heading" },
      { id: "b2", kind: "block" },
      { id: "b3", kind: "block" },
      { id: "b3r1", kind: "row" },
      { id: "b3r2", kind: "row" },
    ]);

    const boardDir = join(s.dataDir, "boards", board.id);
    expect(existsSync(join(boardDir, "versions", "1.html"))).toBe(true);
    expect(readFileSync(join(boardDir, "versions", "1.html"), "utf8")).toBe(
      version.content,
    );
    expect(readFileSync(join(boardDir, "versions", "1.md"), "utf8")).toBe(
      MD_V1,
    );
    const snapshot = JSON.parse(
      readFileSync(join(boardDir, "board.json"), "utf8"),
    ) as Board;
    expect(snapshot.id).toBe(board.id);
    expect(snapshot.current_version).toBe(1);
    const lines = readFileSync(join(boardDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const events = lines.map(
      (line) => JSON.parse(line) as { type: string; actor: string },
    );
    expect(events.map((event) => event.type)).toEqual([
      "board.created",
      "board.published",
    ]);
    for (const event of events) {
      expect(event.actor).toBe("boards-agent");
    }
  });

  test("stores an html-format document with injected data-ba anchors (D18)", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token, {
      title: "Widget",
      format: "html",
      tags: ["ui"],
    });
    const version = await publishOk(s, token, board.id, {
      format: "html",
      content: HTML_DOC,
      expected_version: 0,
    });
    // D18: the stored document is the publish-time id-injected derived doc
    expect(version.content).toBe(
      `<!doctype html><html><head></head><body><section data-ba="s1" data-ba-label="Panel"><p>widget</p></section></body></html>`,
    );
    expect(version.source_md).toBeNull();
    expect(version.anchors).toEqual([
      { id: "s1", kind: "block", label: "Panel" },
    ]);
  });

  test("rejects a stale expected_version with 409 carrying current_version", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    const res = await s.api.post(
      `/api/boards/${board.id}/publish`,
      { format: "markdown", content: MD_V2, expected_version: 0 },
      { token },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; current_version?: number };
    };
    expect(body.error.code).toBe("version_conflict");
    expect(body.error.current_version).toBe(1);
  });

  test("returns 404 board_not_found for an unknown board", async () => {
    const { s, token } = await setup();
    const res = await s.api.post(
      "/api/boards/zzzzzzzzzz/publish",
      { format: "markdown", content: MD_V1, expected_version: 0 },
      { token },
    );
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });

  test("rejects invalid bodies with 400", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const bodies = [
      { format: "markdown", expected_version: 0 },
      { format: "pdf", content: MD_V1, expected_version: 0 },
      { format: "markdown", content: 42, expected_version: 0 },
      { format: "markdown", content: MD_V1, expected_version: "0" },
      { format: "markdown", content: MD_V1 },
    ];
    for (const body of bodies) {
      const res = await s.api.post(`/api/boards/${board.id}/publish`, body, {
        token,
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    }
  });
});

describe("POST /api/boards/:id/end", () => {
  test("ends an open board; reads still work", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    const res = await s.api.post(`/api/boards/${board.id}/end`, {}, { token });
    expect(res.status).toBe(200);
    const ended = (await res.json()) as Board;
    expect(ended.id).toBe(board.id);
    expect(ended.status).toBe("ended");
    expect(ended.current_version).toBe(1);

    const read = await s.api.get(`/api/boards/${board.id}`, { token });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { board: Board }).board.status).toBe(
      "ended",
    );
  });

  test("writes after end are rejected with 409 board_ended", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    expect(
      (await s.api.post(`/api/boards/${board.id}/end`, {}, { token })).status,
    ).toBe(200);

    const publish = await s.api.post(
      `/api/boards/${board.id}/publish`,
      { format: "markdown", content: MD_V2, expected_version: 1 },
      { token },
    );
    expect(publish.status).toBe(409);
    expect(await errorCode(publish)).toBe("board_ended");

    const secondEnd = await s.api.post(
      `/api/boards/${board.id}/end`,
      {},
      { token },
    );
    expect(secondEnd.status).toBe(409);
    expect(await errorCode(secondEnd)).toBe("board_ended");

    const restore = await s.api.post(
      `/api/boards/${board.id}/restore`,
      { from_n: 1, expected_version: 1 },
      { token },
    );
    expect(restore.status).toBe(409);
    expect(await errorCode(restore)).toBe("board_ended");
  });

  test("returns 404 board_not_found for an unknown board", async () => {
    const { s, token } = await setup();
    const res = await s.api.post("/api/boards/zzzzzzzzzz/end", {}, { token });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });
});

describe("POST /api/boards/:id/restore", () => {
  test("restores an old version as a new one on an open board", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V2,
      expected_version: 1,
    });

    const res = await s.api.post(
      `/api/boards/${board.id}/restore`,
      { from_n: 1, expected_version: 2 },
      { token },
    );
    expect(res.status).toBe(201);
    const restored = (await res.json()) as Version;
    expect(restored.board_id).toBe(board.id);
    expect(restored.n).toBe(3);
    expect(restored.label).toBe("restore of v1");
    expect(restored.created_by).toBe("boards-agent");

    const originalRes = await s.api.get(`/api/boards/${board.id}/versions/1`, {
      token,
    });
    const original = (await originalRes.json()) as Version;
    expect(restored.content).toBe(original.content);
    expect(restored.source_md).toBe(original.source_md);
    expect(restored.anchors).toEqual(original.anchors);

    const boardRes = await s.api.get(`/api/boards/${board.id}`, { token });
    expect(
      ((await boardRes.json()) as { board: Board }).board.current_version,
    ).toBe(3);
  });

  test("returns 404 version_not_found for an unknown from_n", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    const res = await s.api.post(
      `/api/boards/${board.id}/restore`,
      { from_n: 9, expected_version: 1 },
      { token },
    );
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("version_not_found");
  });

  test("rejects a stale expected_version with 409 carrying current_version", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    const res = await s.api.post(
      `/api/boards/${board.id}/restore`,
      { from_n: 1, expected_version: 0 },
      { token },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; current_version?: number };
    };
    expect(body.error.code).toBe("version_conflict");
    expect(body.error.current_version).toBe(1);
  });
});

describe("GET /api/boards/:id/versions/:n", () => {
  test("returns the full stored version", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const published = await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
      label: "first",
    });
    const res = await s.api.get(`/api/boards/${board.id}/versions/1`, {
      token,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(published);
  });

  test("returns 404 version_not_found for an unknown n", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    const res = await s.api.get(`/api/boards/${board.id}/versions/99`, {
      token,
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("version_not_found");
  });

  test("rejects a non-numeric n with 400", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const res = await s.api.get(`/api/boards/${board.id}/versions/abc`, {
      token,
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });
});

describe("actor attribution", () => {
  test("created_by and event actor equal the token's agent name", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token, { title: "Attribution" });
    expect(board.created_by).toBe("boards-agent");
    await publishOk(s, token, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
    });
    const res = await s.api.get(`/api/boards/${board.id}/events`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ actor: string; type: string }>;
    };
    expect(body.events.map((event) => event.type)).toEqual([
      "board.created",
      "board.published",
    ]);
    for (const event of body.events) {
      expect(event.actor).toBe("boards-agent");
    }
  });
});

describe("security regressions on the wired stack", () => {
  test("cross-site POST to a wired write route is rejected with 403", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const res = await s.api.post(
      `/api/boards/${board.id}/publish`,
      { format: "markdown", content: MD_V1, expected_version: 0 },
      { token, headers: { "sec-fetch-site": "cross-site" } },
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("cross_site_blocked");
  });

  test("Host: evil.com on a wired route is rejected with 421", async () => {
    const { s, token } = await setup();
    const res = await s.api.get("/api/boards", {
      token,
      headers: { host: "evil.com" },
    });
    expect(res.status).toBe(421);
    expect(await errorCode(res)).toBe("bad_host");
  });

  test("POST to a wired route without JSON content-type is rejected with 415", async () => {
    const s = server();
    const res = await s.api.post("/api/boards");
    expect(res.status).toBe(415);
    expect(await errorCode(res)).toBe("unsupported_media_type");
  });
});

describe("routing on the wired stack", () => {
  test("an unknown /api path is still 404", async () => {
    const s = server();
    const res = await s.api.get("/api/definitely-not-here");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });

  test("a wrong method on a real path returns 405 with Allow", async () => {
    const s = server();
    const del = await s.api.delete("/api/boards", {
      headers: { "content-type": "application/json" },
    });
    expect(del.status).toBe(405);
    expect(await errorCode(del)).toBe("method_not_allowed");
    expect(del.headers.get("allow")).toBe("GET, POST");

    const get = await s.api.get(`/api/boards/abcdefghij/publish`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });
});
