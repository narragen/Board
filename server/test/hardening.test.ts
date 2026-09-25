// M7 hardening-audit probes (docs/security.md "API hardening" + the audit
// matrix): every claim the docs make about caps, headers, and session
// lifecycle gets a failing-if-regressed test here.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { AssetTooLarge, readBinaryAssetBody } from "../src/assets.ts";
import { readImportBody } from "../src/bundle-import.ts";
import { readJsonBody } from "../src/http.ts";
import {
  type RawResponse,
  startTestServer,
  type TestServer,
} from "./helpers.ts";

let current: TestServer | undefined;

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

function server(): TestServer {
  current ??= startTestServer();
  return current;
}

// The exact host CSP — pinned by daemon.test.ts too; repeated here so the
// api/mcp surface (which stamps host headers in a DIFFERENT code path,
// withHostHeaders) cannot silently lose or widen it.
const HOST_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

function streamRequest(
  url: string,
  chunkCount: number,
  chunkSize: number,
  headers: Record<string, string> = {},
): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  return new Request(url, { method: "POST", body, headers });
}

// Raw HTTP with chunked transfer encoding (no Content-Length) — the
// honest-header bypass readCappedBody exists for.
function rawChunkedRequest(
  port: number,
  requestHead: string,
  bodyBytes: number,
  chunkSize: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("connect", () => {
      socket.write(`${requestHead}\r\ntransfer-encoding: chunked\r\n\r\n`);
      let remaining = bodyBytes;
      while (remaining > 0) {
        const size = Math.min(chunkSize, remaining);
        remaining -= size;
        socket.write(`${size.toString(16)}\r\n`);
        socket.write(Buffer.alloc(size, 0x78));
        socket.write("\r\n");
      }
      socket.write("0\r\n\r\n");
      socket.end();
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    // The server is SUPPOSED to answer 413 and hang up mid-upload — that is
    // the whole point of this helper. Our remaining writes then fail with
    // EPIPE/ECONNRESET, so rejecting on those turned the behavior under test
    // into a ~1-in-3 flaky failure. Swallow them and let "close" resolve with
    // whatever response arrived; every other error is real.
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ECONNRESET") {
        return;
      }
      reject(err);
    });
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("close", () => {
      const raw = Buffer.concat(chunks).toString();
      const status = Number.parseInt(raw.split(" ")[1] ?? "0", 10);
      resolve({ status, headers: {}, body: raw });
    });
  });
}

describe("caps: streaming enforcement (no unbounded buffering)", () => {
  test("a chunked JSON body over 8 MB is rejected mid-stream with 413", async () => {
    // 9 MB in 64 KB chunks, NO content-length header — the old reader
    // buffered all of it before checking.
    let err: unknown;
    try {
      await readJsonBody(
        streamRequest("http://x/api", (9 * 1024 * 1024) / 65536, 65536),
      );
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("HttpError");
    expect((err as { status: number }).status).toBe(413);
    expect((err as { code: string }).code).toBe("payload_too_large");
  });

  test("a chunked JSON body under the cap parses fine", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) {
          sent = 1;
          controller.enqueue(new TextEncoder().encode('{"title":"hi"}'));
        } else {
          controller.close();
        }
      },
    });
    const parsed = await readJsonBody(
      new Request("http://x/api", { method: "POST", body }),
    );
    expect(parsed).toEqual({ title: "hi" });
  });

  test("a chunked binary asset body over 10 MB is rejected mid-stream", async () => {
    let err: unknown;
    try {
      await readBinaryAssetBody(
        streamRequest("http://x/api/assets", (11 * 1024 * 1024) / 65536, 65536),
      );
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AssetTooLarge);
  });

  test("an import body with a dishonest content-length is rejected without buffering", async () => {
    let err: unknown;
    try {
      await readImportBody(
        streamRequest("http://x/api/boards/import", 1, 16, {
          "content-length": String(65 * 1024 * 1024),
        }),
      );
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ImportRejected");
  });

  test("integration: chunked POST over 8 MB never reaches a handler (413)", async () => {
    const s = server();
    const agent = await s.createAgent("prober");
    const port = Number(new URL(s.hostUrl).port);
    const raw = await rawChunkedRequest(
      port,
      "POST /api/boards HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nConnection: close",
      9 * 1024 * 1024,
      65536,
    );
    expect(raw.status).toBe(413);
    expect(raw.body).toContain("payload_too_large");
    // nothing created
    const boards = await s.api.get("/api/boards", { token: agent.token });
    expect(((await boards.json()) as unknown[]).length).toBe(0);
  });
});

describe("headers: host CSP + nosniff + no-cache on every response class", () => {
  test("public api route carries CSP, nosniff, and no-cache", async () => {
    const res = await server().api.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(HOST_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("authed api route (M7 events) carries the same host headers", async () => {
    const s = server();
    const agent = await s.createAgent("auditor");
    const res = await s.api.get("/api/events", {
      token: agent.token,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(HOST_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("api error responses (404) carry the host headers too", async () => {
    const res = await server().api.get("/api/definitely-not-here");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBe(HOST_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("mcp responses (405 non-POST) carry the host headers", async () => {
    const res = await fetch(new URL("/mcp", server().hostUrl));
    expect(res.status).toBe(405);
    expect(res.headers.get("content-security-policy")).toBe(HOST_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("headers: transport hardening on /mcp (same as /api)", () => {
  test("non-allowlisted Host is a 421 on /mcp", async () => {
    const res = await server().api.post(
      "/mcp",
      {},
      {
        headers: { host: "evil.com" },
      },
    );
    expect(res.status).toBe(421);
  });

  test("cross-site POST is a 403 on /mcp", async () => {
    const res = await server().api.post(
      "/mcp",
      {},
      {
        headers: { "sec-fetch-site": "cross-site" },
      },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "cross_site_blocked",
    );
  });

  test("non-JSON content-type is a 415 on /mcp", async () => {
    const res = await fetch(new URL("/mcp", server().hostUrl), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(415);
  });
});

describe("headers: cross-site rejection reaches the M7 operator routes", () => {
  test("cross-site DELETE /api/sessions/:id is a 403 cross_site_blocked", async () => {
    const s = server();
    const agent = await s.createAgent("x");
    const res = await s.api.delete("/api/sessions/whatever", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    // cross-site beats auth: the 403 is the CSRF defense, not requireHuman
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "cross_site_blocked",
    );
    void agent;
  });

  test("cross-site POST /api/boards/import is a 403 (raw-body route included)", async () => {
    const res = await fetch(new URL("/api/boards/import", server().hostUrl), {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: "bytes",
    });
    expect(res.status).toBe(403);
  });
});

describe("session lifecycle: 30-day TTL (D19)", () => {
  test("exchange stamps expires_at ~30 days out; the session works", async () => {
    const s = server();
    const { createExchangeToken, exchangeSession } = await import(
      "../src/sessions.ts"
    );
    const exchange = createExchangeToken(s.db);
    const session = await s.api.post("/api/session/exchange", {
      token: exchange,
    });
    expect(session.status).toBe(200);
    const { token } = (await session.json()) as { token: string };

    const before = Date.now();
    const health = await s.api.get("/api/health", { token });
    expect(health.status).toBe(200);

    const rows = s.db
      .prepare("SELECT expires_at FROM sessions WHERE kind = 'session'")
      .all() as Array<{ expires_at: string | null }>;
    expect(rows).toHaveLength(1);
    const expires = Date.parse(rows[0]?.expires_at ?? "");
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    // stamped at exchange, so a tick inside the test window is fine
    expect(expires - before).toBeGreaterThan(thirtyDays - 60_000);
    expect(expires - before).toBeLessThanOrEqual(thirtyDays);

    void exchangeSession; // imported for the type flow above
  });

  test("an expired session bearer is rejected at auth time", async () => {
    const s = server();
    const token = "expired-session-token";
    s.db
      .prepare(
        "INSERT INTO sessions (token_hash, kind, created_at, expires_at) VALUES (?, 'session', ?, ?)",
      )
      .run(
        createHash("sha256").update(token).digest("hex"),
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      );
    const res = await s.api.get("/api/boards", { token });
    expect(res.status).toBe(401);
  });
});

describe("event payloads stay small (no content/body bloat in the log)", () => {
  test("publish + comment events never carry the content or body", async () => {
    const s = server();
    const agent = await s.createAgent("publisher");
    const board = await s.api.post(
      "/api/boards",
      {
        title: "bloat probe",
        format: "markdown",
      },
      { token: agent.token },
    );
    const { id } = (await board.json()) as { id: string };
    const published = await s.api.post(
      `/api/boards/${id}/publish`,
      {
        format: "markdown",
        content: `# big\n\n${"x".repeat(200 * 1024)}`,
        expected_version: 0,
      },
      { token: agent.token },
    );
    expect(published.status).toBe(201);
    const commented = await s.api.post(
      `/api/boards/${id}/comments`,
      {
        anchor: { type: "board" },
        body: "y".repeat(200 * 1024),
        version_n: 1,
      },
      { token: agent.token },
    );
    expect(commented.status).toBe(201);

    const events = await s.api.get("/api/events", { token: agent.token });
    const { events: rows } = (await events.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    for (const row of rows) {
      const size = JSON.stringify(row).length;
      expect(size).toBeLessThan(4096);
      expect(JSON.stringify(row)).not.toContain("x".repeat(1000));
      expect(JSON.stringify(row)).not.toContain("y".repeat(1000));
      void row.type;
    }
  });
});
