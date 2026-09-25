import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createExchangeToken } from "../src/sessions.ts";
import {
  type HttpClient,
  startTestServer,
  type TestServer,
} from "./helpers.ts";

const MD = `# Plan

alpha beta gamma

| A | B |
| --- | --- |
| one | two |
`;

let s: TestServer;
let agent: { name: string; token: string };
let commenter: { name: string; token: string };
let boardId: string;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface CommentJson {
  id: string;
  board_id: string;
  version_n: number;
  seq: number;
  anchor: Record<string, unknown>;
  body: string;
  author: string;
  in_reply_to: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

beforeAll(async () => {
  s = startTestServer();
  agent = await s.createAgent("publisher");
  commenter = await s.createAgent("commenter");
  const create = await s.api.post(
    "/api/boards",
    { title: "Comment flow", format: "markdown", tags: ["m3"] },
    { token: agent.token },
  );
  const board = await json<{ id: string }>(create);
  boardId = board.id;
  const publish = await s.api.post(
    `/api/boards/${boardId}/publish`,
    { format: "markdown", content: MD, expected_version: 0 },
    { token: agent.token },
  );
  expect(publish.status).toBe(201);
});

afterAll(async () => {
  await s.stop();
});

describe("comments API", () => {
  test("happy path: comment → reply → resolve → read back", async () => {
    const created = await s.api.post(
      `/api/boards/${boardId}/comments`,
      {
        anchor: {
          type: "text",
          section_id: "b2",
          originalText: "beta",
          startOffset: 6,
          endOffset: 10,
        },
        body: "The intro should mention the cache.",
        version_n: 1,
      },
      { token: commenter.token },
    );
    expect(created.status).toBe(201);
    const root = await json<CommentJson>(created);
    expect(root.author).toBe("commenter");
    expect(root.version_n).toBe(1);
    expect(root.seq).toBeGreaterThan(0);
    expect(root.anchor).toEqual({
      type: "text",
      section_id: "b2",
      originalText: "beta",
      startOffset: 6,
      endOffset: 10,
    });

    const replyRes = await s.api.post(
      `/api/comments/${root.id}/reply`,
      { body: "Fixed in the next version." },
      { token: agent.token },
    );
    expect(replyRes.status).toBe(201);
    const reply = await json<CommentJson>(replyRes);
    expect(reply.author).toBe("publisher");
    expect(reply.in_reply_to).toBe(root.id);
    expect(reply.anchor).toEqual(root.anchor);

    const resolveRes = await s.api.post(
      `/api/comments/${root.id}/resolve`,
      {},
      { token: commenter.token },
    );
    expect(resolveRes.status).toBe(200);
    const resolved = await json<CommentJson>(resolveRes);
    expect(resolved.resolved_at).not.toBe(null);
    expect(resolved.resolved_by).toBe("commenter");

    const listRes = await s.api.get(`/api/boards/${boardId}/comments`, {
      token: agent.token,
    });
    expect(listRes.status).toBe(200);
    const list = await json<{ comments: CommentJson[]; last_seq: number }>(
      listRes,
    );
    expect(list.comments).toHaveLength(2);
    expect(list.comments.map((c) => c.seq)).toEqual(
      list.comments.map((c) => c.seq).sort((a, b) => a - b),
    );
    expect(list.last_seq).toBe(list.comments.at(-1)?.seq ?? -1);
  });

  test("feedback renders the feedback grammar", async () => {
    const res = await s.api.get(`/api/boards/${boardId}/feedback`, {
      token: agent.token,
    });
    expect(res.status).toBe(200);
    const body = await json<{ feedback: string; last_seq: number }>(res);
    expect(body.feedback).toContain(
      `# Feedback: "Comment flow" (${boardId}, v1)`,
    );
    expect(body.feedback).toContain('## 1. RESOLVED — text b2: "beta"');
    expect(body.feedback).toContain("> The intro should mention the cache.");
    expect(body.feedback).toContain("— commenter, ");
    expect(body.feedback).toContain("- 1.1 publisher, ");
    expect(body.feedback).toContain("Unresolved: 0 of 1 threads.");
  });

  test("401 without a token", async () => {
    const res = await s.api.post(`/api/boards/${boardId}/comments`, {
      anchor: { type: "board" },
      body: "x",
      version_n: 1,
    });
    expect(res.status).toBe(401);
  });

  test("404s: unknown board, version, and comment", async () => {
    const boardRes = await s.api.post(
      "/api/boards/nosuch/comments",
      { anchor: { type: "board" }, body: "x", version_n: 0 },
      { token: agent.token },
    );
    expect(boardRes.status).toBe(404);
    expect((await json<{ error: { code: string } }>(boardRes)).error.code).toBe(
      "board_not_found",
    );

    const versionRes = await s.api.post(
      `/api/boards/${boardId}/comments`,
      { anchor: { type: "board" }, body: "x", version_n: 9 },
      { token: agent.token },
    );
    expect(versionRes.status).toBe(404);
    expect(
      (await json<{ error: { code: string } }>(versionRes)).error.code,
    ).toBe("version_not_found");

    const replyRes = await s.api.post(
      "/api/comments/nosuch/reply",
      { body: "x" },
      { token: agent.token },
    );
    expect(replyRes.status).toBe(404);
    expect((await json<{ error: { code: string } }>(replyRes)).error.code).toBe(
      "comment_not_found",
    );
  });

  // The existing 404 test sends a well-formed body, so it passes either way.
  // This one pins the ORDERING: the board check must run before argument
  // parsing, or an agent retrying against a torn-down board is told its anchor
  // is malformed instead of that the board is gone.
  test("unknown board beats a malformed body: 404, not 400", async () => {
    const res = await s.api.post(
      "/api/boards/nosuch/comments",
      { body: "x" },
      { token: agent.token },
    );
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      "board_not_found",
    );
  });

  test("400 invalid anchor: bogus section id", async () => {
    const res = await s.api.post(
      `/api/boards/${boardId}/comments`,
      {
        anchor: { type: "section", section_id: "b99" },
        body: "x",
        version_n: 1,
      },
      { token: agent.token },
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      "invalid_anchor",
    );
  });

  test("400 invalid_request: malformed anchor shape", async () => {
    const res = await s.api.post(
      `/api/boards/${boardId}/comments`,
      { anchor: { type: "wat" }, body: "x", version_n: 1 },
      { token: agent.token },
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      "invalid_request",
    );
  });

  test("ended board rejects comments, replies, and resolves with 409", async () => {
    const endRes = await s.api.post(
      `/api/boards/${boardId}/end`,
      {},
      { token: agent.token },
    );
    expect(endRes.status).toBe(200);
    const commentRes = await s.api.post(
      `/api/boards/${boardId}/comments`,
      { anchor: { type: "board" }, body: "late", version_n: 1 },
      { token: agent.token },
    );
    expect(commentRes.status).toBe(409);
    const listRes = await s.api.get(`/api/boards/${boardId}/comments`, {
      token: agent.token,
    });
    const list = await json<{ comments: CommentJson[] }>(listRes);
    const root = list.comments[0];
    const replyRes = await s.api.post(
      `/api/comments/${root.id}/reply`,
      { body: "late" },
      { token: agent.token },
    );
    expect(replyRes.status).toBe(409);
    expect((await json<{ error: { code: string } }>(replyRes)).error.code).toBe(
      "board_ended",
    );
    const secondRoot =
      list.comments.find((c) => c.resolved_at === null) ?? root;
    const resolveRes = await s.api.post(
      `/api/comments/${secondRoot.id}/resolve`,
      {},
      { token: agent.token },
    );
    expect(resolveRes.status).toBe(409);
  });

  test("resolve is idempotent over HTTP", async () => {
    const other = await makeBoard("Idempotent", agent.token, s.api);
    const created = await s.api.post(
      `/api/boards/${other}/comments`,
      { anchor: { type: "board" }, body: "resolve twice", version_n: 1 },
      { token: commenter.token },
    );
    const root = await json<CommentJson>(created);
    const first = await s.api.post(
      `/api/comments/${root.id}/resolve`,
      {},
      { token: commenter.token },
    );
    const second = await s.api.post(
      `/api/comments/${root.id}/resolve`,
      {},
      { token: commenter.token },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const again = await json<CommentJson>(second);
    expect(again.resolved_at).toBe(
      (await json<CommentJson>(first)).resolved_at,
    );
    const eventsRes = await s.api.get(`/api/boards/${other}/events`, {
      token: agent.token,
    });
    const events = await json<{
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    }>(eventsRes);
    const resolves = events.events.filter(
      (ev) =>
        ev.type === "comment.resolved" && ev.payload.comment_id === root.id,
    );
    expect(resolves).toHaveLength(1);
  });

  test("since= returns only newer comments with a stable last_seq", async () => {
    const board = await makeBoard("Since flow", agent.token, s.api);
    const c1 = await postComment(s.api, board, agent.token, "one");
    const c2 = await postComment(s.api, board, agent.token, "two");
    const c3 = await postComment(s.api, board, agent.token, "three");
    const res = await s.api.get(
      `/api/boards/${board}/comments?since=${c1.seq}`,
      {
        token: agent.token,
      },
    );
    const body = await json<{ comments: CommentJson[]; last_seq: number }>(res);
    expect(body.comments.map((c) => c.id)).toEqual([c2.id, c3.id]);
    expect(body.last_seq).toBe(c3.seq);
    const tail = await s.api.get(
      `/api/boards/${board}/comments?since=${c3.seq}`,
      { token: agent.token },
    );
    const tailBody = await json<{ comments: CommentJson[]; last_seq: number }>(
      tail,
    );
    expect(tailBody.comments).toEqual([]);
    expect(tailBody.last_seq).toBe(c3.seq);
  });

  test("bad since= rejects with 400", async () => {
    const res = await s.api.get(`/api/boards/${boardId}/comments?since=abc`, {
      token: agent.token,
    });
    expect(res.status).toBe(400);
  });

  test("agent cursor reads record presence; human sessions do not", async () => {
    const board = await makeBoard("Presence", agent.token, s.api);
    await postComment(s.api, board, agent.token, "presence probe");
    await s.api.get(`/api/boards/${board}/comments`, {
      token: commenter.token,
    });
    const row = s.db
      .prepare(
        "SELECT agent, kind, last_seq FROM subscribers WHERE board_id = ?",
      )
      .all(board) as Array<{ agent: string; kind: string; last_seq: number }>;
    expect(row).toEqual([
      { agent: "commenter", kind: "cursor", last_seq: expect.any(Number) },
    ]);

    const exchange = createExchangeToken(s.db, board);
    const sessionRes = await s.api.post("/api/session/exchange", {
      token: exchange,
    });
    const session = await json<{ token: string }>(sessionRes);
    await s.api.get(`/api/boards/${board}/comments`, {
      token: session.token,
    });
    const after = s.db
      .prepare("SELECT COUNT(*) AS c FROM subscribers WHERE board_id = ?")
      .get(board) as { c: number };
    expect(after.c).toBe(1);
  });

  test("board list carries unresolved root-thread counts", async () => {
    const board = await makeBoard("Counts", agent.token, s.api);
    const r1 = await postComment(s.api, board, agent.token, "r1");
    await postComment(s.api, board, agent.token, "r2");
    await s.api.post(
      `/api/comments/${r1.id}/resolve`,
      {},
      { token: agent.token },
    );
    const res = await s.api.get("/api/boards", { token: agent.token });
    const boards =
      await json<Array<{ id: string; unresolved_comments: number }>>(res);
    const entry = boards.find((b) => b.id === board);
    expect(entry?.unresolved_comments).toBe(1);
    const ended = boards.find((b) => b.id === boardId);
    expect(ended).toBeDefined();
  });

  test("event sequence and per-board jsonl mirror stay consistent", async () => {
    const res = await s.api.get(`/api/boards/${boardId}/events`, {
      token: agent.token,
    });
    const body = await json<{ events: Array<{ type: string }> }>(res);
    expect(body.events.map((ev) => ev.type)).toEqual([
      "board.created",
      "board.published",
      "comment.created",
      "comment.replied",
      "comment.resolved",
      "board.ended",
    ]);
    const lines = readFileSync(
      join(s.dataDir, "boards", boardId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(body.events.length);
  });
});

async function makeBoard(
  title: string,
  token: string,
  api: HttpClient,
): Promise<string> {
  const res = await api.post(
    "/api/boards",
    { title, format: "markdown" },
    { token },
  );
  const board = await json<{ id: string }>(res);
  const publish = await api.post(
    `/api/boards/${board.id}/publish`,
    { format: "markdown", content: MD, expected_version: 0 },
    { token },
  );
  expect(publish.status).toBe(201);
  return board.id;
}

async function postComment(
  api: HttpClient,
  board: string,
  token: string,
  body: string,
): Promise<CommentJson> {
  const res = await api.post(
    `/api/boards/${board}/comments`,
    { anchor: { type: "board" }, body, version_n: 1 },
    { token },
  );
  expect(res.status).toBe(201);
  return json<CommentJson>(res);
}

describe("image anchors over the comments API", () => {
  test("comment with an image anchor + overlay posts and reads back", async () => {
    const board = await makeBoard("Image anchors", agent.token, s.api);
    // ingest a real png through the binary asset route
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const upload = await fetch(`${s.hostUrl}/api/assets?board_id=${board}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "image/png",
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const asset = (await upload.json()) as { id: string };
    const anchor = {
      type: "image",
      asset_id: asset.id,
      overlay: {
        arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
        boxes: [{ x: 0.8, y: 0.1, text: "label" }],
      },
    };
    const created = await s.api.post(
      `/api/boards/${board}/comments`,
      { anchor, body: "see the arrow", version_n: 1 },
      { token: commenter.token },
    );
    expect(created.status).toBe(201);
    expect((await json<CommentJson>(created)).anchor).toEqual(anchor);
  });

  test("overlay coordinates outside [0,1] map to 400 invalid_anchor", async () => {
    const board = await makeBoard("Image anchor bounds", agent.token, s.api);
    const res = await s.api.post(
      `/api/boards/${board}/comments`,
      {
        anchor: {
          type: "image",
          asset_id: "whatever123",
          overlay: { arrows: [{ x1: 1.5, y1: 0, x2: 0, y2: 0 }], boxes: [] },
        },
        body: "x",
        version_n: 1,
      },
      { token: agent.token },
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      "invalid_anchor",
    );
  });

  test("malformed overlay shape maps to 400 invalid_request", async () => {
    const board = await makeBoard("Image anchor shape", agent.token, s.api);
    const res = await s.api.post(
      `/api/boards/${board}/comments`,
      {
        anchor: {
          type: "image",
          asset_id: "whatever123",
          overlay: { arrows: "nope", boxes: [] },
        },
        body: "x",
        version_n: 1,
      },
      { token: agent.token },
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      "invalid_request",
    );
  });

  test("an overlay-only annotation posts with an absent or empty body (201)", async () => {
    const board = await makeBoard("Overlay-only", agent.token, s.api);
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const upload = await fetch(`${s.hostUrl}/api/assets?board_id=${board}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "image/png",
      },
      body: bytes,
    });
    const asset = (await upload.json()) as { id: string };
    const anchor = {
      type: "image",
      asset_id: asset.id,
      overlay: {
        arrows: [{ x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }],
        boxes: [],
      },
    };
    // body field absent entirely
    const absent = await s.api.post(
      `/api/boards/${board}/comments`,
      { anchor, version_n: 1 },
      { token: commenter.token },
    );
    expect(absent.status).toBe(201);
    // empty string body
    const empty = await s.api.post(
      `/api/boards/${board}/comments`,
      { anchor, body: "", version_n: 1 },
      { token: commenter.token },
    );
    expect(empty.status).toBe(201);
    expect((await json<CommentJson>(empty)).body).toBe("");
  });

  test("an empty body with a text anchor maps to 400 invalid_request", async () => {
    const board = await makeBoard("Empty body text", agent.token, s.api);
    const res = await s.api.post(
      `/api/boards/${board}/comments`,
      {
        anchor: {
          type: "text",
          section_id: "b2",
          originalText: "beta",
          startOffset: 6,
          endOffset: 10,
        },
        body: "",
        version_n: 1,
      },
      { token: agent.token },
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      "invalid_request",
    );
  });
});
