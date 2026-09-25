import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestAsset } from "./assets.ts";
import {
  BoardEnded,
  BoardNotFound,
  createBoard,
  endBoard,
  publishVersion,
  VersionNotFound,
} from "./boards.ts";
import {
  boardsWithCounts,
  CommentBodyRequired,
  CommentNotFound,
  countUnresolvedRoots,
  createComment,
  getComment,
  InvalidAnchor,
  listComments,
  listCommentsPage,
  maxCommentSeq,
  replyComment,
  resolveComment,
  validateAnchor,
} from "./comments.ts";
import { openDb } from "./db.ts";
import type { Anchor, ImageOverlay, Version } from "./domain.ts";
import { getEvents } from "./events.ts";

const MD = `# Heading

alpha beta gamma

| A | B |
| --- | --- |
| one | two |
| three | four |
`;

// In-test png bytes with the real magic signature (no binary fixtures) —
// ingest verifies magic bytes, so the anchor tests need plausible image bytes.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_MAGIC);
  return bytes;
}

let db: Database;
let dataDir: string;
let boardId: string;
let version: Version;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "board-comments-test-"));
  db = openDb(dataDir);
  const board = createBoard(db, dataDir, {
    title: "Anchors",
    format: "markdown",
    actor: "agent-1",
  });
  boardId = board.id;
  version = await publishVersion(db, dataDir, boardId, {
    format: "markdown",
    content: MD,
    expected_version: 0,
    actor: "agent-1",
  });
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("validateAnchor", () => {
  test("board anchors are always valid", () => {
    validateAnchor(db, { type: "board" }, version);
  });

  test("section anchors resolve against the stored version", () => {
    validateAnchor(db, { type: "section", section_id: "b1" }, version);
    validateAnchor(db, { type: "section", section_id: "b2" }, version);
  });

  test("unknown section id rejects", () => {
    expect(() =>
      validateAnchor(db, { type: "section", section_id: "b99" }, version),
    ).toThrow(InvalidAnchor);
  });

  test("text anchors validate by quote containment in the section", () => {
    validateAnchor(
      db,
      {
        type: "text",
        section_id: "b2",
        originalText: "beta",
        startOffset: 6,
        endOffset: 10,
      },
      version,
    );
  });

  test("text anchor with a quote absent from the section rejects", () => {
    expect(() =>
      validateAnchor(
        db,
        {
          type: "text",
          section_id: "b2",
          originalText: "delta",
          startOffset: 0,
          endOffset: 5,
        },
        version,
      ),
    ).toThrow(InvalidAnchor);
  });

  test("text anchor with an unknown section rejects", () => {
    expect(() =>
      validateAnchor(
        db,
        {
          type: "text",
          section_id: "b99",
          originalText: "beta",
          startOffset: 0,
          endOffset: 4,
        },
        version,
      ),
    ).toThrow(InvalidAnchor);
  });

  test("row anchors resolve by their row element", () => {
    validateAnchor(
      db,
      { type: "row", section_id: "b3", row_id: "b3r2" },
      version,
    );
  });

  test("unknown row id rejects", () => {
    expect(() =>
      validateAnchor(
        db,
        { type: "row", section_id: "b3", row_id: "b3r99" },
        version,
      ),
    ).toThrow(InvalidAnchor);
  });

  test("image anchor with an ingested asset and a well-formed overlay passes", () => {
    const asset = ingestAsset(db, dataDir, boardId, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    validateAnchor(
      db,
      {
        type: "image",
        asset_id: asset.id,
        overlay: {
          arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
          boxes: [{ x: 0.8, y: 0.1, text: "this label overflows" }],
        },
      },
      version,
    );
  });

  test("image anchor without an overlay passes (docs/plan.md: overlay?)", () => {
    const asset = ingestAsset(db, dataDir, boardId, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    validateAnchor(db, { type: "image", asset_id: asset.id }, version);
  });

  test("image anchor with an unknown asset rejects", () => {
    expect(() =>
      validateAnchor(
        db,
        {
          type: "image",
          asset_id: "nosuchasset",
          overlay: { arrows: [], boxes: [] },
        },
        version,
      ),
    ).toThrow(InvalidAnchor);
  });

  test("image anchor referencing another board's asset rejects", () => {
    const other = createBoard(db, dataDir, {
      title: "Asset host",
      format: "markdown",
      actor: "agent-1",
    });
    const asset = ingestAsset(db, dataDir, other.id, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    expect(() =>
      validateAnchor(
        db,
        {
          type: "image",
          asset_id: asset.id,
          overlay: { arrows: [], boxes: [] },
        },
        version,
      ),
    ).toThrow(/different board/);
  });

  test("overlay arrow coordinates outside [0,1] reject", () => {
    const asset = ingestAsset(db, dataDir, boardId, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      expect(() =>
        validateAnchor(
          db,
          {
            type: "image",
            asset_id: asset.id,
            overlay: { arrows: [{ x1: bad, y1: 0, x2: 1, y2: 1 }], boxes: [] },
          },
          version,
        ),
      ).toThrow(InvalidAnchor);
    }
  });

  test("overlay box coordinates outside [0,1] reject", () => {
    const asset = ingestAsset(db, dataDir, boardId, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    expect(() =>
      validateAnchor(
        db,
        {
          type: "image",
          asset_id: asset.id,
          overlay: { arrows: [], boxes: [{ x: 1.5, y: 0, text: "x" }] },
        },
        version,
      ),
    ).toThrow(InvalidAnchor);
  });

  test("overlay box text over the cap rejects", () => {
    const asset = ingestAsset(db, dataDir, boardId, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    expect(() =>
      validateAnchor(
        db,
        {
          type: "image",
          asset_id: asset.id,
          overlay: {
            arrows: [],
            boxes: [{ x: 0.5, y: 0.5, text: "x".repeat(201) }],
          },
        },
        version,
      ),
    ).toThrow(/200 char cap/);
  });

  test("overlay item counts over the cap reject", () => {
    const asset = ingestAsset(db, dataDir, boardId, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    const arrows = Array.from({ length: 51 }, () => ({
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
    }));
    expect(() =>
      validateAnchor(
        db,
        {
          type: "image",
          asset_id: asset.id,
          overlay: { arrows, boxes: [] },
        },
        version,
      ),
    ).toThrow(/50 item cap/);
  });

  test("createComment round-trips an image anchor with overlay", () => {
    const asset = ingestAsset(db, dataDir, boardId, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    const anchor = {
      type: "image" as const,
      asset_id: asset.id,
      overlay: {
        arrows: [{ x1: 0, y1: 0, x2: 1, y2: 1 }],
        boxes: [{ x: 0.5, y: 0.5, text: "note" }],
      },
    };
    const comment = createComment(db, dataDir, boardId, {
      anchor,
      body: "see the arrow",
      version_n: 1,
      actor: "human",
    });
    expect(getComment(db, comment.id)?.anchor).toEqual(anchor);
  });
});

describe("createComment", () => {
  test("stamps the creation event's seq onto the row", () => {
    const comment = createComment(db, dataDir, boardId, {
      anchor: {
        type: "text",
        section_id: "b2",
        originalText: "beta",
        startOffset: 6,
        endOffset: 10,
      },
      body: "Tighten this wording.",
      version_n: 1,
      actor: "human",
    });
    expect(comment.seq).toBeGreaterThan(0);
    expect(comment.author).toBe("human");
    expect(comment.version_n).toBe(1);
    expect(comment.in_reply_to).toBe(null);
    const ev = getEvents(db).find(
      (candidate) => candidate.payload.comment_id === comment.id,
    );
    expect(ev?.type).toBe("comment.created");
    expect(ev?.seq).toBe(comment.seq);
    expect(ev?.actor).toBe("human");
  });

  test("unknown board rejects with BoardNotFound", () => {
    expect(() =>
      createComment(db, dataDir, "nosuchboard", {
        anchor: { type: "board" },
        body: "x",
        version_n: 1,
        actor: "human",
      }),
    ).toThrow(BoardNotFound);
  });

  test("unknown version rejects with VersionNotFound", () => {
    expect(() =>
      createComment(db, dataDir, boardId, {
        anchor: { type: "board" },
        body: "x",
        version_n: 9,
        actor: "human",
      }),
    ).toThrow(VersionNotFound);
  });

  test("unknown parent rejects with CommentNotFound", () => {
    expect(() =>
      createComment(db, dataDir, boardId, {
        anchor: { type: "board" },
        body: "x",
        version_n: 1,
        in_reply_to: "nosuchcomment",
        actor: "human",
      }),
    ).toThrow(CommentNotFound);
  });

  test("cross-board parent rejects with InvalidAnchor", async () => {
    const other = createBoard(db, dataDir, {
      title: "Other",
      format: "markdown",
      actor: "agent-1",
    });
    await publishVersion(db, dataDir, other.id, {
      format: "markdown",
      content: "# other",
      expected_version: 0,
      actor: "agent-1",
    });
    const root = createComment(db, dataDir, boardId, {
      anchor: { type: "board" },
      body: "root",
      version_n: 1,
      actor: "human",
    });
    expect(() =>
      createComment(db, dataDir, other.id, {
        anchor: { type: "board" },
        body: "stray reply",
        version_n: 1,
        in_reply_to: root.id,
        actor: "human",
      }),
    ).toThrow(InvalidAnchor);
  });
});

describe("comment body requirements (the overlay is the payload)", () => {
  const EMPTY_OVERLAY = { arrows: [], boxes: [] };

  function imageAnchorWith(
    overlay?: ImageOverlay,
  ): Extract<Anchor, { type: "image" }> {
    const asset = ingestAsset(db, dataDir, boardId, {
      bytes: pngBytes(),
      mime: "image/png",
      source: "binary",
      actor: "agent-1",
    });
    return overlay === undefined
      ? { type: "image", asset_id: asset.id }
      : { type: "image", asset_id: asset.id, overlay };
  }

  test("empty body + a root image anchor with overlay items posts", () => {
    const comment = createComment(db, dataDir, boardId, {
      anchor: imageAnchorWith({
        arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
        boxes: [],
      }),
      body: "",
      version_n: 1,
      actor: "human",
    });
    expect(getComment(db, comment.id)?.body).toBe("");
  });

  test("absent-equivalent whitespace body with an overlay also posts", () => {
    const comment = createComment(db, dataDir, boardId, {
      anchor: imageAnchorWith({
        arrows: [],
        boxes: [{ x: 0.5, y: 0.5, text: "look" }],
      }),
      body: "   ",
      version_n: 1,
      actor: "human",
    });
    expect(getComment(db, comment.id)?.body).toBe("   ");
  });

  test("empty body + a text anchor rejects", () => {
    expect(() =>
      createComment(db, dataDir, boardId, {
        anchor: {
          type: "text",
          section_id: "b2",
          originalText: "beta",
          startOffset: 6,
          endOffset: 10,
        },
        body: "",
        version_n: 1,
        actor: "human",
      }),
    ).toThrow(CommentBodyRequired);
  });

  test("empty body + an image anchor WITHOUT overlay items rejects", () => {
    expect(() =>
      createComment(db, dataDir, boardId, {
        anchor: imageAnchorWith(EMPTY_OVERLAY),
        body: "",
        version_n: 1,
        actor: "human",
      }),
    ).toThrow(CommentBodyRequired);
  });

  test("empty body + an overlay-less image anchor rejects too", () => {
    expect(() =>
      createComment(db, dataDir, boardId, {
        anchor: imageAnchorWith(),
        body: "",
        version_n: 1,
        actor: "human",
      }),
    ).toThrow(CommentBodyRequired);
  });

  test("a reply with an empty body rejects even on an image thread", () => {
    const root = createComment(db, dataDir, boardId, {
      anchor: imageAnchorWith({
        arrows: [{ x1: 0, y1: 0, x2: 1, y2: 1 }],
        boxes: [],
      }),
      body: "",
      version_n: 1,
      actor: "human",
    });
    expect(() =>
      replyComment(db, dataDir, root.id, { body: "", actor: "agent-1" }),
    ).toThrow(CommentBodyRequired);
  });
});

describe("reply + resolve", () => {
  const rootBody = "The intro should mention the cache.";

  test("replies inherit the parent's anchor and version", () => {
    const root = createComment(db, dataDir, boardId, {
      anchor: {
        type: "text",
        section_id: "b2",
        originalText: "alpha",
        startOffset: 0,
        endOffset: 5,
      },
      body: rootBody,
      version_n: 1,
      actor: "human",
    });
    const reply = replyComment(db, dataDir, root.id, {
      body: "Fixed in v2.",
      actor: "agent-1",
    });
    expect(reply.in_reply_to).toBe(root.id);
    expect(reply.anchor).toEqual(root.anchor);
    expect(reply.version_n).toBe(root.version_n);
    expect(reply.author).toBe("agent-1");
    expect(reply.seq).toBeGreaterThan(root.seq);
    const nested = replyComment(db, dataDir, reply.id, {
      body: "nested",
      actor: "human",
    });
    expect(nested.in_reply_to).toBe(reply.id);
  });

  test("reply to an unknown comment rejects", () => {
    expect(() =>
      replyComment(db, dataDir, "nosuchcomment", {
        body: "x",
        actor: "human",
      }),
    ).toThrow(CommentNotFound);
  });

  test("resolve is idempotent — one event, stable resolved_at", () => {
    const root = createComment(db, dataDir, boardId, {
      anchor: { type: "section", section_id: "b1" },
      body: "Resolve me",
      version_n: 1,
      actor: "human",
    });
    const resolved = resolveComment(db, dataDir, root.id, "human");
    expect(resolved.resolved_at).not.toBe(null);
    expect(resolved.resolved_by).toBe("human");
    const again = resolveComment(db, dataDir, root.id, "agent-1");
    expect(again.resolved_at).toBe(resolved.resolved_at);
    expect(again.resolved_by).toBe("human");
    const resolvedEvents = getEvents(db).filter(
      (ev) => ev.type === "comment.resolved",
    );
    expect(
      resolvedEvents.filter((ev) => ev.payload.comment_id === root.id),
    ).toHaveLength(1);
  });

  test("resolve on an unknown comment rejects", () => {
    expect(() => resolveComment(db, dataDir, "nosuchcomment", "human")).toThrow(
      CommentNotFound,
    );
  });
});

describe("queries", () => {
  test("listComments orders by seq and honors exclusive since", () => {
    const all = listComments(db, boardId);
    expect(all.map((c) => c.seq)).toEqual(
      [...all.map((c) => c.seq)].sort((a, b) => a - b),
    );
    const mid = all[Math.floor(all.length / 2)].seq;
    const tail = listComments(db, boardId, mid);
    expect(tail.every((c) => c.seq > mid)).toBe(true);
    expect(all.filter((c) => c.seq > mid).map((c) => c.id)).toEqual(
      tail.map((c) => c.id),
    );
  });

  test("countUnresolvedRoots counts unresolved roots only", () => {
    const before = countUnresolvedRoots(db, boardId);
    const root = createComment(db, dataDir, boardId, {
      anchor: { type: "board" },
      body: "count me",
      version_n: 1,
      actor: "human",
    });
    replyComment(db, dataDir, root.id, {
      body: "not a root",
      actor: "agent-1",
    });
    expect(countUnresolvedRoots(db, boardId)).toBe(before + 1);
    resolveComment(db, dataDir, root.id, "human");
    expect(countUnresolvedRoots(db, boardId)).toBe(before);
  });

  test("maxCommentSeq tracks the newest comment seq", () => {
    const before = maxCommentSeq(db, boardId);
    const comment = createComment(db, dataDir, boardId, {
      anchor: { type: "board" },
      body: "newest",
      version_n: 1,
      actor: "human",
    });
    expect(maxCommentSeq(db, boardId)).toBe(Math.max(before, comment.seq));
    expect(maxCommentSeq(db, "nosuchboard")).toBe(0);
  });

  test("getComment round-trips anchors as JSON", () => {
    const anchor = {
      type: "text" as const,
      section_id: "b2",
      originalText: "gamma",
      startOffset: 12,
      endOffset: 17,
    };
    const comment = createComment(db, dataDir, boardId, {
      anchor,
      body: "json round-trip",
      version_n: 1,
      actor: "human",
    });
    expect(getComment(db, comment.id)?.anchor).toEqual(anchor);
  });
});

// The shared cursor read behind REST GET /boards/:id/comments and MCP
// board_get_comments (the M7 audit view is the planned third consumer).
describe("listCommentsPage", () => {
  test("returns the page plus a last_seq cursor matching the newest seq", async () => {
    const board = createBoard(db, dataDir, {
      title: "Page",
      format: "markdown",
      actor: "human",
    });
    await publishVersion(db, dataDir, board.id, {
      format: "markdown",
      content: "# page",
      expected_version: 0,
      actor: "human",
    });
    const empty = listCommentsPage(db, board.id, undefined);
    expect(empty.comments).toEqual([]);
    expect(empty.last_seq).toBe(0);

    const c1 = createComment(db, dataDir, board.id, {
      anchor: { type: "board" },
      body: "one",
      version_n: 1,
      actor: "human",
    });
    const c2 = createComment(db, dataDir, board.id, {
      anchor: { type: "board" },
      body: "two",
      version_n: 1,
      actor: "human",
    });
    const page = listCommentsPage(db, board.id, undefined);
    expect(page.comments.map((c) => c.id)).toEqual([c1.id, c2.id]);
    expect(page.last_seq).toBe(c2.seq);

    // since is exclusive — the cursor page starts after it
    const tail = listCommentsPage(db, board.id, undefined, c1.seq);
    expect(tail.comments.map((c) => c.id)).toEqual([c2.id]);
  });

  test("an agent poll records cursor presence; a human poll does not", () => {
    const board = createBoard(db, dataDir, {
      title: "Presence",
      format: "markdown",
      actor: "human",
    });
    listCommentsPage(db, board.id, { kind: "human", name: "human" });
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM subscribers WHERE board_id = ?")
        .get(board.id) as { c: number },
    ).toEqual({ c: 0 });
    listCommentsPage(db, board.id, { kind: "agent", name: "agent-1" });
    const row = db
      .prepare("SELECT agent, kind FROM subscribers WHERE board_id = ?")
      .get(board.id) as { agent: string; kind: string };
    expect(row).toEqual({ agent: "agent-1", kind: "cursor" });
  });

  test("an unknown board throws BoardNotFound", () => {
    expect(() => listCommentsPage(db, "nosuchboard", undefined)).toThrow(
      BoardNotFound,
    );
  });
});

describe("boardsWithCounts", () => {
  test("attaches unresolved root-comment counts to every board", async () => {
    const board = createBoard(db, dataDir, {
      title: "Counts",
      format: "markdown",
      actor: "human",
    });
    await publishVersion(db, dataDir, board.id, {
      format: "markdown",
      content: "# counts",
      expected_version: 0,
      actor: "human",
    });
    const listed = boardsWithCounts(db);
    const counted = listed.find((b) => b.id === board.id);
    expect(counted?.unresolved_comments).toBe(0);
    const root = createComment(db, dataDir, board.id, {
      anchor: { type: "board" },
      body: "unresolved",
      version_n: 1,
      actor: "human",
    });
    createComment(db, dataDir, board.id, {
      anchor: { type: "board" },
      body: "reply, not a root",
      version_n: 1,
      in_reply_to: root.id,
      actor: "human",
    });
    expect(
      boardsWithCounts(db).find((b) => b.id === board.id)?.unresolved_comments,
    ).toBe(1);
  });
});

describe("ended boards", () => {
  test("comments, replies, and resolves all reject on an ended board", async () => {
    const board = createBoard(db, dataDir, {
      title: "Endgame",
      format: "markdown",
      actor: "agent-1",
    });
    await publishVersion(db, dataDir, board.id, {
      format: "markdown",
      content: "# endgame",
      expected_version: 0,
      actor: "agent-1",
    });
    const root = createComment(db, dataDir, board.id, {
      anchor: { type: "board" },
      body: "pre-end",
      version_n: 1,
      actor: "human",
    });
    endBoard(db, dataDir, board.id, "agent-1");
    expect(() =>
      createComment(db, dataDir, board.id, {
        anchor: { type: "board" },
        body: "post-end",
        version_n: 1,
        actor: "human",
      }),
    ).toThrow(BoardEnded);
    expect(() =>
      replyComment(db, dataDir, root.id, {
        body: "post-end",
        actor: "agent-1",
      }),
    ).toThrow(BoardEnded);
    expect(() => resolveComment(db, dataDir, root.id, "human")).toThrow(
      BoardEnded,
    );
  });
});
