import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Board, BoardEvent, Comment } from "../src/domain.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_MAGIC);
  return bytes;
}

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00f"/></svg>';
const DIRTY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00f"/><script>alert(1)</script></svg>';

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
  const agent = await s.createAgent("import-agent");
  return { s, token: agent.token };
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

// read the error body ONCE (a Response body cannot be consumed twice) and hand
// out the code, the decoded message, and the raw text. Assert against `message`
// when the expected substring contains quotes — `text` is still JSON-encoded,
// so a quoted item name appears there escaped.
async function errorBody(
  res: Response,
): Promise<{ code: string; message: string; text: string }> {
  const text = await res.text();
  const error = (
    JSON.parse(text) as { error: { code: string; message: string } }
  ).error;
  return { code: error.code, message: error.message, text };
}

async function makeBoard(
  s: TestServer,
  token: string,
  opts: { title?: string; format?: "markdown" | "html"; tags?: string[] } = {},
): Promise<Board> {
  const res = await s.api.post(
    "/api/boards",
    {
      title: opts.title ?? "Round trip",
      format: opts.format ?? "markdown",
      ...(opts.tags === undefined ? {} : { tags: opts.tags }),
    },
    { token },
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Board;
}

async function uploadAsset(
  s: TestServer,
  token: string,
  boardId: string,
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
): Promise<string> {
  const res = await fetch(`${s.hostUrl}/api/assets?board_id=${boardId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": mime },
    body: bytes,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function exportBundle(
  s: TestServer,
  token: string,
  boardId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await s.api.get(`/api/boards/${boardId}/export`, { token });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  return new Uint8Array(await res.arrayBuffer());
}

async function postImport(
  s: TestServer,
  token: string | undefined,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  return fetch(`${s.hostUrl}/api/boards/import`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/zip",
    },
    body: bytes,
  });
}

function counts(s: TestServer): { boards: number; events: number } {
  const boards = s.db.prepare("SELECT COUNT(*) AS c FROM boards").get() as {
    c: number;
  };
  const events = s.db.prepare("SELECT COUNT(*) AS c FROM events").get() as {
    c: number;
  };
  return { boards: boards.c, events: events.c };
}

function maxSeq(s: TestServer): number {
  const row = s.db.prepare("SELECT MAX(seq) AS m FROM events").get() as {
    m: number | null;
  };
  return row.m ?? 0;
}

function boardDirNames(s: TestServer): string[] {
  return readdirSync(join(s.dataDir, "boards"));
}

function unzip(zip: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zip);
}

// Mutate a bundle in memory and rezip — how the dirty-bundle tests hand-craft
// hostile bundles out of an honest export. zipSync allocates a fresh
// ArrayBuffer-backed array, so the ArrayBuffer narrowing is sound.
function rezip(entries: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  return zipSync(entries) as Uint8Array<ArrayBuffer>;
}

async function boardEvents(
  s: TestServer,
  token: string,
  boardId: string,
): Promise<BoardEvent[]> {
  const res = await s.api.get(`/api/boards/${boardId}/events`, { token });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: BoardEvent[] }).events;
}

async function commentsOf(
  s: TestServer,
  token: string,
  boardId: string,
): Promise<Comment[]> {
  const res = await s.api.get(`/api/boards/${boardId}/comments`, { token });
  expect(res.status).toBe(200);
  return ((await res.json()) as { comments: Comment[] }).comments;
}

describe("auth", () => {
  test("GET export and POST import reject missing tokens with 401", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const noTokenExport = await s.api.get(`/api/boards/${board.id}/export`);
    expect(noTokenExport.status).toBe(401);
    const noTokenImport = await postImport(s, undefined, new Uint8Array(8));
    expect(noTokenImport.status).toBe(401);
    expect(await errorCode(noTokenImport)).toBe("unauthorized");
  });
});

describe("GET /api/boards/:id/export", () => {
  test("an empty board exports a bundle whose manifest describes it", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token, { tags: ["m6", "cli"] });
    const zip = await exportBundle(s, token, board.id);
    const entries = unzip(zip);
    expect(Object.keys(entries).sort()).toEqual([
      "comments.json",
      "events.jsonl",
      "manifest.json",
    ]);
    const manifest = JSON.parse(
      strFromU8(entries["manifest.json"] ?? new Uint8Array()),
    ) as {
      schema_version: number;
      source_board_id: string;
      board: { title: string; format: string; status: string; tags: string[] };
      versions: unknown[];
      comments: { count: number };
      assets: unknown[];
    };
    expect(manifest.schema_version).toBe(1);
    expect(manifest.source_board_id).toBe(board.id);
    expect(manifest.board).toMatchObject({
      title: "Round trip",
      format: "markdown",
      status: "open",
      tags: ["m6", "cli"],
    });
    expect(manifest.versions).toEqual([]);
    expect(manifest.comments).toEqual({ count: 0 });
    expect(manifest.assets).toEqual([]);
  });

  test("works on ended boards (reads stay after end)", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const end = await s.api.post(`/api/boards/${board.id}/end`, {}, { token });
    expect(end.status).toBe(200);
    const res = await s.api.get(`/api/boards/${board.id}/export`, { token });
    expect(res.status).toBe(200);
  });

  test("404s an unknown board", async () => {
    const { s, token } = await setup();
    const res = await s.api.get("/api/boards/zzzzzzzzzz/export", { token });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });
});

// The full save/load story: markdown version with an asset embed, an html
// version, a threaded comment with a resolve, and two assets — exported,
// imported into the SAME data dir, and everything re-derived through the
// quarantine pipeline with fresh ids.
describe("export → import round trip", () => {
  interface Fixture {
    s: TestServer;
    token: string;
    board: Board;
    oldPngId: string;
    oldSvgId: string;
    root: Comment;
    reply: Comment;
    section: Comment;
    zip: Uint8Array<ArrayBuffer>;
    seqBefore: number;
  }

  async function build(): Promise<Fixture> {
    const { s, token } = await setup();
    const board = await makeBoard(s, token, { tags: ["m6"] });
    const oldPngId = await uploadAsset(
      s,
      token,
      board.id,
      pngBytes(96),
      "image/png",
    );
    const oldSvgId = await uploadAsset(
      s,
      token,
      board.id,
      new TextEncoder().encode(CLEAN_SVG),
      "image/svg+xml",
    );

    const v1 = await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: `# Shots\n\n![shot](asset:${oldPngId})\n\nPlain paragraph.\n`,
        expected_version: 0,
        label: "first cut",
      },
      { token },
    );
    expect(v1.status).toBe(201);
    const v1Body = (await v1.json()) as {
      anchors: Array<{ id: string; kind: string }>;
    };
    // the plain paragraph is the third top-level block (heading, img block, paragraph)
    const paragraph = v1Body.anchors.find(
      (a) => a.kind === "block" && a.id === "b3",
    );
    expect(paragraph).toBeDefined();

    const v2 = await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "html",
        content:
          '<!doctype html><html><body><section data-ba="s1" data-ba-label="Panel"><p>widget <img src="/assets/' +
          oldSvgId +
          '"></p></section></body></html>',
        expected_version: 1,
      },
      { token },
    );
    expect(v2.status).toBe(201);

    const rootRes = await s.api.post(
      `/api/boards/${board.id}/comments`,
      {
        anchor: {
          type: "text",
          section_id: "b3",
          originalText: "Plain paragraph",
          startOffset: 0,
          endOffset: 15,
        },
        body: "root comment",
        version_n: 1,
      },
      { token },
    );
    expect(rootRes.status).toBe(201);
    const rootCreated = (await rootRes.json()) as Comment;
    const replyRes = await s.api.post(
      `/api/comments/${rootCreated.id}/reply`,
      { body: "reply body" },
      { token },
    );
    expect(replyRes.status).toBe(201);
    const replyCreated = (await replyRes.json()) as Comment;
    const resolveRes = await s.api.post(
      `/api/comments/${rootCreated.id}/resolve`,
      {},
      { token },
    );
    expect(resolveRes.status).toBe(200);
    const sectionRes = await s.api.post(
      `/api/boards/${board.id}/comments`,
      {
        anchor: { type: "section", section_id: "s1" },
        body: "section comment",
        version_n: 2,
      },
      { token },
    );
    expect(sectionRes.status).toBe(201);
    const sectionCreated = (await sectionRes.json()) as Comment;

    // re-read AFTER resolve so the fixture carries the final resolve state
    const originals = await commentsOf(s, token, board.id);
    const root = originals.find((c) => c.id === rootCreated.id) ?? rootCreated;
    const reply =
      originals.find((c) => c.id === replyCreated.id) ?? replyCreated;
    const section =
      originals.find((c) => c.id === sectionCreated.id) ?? sectionCreated;

    // a subscription event in the bundle proves the audit snapshot is NOT
    // replayed into the live log on import
    const sub = await s.api.post(
      `/api/boards/${board.id}/subscribe`,
      { webhook_url: "http://127.0.0.1:1/nope" },
      { token },
    );
    expect(sub.status).toBe(201);

    const seqBefore = maxSeq(s);
    const zip = await exportBundle(s, token, board.id);
    return {
      s,
      token,
      board,
      oldPngId,
      oldSvgId,
      root,
      reply,
      section,
      zip,
      seqBefore,
    };
  }

  test("imports under a new id with versions re-rendered and ids remapped", async () => {
    const f = await build();

    const res = await postImport(f.s, f.token, f.zip);
    expect(res.status).toBe(201);
    const imported = (await res.json()) as Board;
    expect(imported.id).not.toBe(f.board.id);
    expect(imported.id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(imported.title).toBe("Round trip");
    expect(imported.format).toBe("markdown");
    expect(imported.status).toBe("open");
    expect(imported.tags).toEqual(["m6"]);
    expect(imported.created_by).toBe("import-agent");
    expect(imported.current_version).toBe(2);

    // markdown v1: re-rendered through DOMPurify, embed remapped to the NEW id
    const v1res = await f.s.api.get(`/api/boards/${imported.id}/versions/1`, {
      token: f.token,
    });
    expect(v1res.status).toBe(200);
    const v1 = (await v1res.json()) as {
      content: string;
      source_md: string | null;
      label: string | null;
      anchors: Array<{ id: string; kind: string }>;
    };
    const assetRows = f.s.db
      .prepare(
        "SELECT id, mime FROM assets WHERE board_id = ? ORDER BY created_at, id",
      )
      .all(imported.id) as Array<{ id: string; mime: string }>;
    expect(assetRows).toHaveLength(2);
    const newPng = assetRows.find((a) => a.mime === "image/png");
    const newSvg = assetRows.find((a) => a.mime === "image/svg+xml");
    expect(newPng).toBeDefined();
    expect(newSvg).toBeDefined();
    expect(newPng?.id).not.toBe(f.oldPngId);
    expect(newSvg?.id).not.toBe(f.oldSvgId);

    expect(v1.content).toContain(`src="/assets/${newPng?.id}"`);
    expect(v1.content).not.toContain(f.oldPngId);
    expect(v1.content).not.toContain("asset:");
    expect(v1.content).not.toContain("<script");
    // source is the remapped markdown, label preserved
    expect(v1.source_md).toContain(`asset:${newPng?.id}`);
    expect(v1.source_md).not.toContain(f.oldPngId);
    expect(v1.label).toBe("first cut");
    // fresh deterministic anchor ids on the re-rendered document
    expect(v1.anchors.map((a) => a.id)).toEqual(["b1", "b2", "b3"]);

    // html v2: re-derived with the bundle's data-ba ids kept, src remapped
    const v2res = await f.s.api.get(`/api/boards/${imported.id}/versions/2`, {
      token: f.token,
    });
    expect(v2res.status).toBe(200);
    const v2 = (await v2res.json()) as {
      content: string;
      anchors: Array<{ id: string; kind: string }>;
    };
    expect(v2.content).toContain('data-ba="s1"');
    expect(v2.content).toContain(`src="/assets/${newSvg?.id}"`);
    expect(v2.content).not.toContain(f.oldSvgId);
    expect(v2.anchors.some((a) => a.id === "s1")).toBe(true);

    // assets re-verified through the ingest pipeline: new ids, same bytes,
    // svg still clean
    const pngRes = await fetch(`${f.s.hostUrl}/assets/${newPng?.id}`);
    expect(pngRes.status).toBe(200);
    expect(new Uint8Array(await pngRes.arrayBuffer())).toEqual(pngBytes(96));
    const svgRes = await fetch(`${f.s.hostUrl}/assets/${newSvg?.id}`);
    expect(svgRes.status).toBe(200);
    const svgText = await svgRes.text();
    expect(svgText).toContain("<svg");
    expect(svgText).not.toContain("<script");

    // comments: fresh ids, remapped threading, preserved authors/timestamps/
    // resolve state; anchors survive re-derivation
    const comments = await commentsOf(f.s, f.token, imported.id);
    expect(comments).toHaveLength(3);
    const byBody = new Map(comments.map((c) => [c.body, c]));
    const root = byBody.get("root comment");
    const reply = byBody.get("reply body");
    const section = byBody.get("section comment");
    expect(root).toBeDefined();
    expect(reply).toBeDefined();
    expect(section).toBeDefined();
    expect(root?.id).not.toBe(f.root.id);
    expect(root?.author).toBe(f.root.author);
    expect(root?.created_at).toBe(f.root.created_at);
    expect(root?.resolved_at).toBe(f.root.resolved_at);
    expect(root?.resolved_by).toBe(f.root.resolved_by);
    expect(root?.resolved_at).not.toBeNull();
    expect(root?.anchor).toEqual(f.root.anchor);
    expect(reply?.in_reply_to).toBe(root?.id);
    expect(reply?.in_reply_to).not.toBe(f.reply.in_reply_to);
    expect(section?.anchor).toEqual({ type: "section", section_id: "s1" });
    expect(section?.version_n).toBe(2);

    // the new board's log: board.created, board.imported, then replayed
    // mutations — and NONE of the bundle's audit events (no agent.subscribed)
    const events = await boardEvents(f.s, f.token, imported.id);
    expect(events.map((e) => e.type)).toEqual([
      "board.created",
      "board.imported",
      "asset.added",
      "asset.added",
      "board.published",
      "board.published",
      "comment.created",
      "comment.resolved",
      "comment.replied",
      "comment.created",
    ]);
    const importedEv = events[1];
    expect(importedEv.payload).toEqual({
      source_board_id: f.board.id,
      versions: 2,
      assets: 2,
      comments: 3,
    });
    expect(events.some((e) => e.type === "agent.subscribed")).toBe(false);
    // global seq stays append-only monotonic: the new board's events are all
    // fresh (above the pre-import max), never the bundle's old seqs
    for (const ev of events) {
      expect(ev.seq).toBeGreaterThan(f.seqBefore);
    }
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    // comment rows carry their creation event's seq (cursor substrate)
    expect(root?.seq).toBe(events[6]?.seq);
  });

  test("the audit snapshot rides along in the bundle but is never replayed", async () => {
    const f = await build();
    const entries = unzip(f.zip);
    const snapshot = strFromU8(entries["events.jsonl"] ?? new Uint8Array());
    expect(snapshot).toContain('"agent.subscribed"');
    const before = counts(f.s);
    const res = await postImport(f.s, f.token, f.zip);
    expect(res.status).toBe(201);
    const imported = (await res.json()) as Board;
    const events = await boardEvents(f.s, f.token, imported.id);
    expect(events.some((e) => e.type === "agent.subscribed")).toBe(false);
    expect(before.events).toBeLessThan(counts(f.s).events);
  });
});

describe("dirty bundles are rejected (quarantine)", () => {
  async function importMutated(
    f: { s: TestServer; token: string; zip: Uint8Array },
    mutate: (entries: Record<string, Uint8Array>) => void,
  ): Promise<Response> {
    const entries = unzip(f.zip);
    mutate(entries);
    return postImport(f.s, f.token, rezip(entries));
  }

  async function simpleBoardBundle() {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: "# Clean\n\nA clean paragraph.\n",
        expected_version: 0,
      },
      { token },
    );
    const zip = await exportBundle(s, token, board.id);
    return { s, token, board, zip };
  }

  test("hand-crafted script-injected markdown is re-sanitized on import", async () => {
    const f = await simpleBoardBundle();
    const res = await importMutated(f, (entries) => {
      entries["content/1.md"] = new TextEncoder().encode(
        "<script>alert(1)</script>\n\n# Dirty heading\n",
      );
    });
    expect(res.status).toBe(201);
    const imported = (await res.json()) as Board;
    const v1res = await f.s.api.get(`/api/boards/${imported.id}/versions/1`, {
      token: f.token,
    });
    const v1 = (await v1res.json()) as { content: string };
    expect(v1.content).not.toContain("<script");
    expect(v1.content).not.toContain("alert(1)");
    expect(v1.content).toContain("Dirty heading");
  });

  test("an svg carrying a script is rejected 422 with nothing written", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const oldSvgId = await uploadAsset(
      s,
      token,
      board.id,
      new TextEncoder().encode(CLEAN_SVG),
      "image/svg+xml",
    );
    const zip = await exportBundle(s, token, board.id);
    const before = counts(s);
    const dirsBefore = boardDirNames(s);

    const res = await importMutated({ s, token, zip }, (entries) => {
      // patch the manifest size to match the dirty bytes so the TAMPER check
      // is what fires (not the size-mismatch check)
      const manifest = JSON.parse(
        strFromU8(entries["manifest.json"] ?? new Uint8Array()),
      ) as { assets: Array<{ id: string; size: number }> };
      const dirty = new TextEncoder().encode(DIRTY_SVG);
      manifest.assets[0].size = dirty.byteLength;
      entries["manifest.json"] = new TextEncoder().encode(
        JSON.stringify(manifest),
      );
      entries[`assets/${oldSvgId}.svg`] = dirty;
    });
    expect(res.status).toBe(422);
    const { code, text } = await errorBody(res);
    expect(code).toBe("import_rejected");
    expect(text).toContain(oldSvgId);
    // nothing half-imported
    expect(counts(s)).toEqual(before);
    expect(boardDirNames(s)).toEqual(dirsBefore);
  });

  test("a non-allowlisted asset mime is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      const manifest = JSON.parse(
        strFromU8(entries["manifest.json"] ?? new Uint8Array()),
      ) as { assets: Array<unknown> };
      manifest.assets.push({
        id: "aaaaaaaaaa",
        file: "assets/aaaaaaaaaa.txt",
        mime: "text/plain",
        size: 9,
        source: "copy",
        created_by: "x",
        created_at: "2026-09-15T00:00:00.000Z",
      });
      entries["manifest.json"] = new TextEncoder().encode(
        JSON.stringify(manifest),
      );
      entries["assets/aaaaaaaaaa.txt"] = new TextEncoder().encode("not image");
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("import_rejected");
    expect(counts(f.s)).toEqual(before);
  });

  test("a zip-slip entry is rejected 422 with nothing written", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const dirsBefore = boardDirNames(f.s);
    const res = await importMutated(f, (entries) => {
      entries["../evil.txt"] = new TextEncoder().encode("gotcha");
    });
    expect(res.status).toBe(422);
    const { code, text } = await errorBody(res);
    expect(code).toBe("import_rejected");
    expect(text).toContain("../evil.txt");
    expect(counts(f.s)).toEqual(before);
    expect(boardDirNames(f.s)).toEqual(dirsBefore);
  });

  test("an unknown manifest schema version is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      const manifest = JSON.parse(
        strFromU8(entries["manifest.json"] ?? new Uint8Array()),
      ) as { schema_version: number };
      manifest.schema_version = 99;
      entries["manifest.json"] = new TextEncoder().encode(
        JSON.stringify(manifest),
      );
    });
    expect(res.status).toBe(422);
    const { code, text } = await errorBody(res);
    expect(code).toBe("import_rejected");
    expect(text).toContain("schema version 99");
    expect(counts(f.s)).toEqual(before);
  });

  test("a version referencing an asset the bundle lacks is rejected 422", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const oldPngId = await uploadAsset(
      s,
      token,
      board.id,
      pngBytes(64),
      "image/png",
    );
    await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: `![shot](asset:${oldPngId})\n`,
        expected_version: 0,
      },
      { token },
    );
    const zip = await exportBundle(s, token, board.id);
    const before = counts(s);
    // strip the asset from the bundle but keep the embed — the import must
    // not resolve the id against OTHER boards' assets (the index is global)
    const res = await importMutated({ s, token, zip }, (entries) => {
      const manifest = JSON.parse(
        strFromU8(entries["manifest.json"] ?? new Uint8Array()),
      ) as { assets: Array<{ id: string }> };
      manifest.assets = manifest.assets.filter((a) => a.id !== oldPngId);
      entries["manifest.json"] = new TextEncoder().encode(
        JSON.stringify(manifest),
      );
      for (const name of Object.keys(entries)) {
        if (name.startsWith(`assets/${oldPngId}.`)) {
          delete entries[name];
        }
      }
    });
    expect(res.status).toBe(422);
    const { code, text } = await errorBody(res);
    expect(code).toBe("import_rejected");
    expect(text).toContain(oldPngId);
    expect(counts(s)).toEqual(before);
  });

  test("bytes that are not a zip at all are rejected 422", async () => {
    const { s, token } = await setup();
    const res = await postImport(
      s,
      token,
      new TextEncoder().encode("definitely not a zip"),
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("import_rejected");
  });

  test("an entry the manifest does not name is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      entries["assets/bbbbbbbbbb.png"] = pngBytes(32);
    });
    expect(res.status).toBe(422);
    const { text } = await errorBody(res);
    expect(text).toContain("assets/bbbbbbbbbb.png");
    expect(counts(f.s)).toEqual(before);
  });

  // The documented caps (docs/security.md "Content rules", "Assets") — spelled
  // out rather than imported from the source under test, so moving one is a
  // deliberate, visible change here too.
  const DOC_CAP_BYTES = 8 * 1024 * 1024;
  const BOARD_ASSET_CAP_BYTES = 8 * 1024 * 1024;

  // Manifest surgery in one place: the strict-schema tests below all reach into
  // the parsed manifest, edit it, and re-encode.
  function patchManifest(
    entries: Record<string, Uint8Array>,
    edit: (manifest: Record<string, unknown>) => void,
  ): void {
    const manifest = JSON.parse(
      strFromU8(entries["manifest.json"] ?? new Uint8Array()),
    ) as Record<string, unknown>;
    edit(manifest);
    entries["manifest.json"] = new TextEncoder().encode(
      JSON.stringify(manifest),
    );
  }

  function manifestAssets(
    manifest: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    return manifest.assets as Array<Record<string, unknown>>;
  }

  // A shape-valid manifest asset entry. The size-cap and shape tests declare
  // these WITHOUT shipping bytes: the checks they exercise fire before the zip
  // entry is looked up, so the fixtures stay bytes-free and fast.
  function assetEntry(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: "aaaaaaaaaa",
      file: "assets/aaaaaaaaaa.png",
      mime: "image/png",
      size: 32,
      source: "copy",
      created_by: "x",
      created_at: "2026-09-15T00:00:00.000Z",
      ...overrides,
    };
  }

  // A shape-valid comments.json entry, for the tests that write that file from
  // scratch (a simple board bundle carries an empty comments array).
  function commentEntry(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: "cccccccccc",
      version_n: 1,
      anchor: { type: "board" },
      body: "a comment",
      author: "someone",
      in_reply_to: null,
      created_at: "2026-09-15T00:00:00.000Z",
      edited_at: null,
      resolved_at: null,
      resolved_by: null,
      ...overrides,
    };
  }

  function writeComments(
    entries: Record<string, Uint8Array>,
    comments: Array<Record<string, unknown>>,
  ): void {
    entries["comments.json"] = new TextEncoder().encode(
      JSON.stringify({ comments }),
    );
  }

  // A bundle whose one markdown version embeds one real png asset — the fixture
  // the tests that need actual asset bytes on disk mutate.
  async function assetBoardBundle(): Promise<{
    s: TestServer;
    token: string;
    assetId: string;
    zip: Uint8Array<ArrayBuffer>;
  }> {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    const assetId = await uploadAsset(
      s,
      token,
      board.id,
      pngBytes(64),
      "image/png",
    );
    const publish = await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: `![shot](asset:${assetId})\n`,
        expected_version: 0,
      },
      { token },
    );
    expect(publish.status).toBe(201);
    const zip = await exportBundle(s, token, board.id);
    return { s, token, assetId, zip };
  }

  // Every rejection below asserts the SPECIFIC one: 422, the import_rejected
  // code, and that the message names the offending item — a test that only
  // asserts "something threw" passes for the wrong reason when the rejection
  // moves. Nothing-written rides along, because that is the quarantine.
  async function expectRejected(
    s: TestServer,
    before: { boards: number; events: number },
    res: Response,
    ...named: string[]
  ): Promise<void> {
    expect(res.status).toBe(422);
    const { code, message } = await errorBody(res);
    expect(code).toBe("import_rejected");
    for (const name of named) {
      expect(message).toContain(name);
    }
    expect(counts(s)).toEqual(before);
  }

  // The strict manifest (docs/security.md "Import quarantine") is what keeps a
  // smuggled field from riding along into a future schema reader.
  test("an unknown manifest top-level field is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      patchManifest(entries, (manifest) => {
        manifest.extra = 1;
      });
    });
    await expectRejected(f.s, before, res, 'unknown field "extra"');
  });

  test("an off-enum board.format is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      patchManifest(entries, (manifest) => {
        (manifest.board as Record<string, unknown>).format = "pdf";
      });
    });
    await expectRejected(
      f.s,
      before,
      res,
      'board.format must be "markdown" or "html"',
    );
  });

  test("an off-enum board.status is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      patchManifest(entries, (manifest) => {
        (manifest.board as Record<string, unknown>).status = "archived";
      });
    });
    await expectRejected(
      f.s,
      before,
      res,
      'board.status must be "open" or "ended"',
    );
  });

  test("a bundle missing events.jsonl is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      delete entries["events.jsonl"];
    });
    await expectRejected(
      f.s,
      before,
      res,
      "bundle is missing manifest.json, comments.json, or events.jsonl",
    );
  });

  test("a bundle missing comments.json is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      delete entries["comments.json"];
    });
    await expectRejected(
      f.s,
      before,
      res,
      "bundle is missing manifest.json, comments.json, or events.jsonl",
    );
  });

  // The quarantine re-render is not decoration: a version the real pipeline
  // refuses is a 422 naming the version, never a stored half-document.
  // renderMarkdownDocument throws InvalidAssetEmbed on a shape-invalid
  // `asset:` src (render.ts rewriteAssetUris) — a shape-VALID unknown id is
  // caught later by the self-containment check instead.
  test("a version the render pipeline refuses is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      entries["content/1.md"] = new TextEncoder().encode(
        "![shot](asset:nope)\n",
      );
    });
    await expectRejected(
      f.s,
      before,
      res,
      "version 1 failed to render",
      'unknown asset embed "asset:nope"',
    );
  });

  test("version content over the document cap is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const oversize = DOC_CAP_BYTES + 1;
    const res = await importMutated(f, (entries) => {
      // generated, not a committed fixture: 8 MB of one byte deflates to
      // nothing, so the zip stays small and the test stays fast
      entries["content/1.md"] = new Uint8Array(oversize).fill(0x61);
    });
    await expectRejected(
      f.s,
      before,
      res,
      `version 1 content is ${oversize} bytes`,
      `exceeding the ${DOC_CAP_BYTES} byte cap`,
    );
  });

  // The per-board asset quota is checked on the manifest's DECLARED sizes,
  // before any asset bytes are read — several modest assets summing past the
  // cap are refused as one hostile bundle.
  test("declared assets summing past the per-board cap are rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    // real bytes, so the declared total is the ONLY thing wrong with this
    // bundle: 5 MB of png-headed zeros deflates to nothing
    const half = 5 * 1024 * 1024;
    const res = await importMutated(f, (entries) => {
      patchManifest(entries, (manifest) => {
        manifestAssets(manifest).push(
          assetEntry({ size: half }),
          assetEntry({
            id: "bbbbbbbbbb",
            file: "assets/bbbbbbbbbb.png",
            size: half,
          }),
        );
      });
      entries["assets/aaaaaaaaaa.png"] = pngBytes(half);
      entries["assets/bbbbbbbbbb.png"] = pngBytes(half);
    });
    await expectRejected(
      f.s,
      before,
      res,
      `bundle assets total ${half * 2} bytes`,
      `exceeding the ${BOARD_ASSET_CAP_BYTES} byte per-board cap`,
    );
  });

  test("an asset id that is not the 10-char shape is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      patchManifest(entries, (manifest) => {
        manifestAssets(manifest).push(
          assetEntry({ id: "short", file: "assets/short.png" }),
        );
      });
    });
    await expectRejected(
      f.s,
      before,
      res,
      'asset id "short" has an unexpected shape',
    );
  });

  // assets[].file is the ONE manifest string used as a lookup key, so its shape
  // is pinned to "assets/<id>.<ext>" — a traversal spelling never becomes a key.
  test("an asset file that is not assets/<id>.<ext> is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      patchManifest(entries, (manifest) => {
        manifestAssets(manifest).push(assetEntry({ file: "assets/../x.png" }));
      });
    });
    await expectRejected(
      f.s,
      before,
      res,
      'assets[aaaaaaaaaa].file must be "assets/aaaaaaaaaa.<ext>"',
    );
  });

  test("stored asset bytes disagreeing with the manifest size are rejected 422", async () => {
    const f = await assetBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      patchManifest(entries, (manifest) => {
        const asset = manifestAssets(manifest)[0];
        asset.size = (asset.size as number) + 1;
      });
    });
    await expectRejected(
      f.s,
      before,
      res,
      `asset "${f.assetId}" is 64 bytes but the manifest says 65`,
    );
  });

  test("a comments.count that disagrees with comments.json is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      writeComments(entries, [commentEntry()]);
    });
    await expectRejected(
      f.s,
      before,
      res,
      "comments.count is 0 but comments.json has 1",
    );
  });

  test("a comment anchoring an asset the bundle lacks is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      writeComments(entries, [
        commentEntry({ anchor: { type: "image", asset_id: "aaaaaaaaaa" } }),
      ]);
      patchManifest(entries, (manifest) => {
        (manifest.comments as Record<string, unknown>).count = 1;
      });
    });
    await expectRejected(
      f.s,
      before,
      res,
      'comment "cccccccccc" anchors asset "aaaaaaaaaa" which the bundle does not contain',
    );
  });

  test("a comments.json that is not JSON is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      entries["comments.json"] = new TextEncoder().encode("{not json");
    });
    await expectRejected(f.s, before, res, "comments.json is not valid JSON");
  });

  test("a duplicate comment id is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      writeComments(entries, [commentEntry(), commentEntry()]);
      patchManifest(entries, (manifest) => {
        (manifest.comments as Record<string, unknown>).count = 2;
      });
    });
    await expectRejected(f.s, before, res, 'duplicate comment id "cccccccccc"');
  });

  test("a comment on a version the bundle does not have is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      writeComments(entries, [commentEntry({ version_n: 5 })]);
      patchManifest(entries, (manifest) => {
        (manifest.comments as Record<string, unknown>).count = 1;
      });
    });
    await expectRejected(
      f.s,
      before,
      res,
      "version_n 5 is not a version of this bundle",
    );
  });

  test("a reply citing a parent that is not earlier is rejected 422", async () => {
    const f = await simpleBoardBundle();
    const before = counts(f.s);
    const res = await importMutated(f, (entries) => {
      writeComments(entries, [commentEntry({ in_reply_to: "dddddddddd" })]);
      patchManifest(entries, (manifest) => {
        (manifest.comments as Record<string, unknown>).count = 1;
      });
    });
    await expectRejected(
      f.s,
      before,
      res,
      'in_reply_to "dddddddddd" is not an earlier comment',
    );
  });
});

describe("ended-board fidelity", () => {
  test("an ended board imports as ended and stays read-only", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await s.api.post(
      `/api/boards/${board.id}/publish`,
      {
        format: "markdown",
        content: "# Done\n\nAll threads settled.\n",
        expected_version: 0,
      },
      { token },
    );
    const end = await s.api.post(`/api/boards/${board.id}/end`, {}, { token });
    expect(end.status).toBe(200);
    const zip = await exportBundle(s, token, board.id);

    const res = await postImport(s, token, zip);
    expect(res.status).toBe(201);
    const imported = (await res.json()) as Board;
    expect(imported.id).not.toBe(board.id);
    expect(imported.status).toBe("ended");

    const events = await boardEvents(s, token, imported.id);
    expect(events[0]?.type).toBe("board.created");
    expect(events[1]?.type).toBe("board.imported");
    expect(events.at(-1)?.type).toBe("board.ended");
    // read-only: the restored board rejects writes like any ended board
    const publish = await s.api.post(
      `/api/boards/${imported.id}/publish`,
      { format: "markdown", content: "# x", expected_version: 1 },
      { token },
    );
    expect(publish.status).toBe(409);
    expect(await errorCode(publish)).toBe("board_ended");
  });
});

describe("mcp board_export", () => {
  async function connectClient(s: TestServer, token: string): Promise<Client> {
    const client = new Client({ name: "mcp-export-test", version: "0.0.1" });
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

  test("returns decodable base64 matching the REST export bytes", async () => {
    const { s, token } = await setup();
    const board = await makeBoard(s, token);
    await uploadAsset(s, token, board.id, pngBytes(64), "image/png");
    await s.api.post(
      `/api/boards/${board.id}/publish`,
      { format: "markdown", content: "# Export me\n", expected_version: 0 },
      { token },
    );
    const client = await connectClient(s, token);
    try {
      const result = await callTool(client, "board_export", {
        board_id: board.id,
      });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0].text) as {
        board_id: string;
        bytes: number;
        encoding: string;
        data: string;
      };
      expect(payload.board_id).toBe(board.id);
      expect(payload.encoding).toBe("base64");
      const decoded = new Uint8Array(Buffer.from(payload.data, "base64"));
      expect(decoded.byteLength).toBe(payload.bytes);
      // the same bundle the REST route serves: entries compare equal
      // (byte-identity is impossible across two calls — the manifest stamps
      // exported_at at ms precision; everything else must match exactly)
      const restZip = await exportBundle(s, token, board.id);
      const mcpEntries = unzipSync(decoded);
      const restEntries = unzipSync(restZip);
      expect(Object.keys(mcpEntries).sort()).toEqual(
        Object.keys(restEntries).sort(),
      );
      const stripStamp = (zip: Record<string, Uint8Array>) => {
        const manifest = JSON.parse(
          strFromU8(zip["manifest.json"] ?? new Uint8Array()),
        ) as { exported_at?: string };
        delete manifest.exported_at;
        zip["manifest.json"] = strToU8(JSON.stringify(manifest));
        return zip;
      };
      expect(stripStamp(mcpEntries)).toEqual(stripStamp(restEntries));
      expect(Object.keys(mcpEntries)).toContain("events.jsonl");
    } finally {
      await client.close();
    }
  });

  test("errors on an unknown board", async () => {
    const { s, token } = await setup();
    const client = await connectClient(s, token);
    try {
      const result = await callTool(client, "board_export", {
        board_id: "zzzzzzzzzz",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("not found");
    } finally {
      await client.close();
    }
  });
});
