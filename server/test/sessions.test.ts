import { afterEach, describe, expect, test } from "bun:test";
import { createExchangeToken } from "../src/sessions.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

let current: TestServer | undefined;

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

function server(): TestServer {
  current ??= startTestServer();
  return current;
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

// The UI's own flow: exchange a one-time token over HTTP, then read the
// session's inventory id back from GET /api/sessions.
async function humanSession(
  s: TestServer,
): Promise<{ token: string; id: string }> {
  const exchange = createExchangeToken(s.db);
  const res = await s.api.post("/api/session/exchange", { token: exchange });
  expect(res.status).toBe(200);
  const token = ((await res.json()) as { token: string }).token;
  const list = await s.api.get("/api/sessions", { token });
  expect(list.status).toBe(200);
  const body = (await list.json()) as {
    sessions: Array<{ id: string; kind: string }>;
  };
  const session = body.sessions.find((row) => row.kind === "session");
  if (session === undefined) {
    throw new Error("session row missing from inventory");
  }
  return { token, id: session.id };
}

describe("POST /api/session/exchange", () => {
  test("happy path: exchange over HTTP, then the session token works as a Bearer", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    const res = await s.api.post("/api/session/exchange", { token: exchange });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.token).not.toBe(exchange);

    const boards = await s.api.get("/api/boards", { token: body.token });
    expect(boards.status).toBe(200);
    expect(await boards.json()).toEqual([]);
  });

  test("reusing an exchange token is rejected with 401", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    expect(
      (await s.api.post("/api/session/exchange", { token: exchange })).status,
    ).toBe(200);
    const reuse = await s.api.post("/api/session/exchange", {
      token: exchange,
    });
    expect(reuse.status).toBe(401);
    expect(await errorCode(reuse)).toBe("unauthorized");
  });

  test("a garbage exchange token is rejected with 401", async () => {
    const s = server();
    const res = await s.api.post("/api/session/exchange", {
      token: "definitely-not-an-exchange-token",
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("a missing token field is rejected with 400", async () => {
    const s = server();
    const res = await s.api.post("/api/session/exchange", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("token");
  });

  test("an unused exchange token is not itself a Bearer", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    const res = await s.api.get("/api/boards", { token: exchange });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("the auth bootstrap still runs behind the hardening middleware", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    const crossSite = await s.api.post(
      "/api/session/exchange",
      { token: exchange },
      { headers: { "sec-fetch-site": "cross-site" } },
    );
    expect(crossSite.status).toBe(403);
    expect(await errorCode(crossSite)).toBe("cross_site_blocked");

    const noJson = await s.api.post("/api/session/exchange");
    expect(noJson.status).toBe(415);
    expect(await errorCode(noJson)).toBe("unsupported_media_type");
  });

  test("a wrong method returns 405 with an Allow header", async () => {
    const s = server();
    const res = await s.api.get("/api/session/exchange");
    expect(res.status).toBe(405);
    expect(await errorCode(res)).toBe("method_not_allowed");
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("GET /api/sessions", () => {
  test("lists every session row with lifecycle fields only", async () => {
    const s = server();
    const { token, id } = await humanSession(s);
    const res = await s.api.get("/api/sessions", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    // the spent exchange row + the live session row
    expect(body.sessions).toHaveLength(2);
    const kinds = body.sessions.map((row) => row.kind).sort();
    expect(kinds).toEqual(["exchange", "session"]);
    // exact key set — lifecycle metadata, nothing else (no token material)
    const keys = [
      ...new Set(body.sessions.flatMap((row) => Object.keys(row))),
    ].sort();
    expect(keys).toEqual(["created_at", "expires_at", "id", "kind", "used_at"]);
    const session = body.sessions.find((row) => row.kind === "session");
    expect(session?.id).toBe(id);
    expect(session?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session?.used_at).toBeNull();
    // D19: live sessions expire 30 days after exchange — the inventory shows
    // the operator when a credential dies on its own
    expect(session?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const spent = body.sessions.find((row) => row.kind === "exchange");
    expect(spent?.used_at).not.toBeNull();
    expect(spent?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("an agent bearer is 403 forbidden — session enumeration is recon", async () => {
    const s = server();
    const { token } = await s.createAgent("session-recon-agent");
    const res = await s.api.get("/api/sessions", { token });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
  });

  test("requires a token", async () => {
    const s = server();
    const res = await s.api.get("/api/sessions");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });
});

describe("DELETE /api/sessions/:id", () => {
  const jsonHeaders = { "content-type": "application/json" };

  test("self-revoke is allowed; the credential dies immediately", async () => {
    const s = server();
    const { token, id } = await humanSession(s);
    const del = await s.api.delete(`/api/sessions/${id}`, {
      token,
      headers: jsonHeaders,
    });
    expect(del.status).toBe(204);
    // the very next request with the revoked bearer 401s
    const after = await s.api.get("/api/boards", { token });
    expect(after.status).toBe(401);
  });

  test("an unknown id is 404", async () => {
    const s = server();
    const { token } = await humanSession(s);
    const res = await s.api.delete(`/api/sessions/${"deadbeef".repeat(8)}`, {
      token,
      headers: jsonHeaders,
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("session_not_found");
  });

  test("an agent bearer is 403 forbidden", async () => {
    const s = server();
    const { token } = await s.createAgent("session-revoke-agent");
    const res = await s.api.delete("/api/sessions/deadbeef", {
      token,
      headers: jsonHeaders,
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
  });

  test("revoking an unexchanged exchange token kills the leaked ?token=", async () => {
    const s = server();
    const { token } = await humanSession(s);
    const leaked = createExchangeToken(s.db);
    // find the leaked row's id in the inventory (the UI's flow)
    const list = await s.api.get("/api/sessions", { token });
    const body = (await list.json()) as {
      sessions: Array<{ id: string; kind: string; used_at: string | null }>;
    };
    const leakedRow = body.sessions.find(
      (row) => row.kind === "exchange" && row.used_at === null,
    );
    expect(leakedRow).toBeDefined();
    const del = await s.api.delete(`/api/sessions/${leakedRow?.id}`, {
      token,
      headers: jsonHeaders,
    });
    expect(del.status).toBe(204);
    // the exchange is dead: 401, not a fresh session
    const reuse = await s.api.post("/api/session/exchange", { token: leaked });
    expect(reuse.status).toBe(401);
  });
});
