// Route-level test for the comment resolve surface over REAL HTTP — the only
// place the wire path itself is pinned (the service tests in comments.test.ts
// call resolveComment directly, and scripts/smoke.ts is not part of bun test).
//
// Why this exists: a bug report claimed comment resolution 404'd because a
// client built the path as /api/boards/:board_id/comments/:id/resolve. No such
// construction exists in this repo (the MCP board_resolve tool calls the
// service function directly; the CLI connector proxies raw JSON-RPC to /mcp),
// and the canonical shape is the flat one in routes/comments.ts. These tests
// pin that contract: the flat path works, the nested alias must NOT appear.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "../../test/helpers.ts";
import type { Board, Comment, Version } from "../domain.ts";

// Same fixture content + section id as the passing service-level resolve test
// (comments.test.ts "resolve is idempotent") — the anchor must reference a
// section the publish pipeline actually rendered.
const MD = `# Heading

alpha beta gamma
`;

let server: TestServer;
let token: string;
let boardId: string;
let commentId: string;

// The daemon's error envelope, surfaced in assertion failures — a fixture
// step failing with 4xx/5xx should name its error code, not just the status.
async function expectStatus(res: Response, status: number, what: string) {
  if (res.status !== status) {
    throw new Error(
      `${what} on ${server.hostUrl}: expected ${status}, got ${res.status}: ${await res.text()}`,
    );
  }
}

beforeAll(async () => {
  server = startTestServer();
  token = (await server.createAgent("route-test-agent")).token;

  const boardRes = await server.api.post(
    "/api/boards",
    {
      title: "Resolve route",
      format: "markdown",
    },
    { token },
  );
  await expectStatus(boardRes, 201, "board create");
  boardId = ((await boardRes.json()) as Board).id;

  const publishRes = await server.api.post(
    `/api/boards/${boardId}/publish`,
    { format: "markdown", content: MD, expected_version: 0 },
    { token },
  );
  await expectStatus(publishRes, 201, "publish v1");
  const version = (await publishRes.json()) as Version;
  expect(version.n).toBe(1);

  const commentRes = await server.api.post(
    `/api/boards/${boardId}/comments`,
    {
      anchor: { type: "section", section_id: "b1" },
      body: "Resolve me",
      version_n: 1,
    },
    { token },
  );
  await expectStatus(commentRes, 201, "comment create");
  commentId = ((await commentRes.json()) as Comment).id;
});

afterAll(() => server.stop());

describe("POST /api/comments/:id/resolve", () => {
  test("resolves over the canonical flat path, stamping the actor", async () => {
    const res = await server.api.post(
      `/api/comments/${commentId}/resolve`,
      {},
      { token },
    );
    await expectStatus(res, 200, "resolve");
    const resolved = (await res.json()) as Comment;
    expect(resolved.id).toBe(commentId);
    expect(resolved.resolved_at).not.toBe(null);
    expect(resolved.resolved_by).toBe("route-test-agent");
  });

  test("is idempotent over REST — same stamp, no error", async () => {
    const res = await server.api.post(
      `/api/comments/${commentId}/resolve`,
      {},
      { token },
    );
    await expectStatus(res, 200, "re-resolve");
    const again = (await res.json()) as Comment;
    expect(again.resolved_at).not.toBe(null);
  });

  test("an unknown comment id is comment_not_found, not a route 404", async () => {
    // The reported bug read this code as a path mismatch; pinning the
    // distinction: the route matches, the comment does not exist.
    const res = await server.api.post(
      "/api/comments/nosuchcomment/resolve",
      {},
      { token },
    );
    await expectStatus(res, 404, "unknown-comment resolve");
    expect(await res.json()).toEqual({
      error: { code: "comment_not_found", message: expect.any(String) },
    });
  });

  test("the nested /api/boards/:id/comments/:comment_id/resolve alias 404s", async () => {
    // Pins the single canonical shape (docs/api.md): a client that builds the
    // nested path gets the daemon's plain not_found — the fix belongs in the
    // client's path, never an alias route here.
    const res = await server.api.post(
      `/api/boards/${boardId}/comments/${commentId}/resolve`,
      {},
      { token },
    );
    await expectStatus(res, 404, "nested-alias resolve");
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  test("requires a bearer token", async () => {
    const res = await server.api.post(
      `/api/comments/${commentId}/resolve`,
      {},
      {},
    );
    expect(res.status).toBe(401);
  });
});
