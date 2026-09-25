import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireAuth, resolveActor } from "./auth.ts";
import { openDb } from "./db.ts";
import { HttpError } from "./http.ts";
import { createExchangeToken, exchangeSession } from "./sessions.ts";
import { createToken, revokeToken } from "./tokens.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "board-auth-test-"));
  dirs.push(dir);
  return openDb(dir);
}

const API_URL = "http://127.0.0.1:7800/api/health";

// The agent-vs-human acceptance matrix for the shared token→Actor core, which
// the header-only REST path, the MCP endpoint (human-rejecting), and the SSE
// stream (human-accepting) all sit on.
describe("resolveActor", () => {
  test("an agent token resolves to the agent actor", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    expect(resolveActor(db, token)).toEqual({ kind: "agent", name: "alice" });
    db.close();
  });

  test("a session token resolves to the human actor", () => {
    const db = freshDb();
    const session = exchangeSession(db, createExchangeToken(db));
    expect(resolveActor(db, session)).toEqual({ kind: "human", name: "human" });
    db.close();
  });

  test("an unknown or revoked token resolves to null (no throw)", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    revokeToken(db, "alice");
    expect(resolveActor(db, token)).toBeNull();
    expect(resolveActor(db, "definitely-not-issued")).toBeNull();
    db.close();
  });
});

function request(headers: Record<string, string>): Request {
  return new Request(API_URL, { headers });
}

function catchUnauthorized(req: Request, db: Database): HttpError {
  let err: unknown;
  try {
    requireAuth(req, db);
  } catch (thrown) {
    err = thrown;
  }
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe("requireAuth", () => {
  test("a valid bearer token authenticates the matching agent", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    const actor = requireAuth(
      request({ authorization: `Bearer ${token}` }),
      db,
    );
    expect(actor).toEqual({ kind: "agent", name: "alice" });
    db.close();
  });

  test("missing Authorization header is rejected with 401", () => {
    const db = freshDb();
    const err = catchUnauthorized(new Request(API_URL), db);
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    db.close();
  });

  test("a non-Bearer scheme is rejected with 401", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    const err = catchUnauthorized(
      request({ authorization: `Basic ${token}` }),
      db,
    );
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    db.close();
  });

  test("Bearer with an empty token is rejected with 401", () => {
    const db = freshDb();
    for (const header of ["Bearer", "Bearer "]) {
      const err = catchUnauthorized(request({ authorization: header }), db);
      expect(err.status).toBe(401);
      expect(err.code).toBe("unauthorized");
    }
    db.close();
  });

  test("an unknown token is rejected with 401", () => {
    const db = freshDb();
    const err = catchUnauthorized(
      request({ authorization: "Bearer definitely-not-issued" }),
      db,
    );
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    db.close();
  });

  test("a revoked token is rejected with 401", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    revokeToken(db, "alice");
    const err = catchUnauthorized(
      request({ authorization: `Bearer ${token}` }),
      db,
    );
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    db.close();
  });

  test("failure messages never echo the token value (invariant 7)", () => {
    const db = freshDb();
    const { token } = createToken(db, { name: "alice" });
    revokeToken(db, "alice");
    const cases = [
      request({ authorization: `Bearer ${token}` }),
      request({ authorization: `Bearer ${token}-wrong` }),
      request({ authorization: `Basic ${token}` }),
      request({ authorization: "Bearer" }),
      new Request(API_URL),
    ];
    for (const req of cases) {
      const err = catchUnauthorized(req, db);
      expect(err.message).not.toContain(token);
      expect(`${err.status} ${err.code} ${err.message}`).not.toContain(token);
    }
    db.close();
  });
});

describe("requireAuth with human sessions", () => {
  test("a session token authenticates the human actor", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db);
    const session = exchangeSession(db, exchange);
    const actor = requireAuth(
      request({ authorization: `Bearer ${session}` }),
      db,
    );
    expect(actor).toEqual({ kind: "human", name: "human" });
    db.close();
  });

  test("an unused exchange token does not authenticate as a Bearer", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db);
    const err = catchUnauthorized(
      request({ authorization: `Bearer ${exchange}` }),
      db,
    );
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    db.close();
  });

  test("an invalid session token is rejected with 401 as before", () => {
    const db = freshDb();
    const err = catchUnauthorized(
      request({ authorization: "Bearer not-a-session-token" }),
      db,
    );
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    db.close();
  });

  test("session failure messages never echo the token value (invariant 7)", () => {
    const db = freshDb();
    const exchange = createExchangeToken(db);
    const session = exchangeSession(db, exchange);
    const cases = [
      request({ authorization: `Bearer ${session}-wrong` }),
      request({ authorization: `Bearer ${exchange}` }),
      request({ authorization: `Basic ${session}` }),
    ];
    for (const req of cases) {
      const err = catchUnauthorized(req, db);
      expect(err.message).not.toContain(session);
      expect(err.message).not.toContain(exchange);
      expect(`${err.status} ${err.code} ${err.message}`).not.toContain(session);
    }
    db.close();
  });
});
