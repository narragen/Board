import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  completePasteExchange,
  createComment,
  exchange,
  getBoard,
  getComments,
  getEvents,
  getVersion,
  listBoards,
  listSessions,
  listTokens,
  onUnauthorized,
  replyComment,
  resolveComment,
  restoreBoard,
  revokeSession,
  streamUrl,
} from "./api.ts";
import { installDom } from "./test-dom.ts";
import { clearSessionToken, setSessionToken } from "./token.ts";

installDom();

// bun runs every test file in one process — an unrestored global fetch mock
// silently answers every LATER file's real fetches (the daemon-route and
// connector integration tests included) with this file's last canned
// responder. Capture the real fetch at import and restore it after each test.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface RecordedCall {
  input: string;
  init: RequestInit | undefined;
}

function mockFetch(respond: (call: RecordedCall) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { input: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client", () => {
  test("listBoards sends GET with the session bearer", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch(() => jsonResponse(200, []));
    const boards = await listBoards();
    expect(boards).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/api/boards");
    expect(calls[0].init?.method).toBeUndefined();
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer sess-token",
    );
    clearSessionToken();
  });

  test("no bearer header when no session is stored", async () => {
    clearSessionToken();
    const calls = mockFetch(() => jsonResponse(200, []));
    await listBoards();
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(null);
  });

  test("getBoard and getVersion build the right paths", async () => {
    const calls = mockFetch((call) =>
      call.input.includes("versions/3")
        ? jsonResponse(200, { board_id: "b1", n: 3 })
        : jsonResponse(200, { board: {}, versions: [] }),
    );
    await getBoard("b1");
    await getVersion("b1", 3);
    expect(calls.map((call) => call.input)).toEqual([
      "/api/boards/b1",
      "/api/boards/b1/versions/3",
    ]);
  });

  test("error envelope surfaces as ApiError with code", async () => {
    mockFetch(() =>
      jsonResponse(404, {
        error: { code: "board_not_found", message: 'board "x" not found' },
      }),
    );
    const err = await getBoard("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe("board_not_found");
    expect(apiErr.message).toContain("not found");
  });

  // The invariant every error-reporting site in web/ leans on: errText's
  // `fallback` is reached only for a non-Error rejection, so a rejection from
  // here that is NOT an Error would render the domain fallback (hiding the real
  // cause) or "[object Object]" where no fallback is passed. Nothing in the
  // type system enforces it — `catch` binds `unknown` — so it is asserted over
  // all three ways apiFetch can reject.
  test("every rejection is an Error with a message (the errText contract)", async () => {
    // 1. non-JSON error body (a proxy's html 502): the envelope parse fails and
    //    the fallback code/message stand in
    mockFetch(
      () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );
    const nonJson = await getBoard("x").catch((e: unknown) => e);
    expect(nonJson).toBeInstanceOf(ApiError);
    expect((nonJson as ApiError).code).toBe("http_502");
    expect((nonJson as ApiError).message).toBe("request failed: 502");

    // 2. malformed SUCCESS body: res.json() throws where nothing catches it —
    //    the one rejection that is not an ApiError, still an Error (SyntaxError)
    mockFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const badBody = await getBoard("x").catch((e: unknown) => e);
    expect(badBody).not.toBeInstanceOf(ApiError);
    expect(badBody).toBeInstanceOf(Error);
    expect((badBody as Error).message).not.toBe("");

    // 3. transport failure: propagates untouched (fetch rejects with a
    //    TypeError), so the caller still gets a message
    mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const offline = await getBoard("x").catch((e: unknown) => e);
    expect(offline).toBeInstanceOf(Error);
    expect((offline as Error).message).toBe("Failed to fetch");
  });

  test("401 clears the session and fires the unauthorized handler", async () => {
    setSessionToken("sess-token");
    let unauthorized = false;
    const off = onUnauthorized(() => {
      unauthorized = true;
    });
    mockFetch(() => jsonResponse(401, { error: { code: "unauthorized" } }));
    await expect(listBoards()).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toBe(true);
    expect(localStorage.getItem("board.session")).toBe(null);
    off();
  });

  test("exchange posts the one-time token without a bearer", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch(() => jsonResponse(200, { token: "new-session" }));
    const result = await exchange("one-time-1");
    expect(result).toBe("new-session");
    expect(calls[0].input).toBe("/api/session/exchange");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe(JSON.stringify({ token: "one-time-1" }));
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(null);
    clearSessionToken();
  });

  test("failed exchange rejects with ApiError unauthorized", async () => {
    mockFetch(() => jsonResponse(401, { error: { code: "unauthorized" } }));
    await expect(exchange("burned")).rejects.toThrow("make open");
  });

  test("comment endpoints hit the right paths with the right bodies", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch((call) => {
      if (call.input.includes("/reply")) {
        return jsonResponse(201, { id: "c2" });
      }
      if (call.input.includes("/resolve")) {
        return jsonResponse(200, { id: "c1" });
      }
      if (call.input.includes("comments")) {
        return jsonResponse(200, { comments: [], last_seq: 0 });
      }
      return jsonResponse(201, { id: "c3" });
    });
    await createComment("b1", {
      anchor: { type: "board" },
      body: "note",
      version_n: 2,
    });
    await replyComment("c1", "a reply");
    await resolveComment("c1");
    const page = await getComments("b1", 5);
    expect(page.last_seq).toBe(0);
    expect(
      calls.map((call) => `${call.init?.method ?? "GET"} ${call.input}`),
    ).toEqual([
      "POST /api/boards/b1/comments",
      "POST /api/comments/c1/reply",
      "POST /api/comments/c1/resolve",
      "GET /api/boards/b1/comments?since=5",
    ]);
    expect(calls[0].init?.body).toBe(
      JSON.stringify({
        anchor: { type: "board" },
        body: "note",
        version_n: 2,
      }),
    );
    expect(calls[1].init?.body).toBe(JSON.stringify({ body: "a reply" }));
    // every write must carry application/json — the daemon 415s anything else
    // (the bug that broke browser commenting: fetch defaults to text/plain)
    for (const call of calls.slice(0, 3)) {
      expect(new Headers(call.init?.headers).get("content-type")).toBe(
        "application/json",
      );
    }
    clearSessionToken();
  });

  test("streamUrl embeds the session token url-encoded", () => {
    setSessionToken("abc/def+ghi=");
    expect(streamUrl()).toBe("/api/stream?token=abc%2Fdef%2Bghi%3D");
    clearSessionToken();
    expect(streamUrl()).toBe("");
  });

  test("completePasteExchange stores the session on success", async () => {
    clearSessionToken();
    mockFetch(() => jsonResponse(200, { token: "session-9" }));
    await completePasteExchange("one-time-9");
    expect(localStorage.getItem("board.session")).toBe("session-9");
    clearSessionToken();
  });

  test("completePasteExchange failure leaves the prior session untouched", async () => {
    setSessionToken("prior-session");
    mockFetch(() => jsonResponse(401, { error: { code: "unauthorized" } }));
    await expect(completePasteExchange("burned")).rejects.toThrow("make open");
    expect(localStorage.getItem("board.session")).toBe("prior-session");
    clearSessionToken();
  });

  test("revokeSession labels its bodyless DELETE as JSON (415 guard)", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch(() => new Response(null, { status: 204 }));
    await revokeSession("sess-7");
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/api/sessions/sess-7");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].init?.body).toBeUndefined();
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe(
      "application/json",
    );
    clearSessionToken();
  });

  test("audit endpoints build the pinned paths; revokeSession tolerates 204", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch((call) => {
      if (call.input.startsWith("/api/events")) {
        return jsonResponse(200, { events: [], last_seq: 0 });
      }
      if (call.input === "/api/sessions") {
        return jsonResponse(200, { sessions: [] });
      }
      if (call.input === "/api/tokens") {
        return jsonResponse(200, { tokens: [] });
      }
      return new Response(null, { status: 204 });
    });
    await getEvents({ type: "webhook.failed", since: 5, limit: 100 });
    expect(calls[0].input).toBe(
      "/api/events?type=webhook.failed&since=5&limit=100",
    );
    await getEvents({ boardId: "b1" });
    expect(calls[1].input).toBe("/api/events?board_id=b1");
    await getEvents();
    expect(calls[2].input).toBe("/api/events");
    await listSessions();
    expect(calls[3].input).toBe("/api/sessions");
    await listTokens();
    expect(calls[4].input).toBe("/api/tokens");
    await revokeSession("sess-9");
    expect(calls[5].input).toBe("/api/sessions/sess-9");
    expect(calls[5].init?.method).toBe("DELETE");
    clearSessionToken();
  });

  test("restoreBoard posts from_n + expected_version to /restore (route contract)", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch(() =>
      jsonResponse(201, { board_id: "b1", n: 3, label: "restore of v1" }),
    );
    const restored = await restoreBoard("b1", 1, 2);
    expect(restored.n).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/api/boards/b1/restore");
    expect(calls[0].init?.method).toBe("POST");
    // BOTH fields required by the route (asInt 400s on a missing one)
    expect(calls[0].init?.body).toBe(
      JSON.stringify({ from_n: 1, expected_version: 2 }),
    );
    // the JSON-label rule: every write carries content-type (415 guard)
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe(
      "application/json",
    );
    clearSessionToken();
  });

  test("restoreBoard surfaces the 409 envelope (version_conflict)", async () => {
    mockFetch(() =>
      jsonResponse(409, {
        error: {
          code: "version_conflict",
          message: 'version conflict on board "b1": expected 2, current 5',
          current_version: 5,
        },
      }),
    );
    const err = await restoreBoard("b1", 1, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe("version_conflict");
    expect(apiErr.message).toContain("current 5");
  });
});
