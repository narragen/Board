import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoardEnded,
  BoardNotFound,
  ContentTooLarge,
  createBoard,
  endBoard,
  filterBoards,
  getBoard,
  getVersion,
  listBoards,
  listVersions,
  publishVersion,
  restoreVersion,
  StoreError,
  VersionConflict,
  VersionNotFound,
} from "./boards.ts";
import { openDb } from "./db.ts";
import type { Board, Version } from "./domain.ts";
import { getEvents } from "./events.ts";
import { MAX_BODY_BYTES } from "./http.ts";

const MD_V1 = [
  "# V1 Title",
  "",
  "First body with $a+b$ math.",
  "",
  "| H1 | H2 |",
  "| --- | --- |",
  "| r1c1 | r1c2 |",
].join("\n");

const MD_V2 = ["# V2 Title", "", "Second body."].join("\n");

const HTML_DOC = [
  "<!doctype html><html><body>",
  '<div data-ba="s1" data-ba-label="Panel"><p>widget</p></div>',
  "</body></html>",
].join("");

// Regression for the write-order invariant (mirrorEventFiles in events.ts —
// the db row commits first, the jsonl mirrors are written after). The seam: replace the global
// events.jsonl FILE with a DIRECTORY, so the mirror's appendFileSync throws
// EISDIR — a crash-shaped failure of the mirror step alone. The event row and
// the version must still be committed (mirrors may lag the db, never lead
// it); the pre-consolidation code mirrored INSIDE the transaction, so this
// failure rolled the whole write back and the assertions below failed.
describe("event mirror discipline (db first, mirrors after commit)", () => {
  test("a failing jsonl mirror does not roll back the committed publish", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "board-store-mirror-test-"));
    const db = openDb(dataDir);
    try {
      const board = createBoard(db, dataDir, {
        title: "Mirror",
        format: "markdown",
        actor: "human",
      });
      rmSync(join(dataDir, "events.jsonl"));
      mkdirSync(join(dataDir, "events.jsonl"));
      await expect(
        publishVersion(db, dataDir, board.id, {
          format: "markdown",
          content: MD_V1,
          expected_version: 0,
          actor: "agent-1",
        }),
      ).rejects.toThrow();
      expect(getEvents(db).some((ev) => ev.type === "board.published")).toBe(
        true,
      );
      expect(getVersion(db, board.id, 1)).not.toBeNull();
      expect(getBoard(db, board.id)?.current_version).toBe(1);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a failing jsonl mirror does not roll back the committed end", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "board-store-mirror-end-"));
    const db = openDb(dataDir);
    try {
      const board = createBoard(db, dataDir, {
        title: "Mirror end",
        format: "markdown",
        actor: "human",
      });
      rmSync(join(dataDir, "events.jsonl"));
      mkdirSync(join(dataDir, "events.jsonl"));
      expect(() => endBoard(db, dataDir, board.id, "human")).toThrow();
      expect(getBoard(db, board.id)?.status).toBe("ended");
      expect(getEvents(db).some((ev) => ev.type === "board.ended")).toBe(true);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("board lifecycle run", () => {
  let db: Database;
  let dataDir: string;
  let board: Board;
  let v1: Version;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "board-store-test-"));
    db = openDb(dataDir);
  });

  afterAll(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const boardDir = (): string => join(dataDir, "boards", board.id);
  const versionsDir = (): string => join(boardDir(), "versions");

  test("createBoard creates versions/ + assets/ and a board.json snapshot", () => {
    board = createBoard(db, dataDir, {
      title: "Lifecycle",
      format: "markdown",
      tags: ["run", "w2a"],
      actor: "human",
    });
    expect(board.id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(board.status).toBe("open");
    expect(board.current_version).toBe(0);
    expect(existsSync(join(versionsDir()))).toBe(true);
    expect(existsSync(join(boardDir(), "assets"))).toBe(true);
    const snapshot = JSON.parse(
      readFileSync(join(boardDir(), "board.json"), "utf8"),
    ) as Board;
    expect(snapshot).toEqual(board);
  });

  test("publishVersion v1 (markdown) writes versions/1.html + 1.md, stores source, anchors, and bumps current_version", async () => {
    v1 = await publishVersion(db, dataDir, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
      label: "first",
      actor: "agent-1",
    });
    expect(v1.n).toBe(1);
    expect(v1.board_id).toBe(board.id);
    expect(v1.label).toBe("first");
    expect(v1.source_md).toBe(MD_V1);
    expect(v1.content.startsWith("<!doctype html><html>")).toBe(true);
    expect(v1.content).toContain('class="katex"');
    expect(v1.anchors).toEqual([
      { id: "b1", kind: "heading", label: "V1 Title" },
      { id: "b2", kind: "block" },
      { id: "b3", kind: "block" },
      { id: "b3r1", kind: "row" },
      { id: "b3r2", kind: "row" },
    ]);
    expect(readFileSync(join(versionsDir(), "1.html"), "utf8")).toBe(
      v1.content,
    );
    expect(readFileSync(join(versionsDir(), "1.md"), "utf8")).toBe(MD_V1);
    expect(getBoard(db, board.id)?.current_version).toBe(1);
    const snapshot = JSON.parse(
      readFileSync(join(boardDir(), "board.json"), "utf8"),
    ) as Board;
    expect(snapshot.current_version).toBe(1);
  });

  test("publishVersion v2 leaves v1 bundle files byte-identical", async () => {
    const htmlBefore = readFileSync(join(versionsDir(), "1.html"));
    const mdBefore = readFileSync(join(versionsDir(), "1.md"));
    const v2 = await publishVersion(db, dataDir, board.id, {
      format: "markdown",
      content: MD_V2,
      expected_version: 1,
      actor: "agent-2",
    });
    expect(v2.n).toBe(2);
    expect(getBoard(db, board.id)?.current_version).toBe(2);
    expect(readFileSync(join(versionsDir(), "1.html")).equals(htmlBefore)).toBe(
      true,
    );
    expect(readFileSync(join(versionsDir(), "1.md")).equals(mdBefore)).toBe(
      true,
    );
    expect(existsSync(join(versionsDir(), "2.html"))).toBe(true);
    expect(existsSync(join(versionsDir(), "2.md"))).toBe(true);
  });

  test("publishVersion with a stale expected_version throws VersionConflict", async () => {
    expect(
      publishVersion(db, dataDir, board.id, {
        format: "markdown",
        content: MD_V2,
        expected_version: 1,
        actor: "agent-1",
      }),
    ).rejects.toBeInstanceOf(VersionConflict);
    try {
      await publishVersion(db, dataDir, board.id, {
        format: "markdown",
        content: MD_V2,
        expected_version: 1,
        actor: "agent-1",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect(err).toBeInstanceOf(VersionConflict);
      expect((err as VersionConflict).message).toContain("expected 1");
    }
  });

  test("publishVersion over 8 MB throws ContentTooLarge", async () => {
    expect(
      publishVersion(db, dataDir, board.id, {
        format: "markdown",
        content: "x".repeat(MAX_BODY_BYTES + 1),
        expected_version: 2,
        actor: "agent-1",
      }),
    ).rejects.toBeInstanceOf(ContentTooLarge);
    expect(existsSync(join(versionsDir(), "3.html"))).toBe(false);
  });

  test("publishVersion on an unknown board throws BoardNotFound", async () => {
    expect(
      publishVersion(db, dataDir, "nosuchboard", {
        format: "markdown",
        content: MD_V1,
        expected_version: 0,
        actor: "agent-1",
      }),
    ).rejects.toBeInstanceOf(BoardNotFound);
  });

  test("restoreVersion republishes v1 as v3 with a restore label", () => {
    const v3 = restoreVersion(db, dataDir, board.id, {
      from_n: 1,
      expected_version: 2,
      actor: "human",
    });
    expect(v3.n).toBe(3);
    expect(v3.label).toBe("restore of v1");
    expect(v3.content).toBe(v1.content);
    expect(v3.source_md).toBe(v1.source_md);
    expect(v3.anchors).toEqual(v1.anchors);
    expect(getBoard(db, board.id)?.current_version).toBe(3);
    expect(readFileSync(join(versionsDir(), "3.html"), "utf8")).toBe(
      v1.content,
    );
    expect(readFileSync(join(versionsDir(), "3.md"), "utf8")).toBe(MD_V1);
  });

  test("restoreVersion with an unknown from_n throws VersionNotFound", () => {
    expect(() =>
      restoreVersion(db, dataDir, board.id, {
        from_n: 99,
        expected_version: 3,
        actor: "human",
      }),
    ).toThrow(VersionNotFound);
  });

  test("restoreVersion with a stale expected_version throws VersionConflict", () => {
    expect(() =>
      restoreVersion(db, dataDir, board.id, {
        from_n: 1,
        expected_version: 2,
        actor: "human",
      }),
    ).toThrow(VersionConflict);
  });

  test("endBoard marks the board ended and refreshes board.json", () => {
    const ended = endBoard(db, dataDir, board.id, "human");
    expect(ended.status).toBe("ended");
    expect(getBoard(db, board.id)?.status).toBe("ended");
    const snapshot = JSON.parse(
      readFileSync(join(boardDir(), "board.json"), "utf8"),
    ) as Board;
    expect(snapshot.status).toBe("ended");
  });

  test("publishVersion to an ended board throws BoardEnded even with a stale expected_version", async () => {
    expect(
      publishVersion(db, dataDir, board.id, {
        format: "markdown",
        content: MD_V2,
        expected_version: 0,
        actor: "agent-1",
      }),
    ).rejects.toBeInstanceOf(BoardEnded);
  });

  test("restoreVersion on an ended board throws BoardEnded even with a stale expected_version", () => {
    expect(() =>
      restoreVersion(db, dataDir, board.id, {
        from_n: 1,
        expected_version: 0,
        actor: "human",
      }),
    ).toThrow(BoardEnded);
  });

  test("endBoard on an already-ended board throws BoardEnded without a second event", () => {
    expect(() => endBoard(db, dataDir, board.id, "human")).toThrow(BoardEnded);
    expect(
      getEvents(db).filter((ev) => ev.type === "board.ended"),
    ).toHaveLength(1);
  });

  test("the run's event sequence is exactly [created, published, published, restored, ended]", () => {
    expect(getEvents(db).map((ev) => ev.type)).toEqual([
      "board.created",
      "board.published",
      "board.published",
      "board.restored",
      "board.ended",
    ]);
  });

  test("global events.jsonl line count matches the db rows", () => {
    const rows = getEvents(db);
    const lines = readLines(join(dataDir, "events.jsonl"));
    expect(lines).toHaveLength(rows.length);
    for (const [i, line] of lines.entries()) {
      expect(JSON.parse(line)).toEqual(rows[i]);
    }
  });

  test("per-board events.jsonl mirrors this board's events", () => {
    const rows = getEvents(db, { boardId: board.id });
    const lines = readLines(join(boardDir(), "events.jsonl"));
    expect(lines).toHaveLength(rows.length);
    for (const [i, line] of lines.entries()) {
      expect(JSON.parse(line)).toEqual(rows[i]);
    }
  });
});

describe("board and version queries", () => {
  let db: Database;
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "board-store-query-test-"));
    db = openDb(dataDir);
  });

  afterAll(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("getBoard returns null for an unknown id", () => {
    expect(getBoard(db, "missing")).toBeNull();
  });

  test("getVersion returns null for an unknown board or n", async () => {
    const board = createBoard(db, dataDir, {
      title: "Q",
      format: "html",
      actor: "human",
    });
    expect(getVersion(db, board.id, 1)).toBeNull();
    expect(getVersion(db, "missing", 1)).toBeNull();
    await publishVersion(db, dataDir, board.id, {
      format: "html",
      content: HTML_DOC,
      expected_version: 0,
      actor: "human",
    });
    expect(getVersion(db, board.id, 2)).toBeNull();
  });

  test("listBoards orders by created_at desc and parses tags", () => {
    db.prepare(
      "INSERT INTO boards (id, title, format, status, tags, created_by, created_at, current_version) VALUES (?, ?, 'markdown', 'open', ?, ?, ?, 0)",
    ).run("aaolder", "Older", '["t1"]', "a", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO boards (id, title, format, status, tags, created_by, created_at, current_version) VALUES (?, ?, 'html', 'ended', ?, ?, ?, 0)",
    ).run("zznewer", "Newer", "[]", "b", "2026-02-01T00:00:00.000Z");
    const boards = listBoards(db);
    expect(boards.map((b) => b.id)).toContain("zznewer");
    expect(boards.map((b) => b.id)).toContain("aaolder");
    const ids = boards.map((b) => b.id);
    expect(ids.indexOf("zznewer")).toBeLessThan(ids.indexOf("aaolder"));
    const older = boards.find((b) => b.id === "aaolder");
    expect(older?.tags).toEqual(["t1"]);
    expect(older?.status).toBe("open");
    const newer = boards.find((b) => b.id === "zznewer");
    expect(newer?.status).toBe("ended");
    expect(newer?.tags).toEqual([]);
  });

  test("html format stores the id-injected document with extracted anchors (D18)", async () => {
    const board = createBoard(db, dataDir, {
      title: "HTML board",
      format: "html",
      actor: "human",
    });
    const version = await publishVersion(db, dataDir, board.id, {
      format: "html",
      content: HTML_DOC,
      expected_version: 0,
      actor: "human",
    });
    // D18: the derived-document model applies to html too — the stored
    // content is the publish-time injected document, not the raw input
    expect(version.content).not.toBe(HTML_DOC);
    expect(version.content).toContain('data-ba="s1" data-ba-label="Panel"');
    expect(version.source_md).toBeNull();
    expect(version.anchors).toEqual([
      { id: "s1", kind: "block", label: "Panel" },
    ]);
    expect(
      readFileSync(
        join(dataDir, "boards", board.id, "versions", "1.html"),
        "utf8",
      ),
    ).toBe(version.content);
    expect(
      existsSync(join(dataDir, "boards", board.id, "versions", "1.md")),
    ).toBe(false);
  });

  test("html publish auto-injects ids on unlabeled top-level blocks and table rows", async () => {
    const board = createBoard(db, dataDir, {
      title: "HTML inject",
      format: "html",
      actor: "human",
    });
    const version = await publishVersion(db, dataDir, board.id, {
      format: "html",
      content: [
        "<!doctype html><html><body>",
        "<p>intro</p>",
        '<section data-ba="s-chart" data-ba-label="Chart">chart</section>',
        "<table><tr><td>a</td></tr></table>",
        "</body></html>",
      ].join(""),
      expected_version: 0,
      actor: "human",
    });
    expect(version.content).toContain('<p data-ba="b1">intro</p>');
    expect(version.content).toContain('data-ba="s-chart"');
    expect(version.content).toContain('<table data-ba="b3">');
    expect(version.content).toContain('<tr data-ba="b3r1">');
    expect(version.anchors).toEqual([
      { id: "b1", kind: "block" },
      { id: "s-chart", kind: "block", label: "Chart" },
      { id: "b3", kind: "block" },
      { id: "b3r1", kind: "row" },
    ]);
  });

  test("listVersions returns metadata only, ordered by n, anchors included", async () => {
    const board = createBoard(db, dataDir, {
      title: "Meta",
      format: "markdown",
      actor: "human",
    });
    await publishVersion(db, dataDir, board.id, {
      format: "markdown",
      content: MD_V1,
      expected_version: 0,
      label: "one",
      actor: "human",
    });
    await publishVersion(db, dataDir, board.id, {
      format: "markdown",
      content: MD_V2,
      expected_version: 1,
      note: "second try",
      actor: "human",
    });
    const metas = listVersions(db, board.id);
    expect(metas).toHaveLength(2);
    expect(metas.map((m) => m.n)).toEqual([1, 2]);
    expect("content" in metas[0]).toBe(false);
    expect("source_md" in metas[0]).toBe(false);
    expect(metas[0].label).toBe("one");
    expect(metas[0].anchors.length).toBeGreaterThan(0);
    expect(metas[1].note).toBe("second try");
    expect(metas[1].anchors[0].kind).toBe("heading");
    expect(listVersions(db, "missing")).toEqual([]);
  });

  test("endBoard on an unknown board throws BoardNotFound", () => {
    expect(() => endBoard(db, dataDir, "missing", "human")).toThrow(
      BoardNotFound,
    );
  });

  test("restoreVersion on an unknown board throws BoardNotFound", () => {
    expect(() =>
      restoreVersion(db, dataDir, "missing", {
        from_n: 1,
        expected_version: 0,
        actor: "human",
      }),
    ).toThrow(BoardNotFound);
  });
});

function filterFixture(over: Partial<Board>): Board {
  return {
    id: "x",
    title: "t",
    format: "markdown",
    status: "open",
    tags: [],
    created_by: "agent",
    created_at: "2026-01-01T00:00:00.000Z",
    current_version: 0,
    ...over,
  };
}

describe("filterBoards", () => {
  test("no filters returns every board", () => {
    const boards = [filterFixture({ id: "a" }), filterFixture({ id: "b" })];
    expect(filterBoards(boards, {})).toEqual(boards);
  });

  test("status filter matches only that status", () => {
    const open = filterFixture({ id: "a", status: "open" });
    const ended = filterFixture({ id: "b", status: "ended" });
    expect(filterBoards([open, ended], { status: "open" })).toEqual([open]);
    expect(filterBoards([open, ended], { status: "ended" })).toEqual([ended]);
  });

  test("tag filter matches a tag at any position", () => {
    const tagged = filterFixture({ id: "a", tags: ["alpha", "shared"] });
    const other = filterFixture({ id: "b", tags: ["beta"] });
    expect(filterBoards([tagged, other], { tag: "shared" })).toEqual([tagged]);
    expect(filterBoards([tagged, other], { tag: "nope" })).toEqual([]);
  });

  test("author filter matches created_by", () => {
    const mine = filterFixture({ id: "a", created_by: "agent-one" });
    const theirs = filterFixture({ id: "b", created_by: "agent-two" });
    expect(filterBoards([mine, theirs], { author: "agent-one" })).toEqual([
      mine,
    ]);
  });

  test("filters combine with AND semantics", () => {
    const a = filterFixture({
      id: "a",
      status: "open",
      tags: ["x"],
      created_by: "one",
    });
    const b = filterFixture({
      id: "b",
      status: "ended",
      tags: ["x"],
      created_by: "one",
    });
    expect(
      filterBoards([a, b], { status: "open", tag: "x", author: "one" }),
    ).toEqual([a]);
  });
});
