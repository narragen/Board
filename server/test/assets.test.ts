import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MAX_ASSET_BYTES } from "../src/assets.ts";
import type { Asset, Board } from "../src/domain.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// In-test generated image bytes with known magic numbers — no binary fixtures.
function pngBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_MAGIC);
  return bytes;
}

function gifBytes(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(
    `GIF89a${" ".repeat(Math.max(size - 6, 0))}`,
  );
  return bytes.slice(0, size);
}

const fixtureDirs: string[] = [];

afterAll(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-asset-fixtures-"));
  fixtureDirs.push(dir);
  return dir;
}

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
  const agent = await s.createAgent("assets-agent");
  return { s, token: agent.token };
}

async function makeBoard(s: TestServer, token: string): Promise<Board> {
  const res = await s.api.post(
    "/api/boards",
    { title: "Assets board", format: "markdown" },
    { token },
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Board;
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

async function uploadBinary(
  s: TestServer,
  token: string,
  boardId: string,
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
): Promise<Response> {
  return fetch(`${s.hostUrl}/api/assets?board_id=${boardId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": mime },
    body: bytes,
  });
}

function assetEvent(db: TestServer["db"], boardId: string) {
  return db
    .prepare(
      "SELECT actor, type, board_id, payload FROM events WHERE type = 'asset.added' AND board_id = ?",
    )
    .get(boardId) as {
    actor: string;
    type: string;
    board_id: string;
    payload: string;
  } | null;
}

describe("POST /api/assets — file-copy variant", () => {
  test("copies a real png into the board bundle with row, file, event, and 201", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const bytes = pngBytes(128);
    const path = join(fixtureDir(), "shot.png");
    writeFileSync(path, bytes);

    const res = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    expect(res.status).toBe(201);
    const asset = (await res.json()) as Asset;
    expect(asset.id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(asset.board_id).toBe(board.id);
    expect(asset.file).toBe(`${asset.id}.png`);
    expect(asset.mime).toBe("image/png");
    expect(asset.size).toBe(128);
    expect(asset.source).toBe("copy");
    expect(asset.created_by).toBe("assets-agent");
    expect(asset.created_at).toMatch(ISO_RE);

    // bundle file with the exact copied bytes
    const filePath = join(s.dataDir, "boards", board.id, "assets", asset.file);
    expect(existsSync(filePath)).toBe(true);
    expect(new Uint8Array(readFileSync(filePath))).toEqual(bytes);

    // index row
    expect(
      s.db.prepare("SELECT id FROM assets WHERE id = ?").get(asset.id),
    ).not.toBeNull();

    // asset.added event: actor, board, payload (id, mime, size, source)
    const ev = assetEvent(s.db, board.id);
    expect(ev).not.toBeNull();
    expect(ev?.actor).toBe("assets-agent");
    expect(JSON.parse(ev?.payload ?? "{}")).toEqual({
      asset_id: asset.id,
      mime: "image/png",
      size: 128,
      source: "copy",
    });

    // per-board jsonl mirror carries it too
    const lines = readFileSync(
      join(s.dataDir, "boards", board.id, "events.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.some((line) => line.includes('"type":"asset.added"'))).toBe(
      true,
    );
  });

  test("rejects a .png-named text file with 400, writing nothing and echoing nothing", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const secret = "do-not-exfiltrate-this-text";
    const path = join(fixtureDir(), "looks-like-a-photo.png");
    writeFileSync(path, secret);

    const res = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    expect(res.status).toBe(400);
    const bodyText = await res.text();
    expect(bodyText).toContain("asset_not_an_image");
    // never echo file content back — invariant 6 (verified asset ingest)
    expect(bodyText).not.toContain(secret);

    expect(readdirSync(join(s.dataDir, "boards", board.id, "assets"))).toEqual(
      [],
    );
    expect(
      (s.db.prepare("SELECT COUNT(*) AS c FROM assets").get() as { c: number })
        .c,
    ).toBe(0);
    expect(assetEvent(s.db, board.id)).toBeNull();
  });

  test("rejects non-allowlisted extensions with 400 asset_type_not_allowed", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    for (const name of ["notes.txt", "evil.exe", "no-extension"]) {
      const path = join(fixtureDir(), name);
      writeFileSync(path, pngBytes(32));
      const res = await s.api.post(
        "/api/assets",
        { board_id: board.id, path },
        { token },
      );
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("asset_type_not_allowed");
    }
  });

  test("rejects relative and missing paths with 400 asset_path_unreadable", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    for (const path of ["relative/pic.png", "/nonexistent/dir/pic.png"]) {
      const res = await s.api.post(
        "/api/assets",
        { board_id: board.id, path },
        { token },
      );
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("asset_path_unreadable");
    }
  });

  test("rejects an over-cap file with 413 asset_too_large", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const path = join(fixtureDir(), "big.png");
    writeFileSync(path, pngBytes(MAX_ASSET_BYTES + 1));
    const res = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("asset_too_large");
    expect(readdirSync(join(s.dataDir, "boards", board.id, "assets"))).toEqual(
      [],
    );
  });

  test("enforces the per-board total with 413 board_asset_quota_exceeded", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const dir = fixtureDir();
    // plan numbers: 8 MB board total — one ~7.9 MB asset fits, a second does not
    const firstBytes = pngBytes(8 * 1024 * 1024 - 100 * 1024);
    const firstPath = join(dir, "first.png");
    writeFileSync(firstPath, firstBytes);
    const first = await s.api.post(
      "/api/assets",
      { board_id: board.id, path: firstPath },
      { token },
    );
    expect(first.status).toBe(201);

    const secondPath = join(dir, "second.png");
    writeFileSync(secondPath, pngBytes(200 * 1024));
    const second = await s.api.post(
      "/api/assets",
      { board_id: board.id, path: secondPath },
      { token },
    );
    expect(second.status).toBe(413);
    expect(await errorCode(second)).toBe("board_asset_quota_exceeded");
    // the first asset is untouched
    expect(
      readdirSync(join(s.dataDir, "boards", board.id, "assets")),
    ).toHaveLength(1);
  });

  test("rejects uploads to an ended board with 409 board_ended", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    expect(
      (await s.api.post(`/api/boards/${board.id}/end`, {}, { token })).status,
    ).toBe(200);
    const path = join(fixtureDir(), "late.png");
    writeFileSync(path, pngBytes(32));
    const res = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("board_ended");
  });

  test("rejects an unknown board with 404 board_not_found", async () => {
    const { s, token } = await setup();
    const path = join(fixtureDir(), "nowhere.png");
    writeFileSync(path, pngBytes(32));
    const res = await s.api.post(
      "/api/assets",
      { board_id: "zzzzzzzzzz", path },
      { token },
    );
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });

  test("rejects a missing token with 401", async () => {
    const s = server();
    const res = await s.api.post("/api/assets", { board_id: "x", path: "/y" });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });
});

describe("POST /api/assets — binary variant", () => {
  test("accepts raw image bytes scoped by ?board_id=", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const bytes = pngBytes(64);
    const res = await uploadBinary(s, token, board.id, bytes, "image/png");
    expect(res.status).toBe(201);
    const asset = (await res.json()) as Asset;
    expect(asset.board_id).toBe(board.id);
    expect(asset.mime).toBe("image/png");
    expect(asset.size).toBe(64);
    expect(asset.source).toBe("binary");
    expect(
      new Uint8Array(
        readFileSync(join(s.dataDir, "boards", board.id, "assets", asset.file)),
      ),
    ).toEqual(bytes);
    expect(
      JSON.parse(assetEvent(s.db, board.id)?.payload ?? "{}"),
    ).toMatchObject({ source: "binary", size: 64 });
  });

  test("rejects bytes whose magic contradicts the declared type", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const res = await uploadBinary(s, token, board.id, gifBytes(), "image/png");
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("asset_not_an_image");
  });

  test("rejects non-allowlisted binary content types", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const res = await uploadBinary(
      s,
      token,
      board.id,
      new TextEncoder().encode("plain text"),
      "text/plain",
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("asset_type_not_allowed");
  });

  test("requires the board_id query param", async () => {
    const { s, token } = await setup();
    const res = await fetch(`${s.hostUrl}/api/assets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "image/png",
      },
      body: pngBytes(32),
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });

  test("rejects an over-cap binary body with 413 asset_too_large", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const res = await uploadBinary(
      s,
      token,
      board.id,
      pngBytes(MAX_ASSET_BYTES + 1),
      "image/png",
    );
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("asset_too_large");
  });
});

describe("svg sanitization at ingest", () => {
  // Script LAST on purpose: a clean drawing with an injected script is the
  // realistic attack shape. sanitizeSvgDocument pre-strips script/style
  // blocks BEFORE parsing (see its comment) — happy-dom's foreign-content
  // parse would otherwise truncate the subtree at a content-bearing one.
  const DIRTY_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="12" height="12">',
    '  <rect width="12" height="12" fill="#f00" onload="alert(1)"/>',
    "  <foreignObject><div>html-in-svg</div></foreignObject>",
    '  <image xlink:href="https://evil.example/pixel"/>',
    '  <a href="https://evil.example/link"><text x="1" y="1">x</text></a>',
    "  <script>alert(1)</script>",
    "</svg>",
  ].join("\n");

  test("strips scripts, handlers, foreignObject, and external refs; keeps the drawing", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const path = join(fixtureDir(), "dirty.svg");
    writeFileSync(path, DIRTY_SVG);
    const res = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    expect(res.status).toBe(201);
    const asset = (await res.json()) as Asset;
    expect(asset.mime).toBe("image/svg+xml");

    const stored = readFileSync(
      join(s.dataDir, "boards", board.id, "assets", asset.file),
      "utf8",
    );
    expect(stored).not.toContain("<script");
    expect(stored).not.toContain("alert(1)");
    expect(stored.toLowerCase()).not.toContain("foreignobject");
    expect(stored).not.toContain("onload");
    expect(stored).not.toContain("evil.example");
    expect(stored).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    // attribute order is serializer insertion order — assert the attributes,
    // not their sequence. Geometry surviving here is the URI-regexp fix
    // (f8b24da): the old exact-string form broke the moment width/height
    // stopped being stripped.
    expect(stored).toContain("<rect");
    expect(stored).toContain('width="12"');
    expect(stored).toContain('fill="#f00"');
  });

  test("serves the sanitized bytes, never the original", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const path = join(fixtureDir(), "dirty.svg");
    writeFileSync(path, DIRTY_SVG);
    const upload = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    const asset = (await upload.json()) as Asset;
    const res = await fetch(`${s.hostUrl}/assets/${asset.id}`);
    const served = await res.text();
    expect(served).not.toContain("<script");
    expect(served).not.toContain("evil.example");
  });

  // Regression (dogfooded on the M5+M6 acceptance board): DOMPurify checks
  // ALLOWED_URI_REGEXP against EVERY attribute value, not just href/src —
  // with a bare /^#/ the entire geometry layer (x/y/width/height/viewBox/d)
  // was stripped and only #-valued fills survived, so benign drawings
  // rendered blank.
  test("benign geometry survives sanitization intact", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
      '  <rect x="40" y="40" width="200" height="80" rx="10" fill="#d9d7cf"/>',
      '  <path d="M 240 80 L 220 160" stroke="#8a5cc2" stroke-width="4"/>',
      '  <circle cx="320" cy="180" r="18" fill="#7fa98c"/>',
      '  <text x="140" y="72" text-anchor="middle" font-family="monospace" font-size="15" fill="#333">agent</text>',
      "</svg>",
    ].join("\n");
    const path = join(fixtureDir(), "geometry.svg");
    writeFileSync(path, svg);
    const res = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    expect(res.status).toBe(201);
    const asset = (await res.json()) as Asset;
    const stored = readFileSync(
      join(s.dataDir, "boards", board.id, "assets", asset.file),
      "utf8",
    );
    expect(stored).toContain('width="640"');
    expect(stored).toContain('viewBox="0 0 640 360"');
    expect(stored).toContain('x="40"');
    expect(stored).toContain('rx="10"');
    expect(stored).toContain('d="M 240 80 L 220 160"');
    expect(stored).toContain('cx="320"');
    expect(stored).toContain('text-anchor="middle"');
    expect(stored).toContain('font-size="15"');
    expect(stored).toContain("agent");
  });

  test("rejects non-svg content behind an .svg name", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const path = join(fixtureDir(), "not-a-svg.svg");
    writeFileSync(path, "just some text, no svg here");
    const res = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("asset_not_an_image");
  });

  test("rejects svg-declared real image bytes", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const res = await uploadBinary(
      s,
      token,
      board.id,
      pngBytes(64),
      "image/svg+xml",
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("asset_not_an_image");
  });
});

describe("GET /assets/:id", () => {
  test("serves bytes unauthenticated with pinned content type, nosniff, and immutable cache", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const bytes = pngBytes(64);
    const path = join(fixtureDir(), "serve.png");
    writeFileSync(path, bytes);
    const upload = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    const asset = (await upload.json()) as Asset;

    // no Authorization header: img elements cannot send one
    const res = await fetch(`${s.hostUrl}/assets/${asset.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("404s a shape-valid unknown id with asset_not_found", async () => {
    const s = server();
    const res = await fetch(`${s.hostUrl}/assets/zzzzzzzzzz`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("asset_not_found");
  });

  test("non-GET methods are rejected with 405 and Allow: GET", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const path = join(fixtureDir(), "post.png");
    writeFileSync(path, pngBytes(32));
    const upload = await s.api.post(
      "/api/assets",
      { board_id: board.id, path },
      { token },
    );
    const asset = (await upload.json()) as Asset;
    const res = await fetch(`${s.hostUrl}/assets/${asset.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "x",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("markdown asset embeds", () => {
  async function ingestPng(s: TestServer, token: string, boardId: string) {
    const path = join(fixtureDir(), `embed-${Math.random()}.png`);
    writeFileSync(path, pngBytes(32));
    const res = await s.api.post(
      "/api/assets",
      { board_id: boardId, path },
      { token },
    );
    expect(res.status).toBe(201);
    return (await res.json()) as Asset;
  }

  test("renders ![alt](asset:<id>) as an img through the full publish path", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const asset = await ingestPng(s, token, board.id);
    const res = await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: `# Shots\n\n![screenshot](asset:${asset.id})\n`,
        expected_version: 0,
      },
      { token },
    );
    expect(res.status).toBe(201);
    const version = (await res.json()) as { content: string };
    expect(version.content).toContain(
      `<img src="/assets/${asset.id}" alt="screenshot">`,
    );
  });

  test("keeps DOMPurify intact around asset embeds (invariant 5)", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const asset = await ingestPng(s, token, board.id);
    const res = await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: `<script>alert(1)</script>\n\n![shot](asset:${asset.id})\n`,
        expected_version: 0,
      },
      { token },
    );
    const version = (await res.json()) as { content: string };
    expect(version.content).not.toContain("<script");
    expect(version.content).not.toContain("alert(1)");
    expect(version.content).toContain(`src="/assets/${asset.id}"`);
  });

  test("shape-valid unknown ids degrade to honest broken images at serve time", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const res = await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: "![gone](asset:zzzzzzzzzz)",
        expected_version: 0,
      },
      { token },
    );
    // the id shape is right — the asset may be minted after the draft; the
    // img points at the serve route and 404s there until it exists
    expect(res.status).toBe(201);
    const version = (await res.json()) as { content: string };
    expect(version.content).toContain('src="/assets/zzzzzzzzzz"');
  });

  test("malformed asset embeds are a 400 invalid_asset_embed naming the src", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    // "asset:undefined" is the live dogfood root cause: an agent script
    // interpolated an undefined variable into the embed
    for (const src of ["asset:undefined", "asset:abc"]) {
      const res = await s.api.post(
        `/api/boards/${board.id}/publish`,
        {
          format: "markdown",
          content: `![gone](${src})`,
          expected_version: 0,
        },
        { token },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("invalid_asset_embed");
      expect(body.error.message).toBe(`unknown asset embed "${src}"`);
      // nothing was written — the version sequence never advanced
      const versions = s.db
        .prepare("SELECT COUNT(*) AS c FROM versions WHERE board_id = ?")
        .get(board.id) as { c: number };
      expect(versions.c).toBe(0);
    }
  });

  test("non-asset images are not validated — a plain relative src publishes", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const res = await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: "![](foo.png)",
        expected_version: 0,
      },
      { token },
    );
    expect(res.status).toBe(201);
    const version = (await res.json()) as { content: string };
    expect(version.content).toContain('<img src="foo.png"');
  });
});

// MCP: board_upload_image — the file-copy path agents use (same service layer
// as POST /api/assets, so events cannot tell the two apart).
describe("mcp board_upload_image", () => {
  async function connectClient(s: TestServer, token: string): Promise<Client> {
    const client = new Client({ name: "mcp-asset-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${s.hostUrl}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport);
    return client;
  }

  interface ToolPayload {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }

  async function callTool(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolPayload> {
    return (await client.callTool({ name, arguments: args })) as ToolPayload;
  }

  function toolJson(result: ToolPayload): Record<string, unknown> {
    if (result.isError === true) {
      throw new Error(`tool failed: ${result.content[0]?.text}`);
    }
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  function toolText(result: ToolPayload): string {
    return result.content[0]?.text ?? "";
  }

  test("copies an image and returns the asset id plus embed snippets", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const client = await connectClient(s, token);
    try {
      const bytes = pngBytes(96);
      const path = join(fixtureDir(), "for-mcp.png");
      writeFileSync(path, bytes);
      const result = toolJson(
        await callTool(client, "board_upload_image", {
          board_id: board.id,
          path,
        }),
      );
      const assetId = result.asset_id as string;
      expect(assetId).toMatch(/^[0-9A-Za-z]{10}$/);
      expect(result.board_id).toBe(board.id);
      expect(result.mime).toBe("image/png");
      expect(result.size).toBe(96);
      expect(result.embed_markdown).toBe(`![image](asset:${assetId})`);
      expect(result.embed_html).toBe(`<img src="/assets/${assetId}">`);

      // the served asset is the copied file
      const res = await fetch(`${s.hostUrl}/assets/${assetId}`);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

      // same event trail as REST: one asset.added attributed to the agent
      const ev = assetEvent(s.db, board.id);
      expect(ev?.actor).toBe("assets-agent");
    } finally {
      await client.close();
    }
  });

  test("errors on a non-image path", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const client = await connectClient(s, token);
    try {
      const path = join(fixtureDir(), "not-an-image.txt");
      writeFileSync(path, "plain text");
      const result = await callTool(client, "board_upload_image", {
        board_id: board.id,
        path,
      });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("asset type not allowed");
    } finally {
      await client.close();
    }
  });

  test("errors on an unknown board", async () => {
    const { s, token } = await setup();
    const client = await connectClient(s, token);
    try {
      const path = join(fixtureDir(), "orphan.png");
      writeFileSync(path, pngBytes(32));
      const result = await callTool(client, "board_upload_image", {
        board_id: "zzzzzzzzzz",
        path,
      });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("not found");
    } finally {
      await client.close();
    }
  });
});
