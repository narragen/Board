// Bundle export: GET /api/boards/:id/export zips a self-contained bundle —
// manifest, version SOURCES, comments, asset bytes, and the board's event rows
// as an audit snapshot (docs/architecture.md "Bundle export/import"). Reading
// only; the re-ingest side is bundle-import.ts.
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { listAssets } from "./assets.ts";
import {
  getVersion,
  listVersions,
  requireBoard,
  StoreError,
} from "./boards.ts";
import {
  BUNDLE_SCHEMA_VERSION,
  type Manifest,
  type ManifestAssetEntry,
  type ManifestVersionEntry,
} from "./bundle-format.ts";
import { listComments } from "./comments.ts";
import type { BoardFormat } from "./domain.ts";
import { getBoardEventsUnbounded } from "./events.ts";

// fflate over hand-rolling zip: tiny, sync, does zip+unzip, zero config, and
// deterministic on identical input (same entries → same bytes — bundles are
// comparable in tests; the manifest's exported_at is the only per-call
// variance). Hand-rolling a zip container is format-risk not worth taking.
const ZIP_OPTIONS = { level: 6 } as const;

function versionFileName(n: number, format: BoardFormat): string {
  return `content/${n}.${format === "markdown" ? "md" : "html"}`;
}

function assetFileName(file: string): string {
  return `assets/${file}`;
}

// Build the zip for one board. Board must exist (404 at the route layer).
// Everything is buffered: board docs are ≤8MB and assets ≤8MB total, so
// in-memory assembly is fine (streaming would buy nothing at these sizes).
export function buildBundle(
  db: Database,
  dataDir: string,
  boardId: string,
): Uint8Array {
  const board = requireBoard(db, boardId);

  const entries: Record<string, Uint8Array> = {};
  const versionIndex: ManifestVersionEntry[] = [];
  for (const meta of listVersions(db, boardId)) {
    const full = getVersion(db, boardId, meta.n);
    if (full === null) {
      throw new StoreError(
        `version ${meta.n} of board "${boardId}" is indexed but missing`,
      );
    }
    // SOURCE content only (docs/plan.md "bundle export"). Format is per
    // publish: a markdown version keeps source_md (the derived HTML is
    // re-computed on import — re-sanitized, fresh anchors); an html version
    // carries the stored id-injected document, which IS its source per D18
    // (import re-derives anchors from it, keepExisting keeps the ids).
    const isMarkdown = full.source_md !== null;
    const source = isMarkdown ? full.source_md : full.content;
    if (source === null) {
      throw new StoreError(
        `version ${meta.n} of board "${boardId}" has no source to export`,
      );
    }
    const file = versionFileName(meta.n, isMarkdown ? "markdown" : "html");
    entries[file] = new TextEncoder().encode(source);
    versionIndex.push({
      n: meta.n,
      file,
      label: meta.label,
      note: meta.note,
      created_by: meta.created_by,
      created_at: meta.created_at,
    });
  }

  const assetIndex: ManifestAssetEntry[] = [];
  for (const asset of listAssets(db, boardId)) {
    const path = join(dataDir, "boards", boardId, "assets", asset.file);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      throw new StoreError(
        `asset "${asset.id}" of board "${boardId}" is missing its bundle file`,
      );
    }
    entries[assetFileName(asset.file)] = bytes;
    assetIndex.push({
      id: asset.id,
      file: assetFileName(asset.file),
      mime: asset.mime,
      size: asset.size,
      source: asset.source,
      created_by: asset.created_by,
      created_at: asset.created_at,
    });
  }

  // Comments replay as data: strip board_id and seq (db-isms of the source
  // board — the new board mints fresh ids and fresh event seqs).
  const comments = listComments(db, boardId).map((c) => ({
    id: c.id,
    version_n: c.version_n,
    anchor: c.anchor,
    body: c.body,
    author: c.author,
    in_reply_to: c.in_reply_to,
    created_at: c.created_at,
    edited_at: c.edited_at,
    resolved_at: c.resolved_at,
    resolved_by: c.resolved_by,
  }));

  // Audit snapshot: this board's event rows verbatim. Import never replays
  // them into the live log — invariant 4 (events are append-only) keeps the
  // global seq monotonic — so the snapshot exists only to preserve the
  // bundle's own history.
  const events = getBoardEventsUnbounded(db, boardId);

  const manifest: Manifest = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    source_board_id: board.id,
    exported_at: new Date().toISOString(),
    board: {
      title: board.title,
      format: board.format,
      status: board.status,
      tags: board.tags,
      created_by: board.created_by,
      created_at: board.created_at,
    },
    versions: versionIndex,
    comments: { count: comments.length },
    assets: assetIndex,
  };

  return zipSync(
    {
      "manifest.json": new TextEncoder().encode(
        JSON.stringify(manifest, null, 2),
      ),
      "comments.json": new TextEncoder().encode(
        JSON.stringify({ comments }, null, 2),
      ),
      "events.jsonl": new TextEncoder().encode(
        events.map((ev) => JSON.stringify(ev)).join("\n"),
      ),
      ...entries,
    },
    ZIP_OPTIONS,
  );
}
