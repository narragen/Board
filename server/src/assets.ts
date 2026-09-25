// Assets (M6, docs/plan.md "Image annotation"): file-copy or binary ingest of
// images into a board bundle, plus the index lookup that cross-board serving
// resolves. The verification pipeline here is what keeps the {path} route
// from becoming a file-read primitive — invariant 6 (verified asset ingest),
// docs/security.md "Assets":
// mime allowlist + magic bytes + size caps before a single byte is stored, and
// rejections never echo file contents.
import type { Database } from "bun:sqlite";
import {
  mkdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { requireOpenBoard, StoreError } from "./boards.ts";
import type { Asset, AssetSource } from "./domain.ts";
import { errText } from "./err-text.ts";
import { appendEventDb, mirrorEventFiles } from "./events.ts";
import { readCappedBody } from "./http.ts";
import { newId } from "./ids.ts";
import { sanitizeSvgDocument } from "./render.ts";

// Caps (docs/plan.md REST API): 10 MB per asset, 8 MB total per board. The
// plan's own numbers make the per-board total the effective binding cap — a
// 10 MB asset can never fit an 8 MB board — and enforcement returns 413 with
// distinct codes: asset_too_large (per-asset) vs board_asset_quota_exceeded
// (per-board total), so agents can tell the two apart.
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_BOARD_ASSET_BYTES = 8 * 1024 * 1024;

export const ASSET_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

// Extensions map to a declared mime for {path} copies (binary uploads declare
// via Content-Type) and back to a canonical file-name extension at storage.
const MIME_BY_EXTENSION: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

export class AssetTooLarge extends StoreError {
  constructor(size: number) {
    super(
      `asset is ${size} bytes, exceeding the ${MAX_ASSET_BYTES} byte per-asset cap`,
    );
    this.name = "AssetTooLarge";
  }
}

export class BoardAssetQuotaExceeded extends StoreError {
  constructor(boardId: string, total: number) {
    super(
      `assets on board "${boardId}" would exceed the ${MAX_BOARD_ASSET_BYTES} byte per-board cap (currently ${total})`,
    );
    this.name = "BoardAssetQuotaExceeded";
  }
}

export class AssetTypeNotAllowed extends StoreError {
  constructor(reason: string) {
    super(
      `asset type not allowed: ${reason} (allowed: ${[...ASSET_MIME_ALLOWLIST].join(", ")})`,
    );
    this.name = "AssetTypeNotAllowed";
  }
}

export class AssetNotAnImage extends StoreError {
  constructor(reason: string) {
    super(`not an allowed image: ${reason}`);
    this.name = "AssetNotAnImage";
  }
}

export class AssetUnreadable extends StoreError {
  constructor(reason: string) {
    super(`asset path unreadable: ${reason}`);
    this.name = "AssetUnreadable";
  }
}

interface AssetRow {
  id: string;
  board_id: string;
  file: string;
  mime: string;
  size: number;
  source: string;
  created_by: string;
  created_at: string;
}

function mapAssetRow(row: AssetRow): Asset {
  return {
    id: row.id,
    board_id: row.board_id,
    file: row.file,
    mime: row.mime,
    size: row.size,
    source: row.source as AssetSource,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function asciiBytes(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

// Magic bytes — invariant 6 (verified asset ingest): png, jpeg, gif (both
// variants), and webp — the
// RIFF container plus the WEBP subtag as ONE signature, since a bare RIFF
// match would also accept WAV/AVI files. SVG has no magic bytes: an .svg
// name + image/svg+xml declaration + parse-and-sanitize is its verification.
const MAGIC_SIGNATURES: ReadonlyArray<{
  mime: string;
  parts: ReadonlyArray<{ offset: number; bytes: number[] }>;
}> = [
  {
    mime: "image/png",
    parts: [
      { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    ],
  },
  { mime: "image/jpeg", parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  { mime: "image/gif", parts: [{ offset: 0, bytes: asciiBytes("GIF87a") }] },
  { mime: "image/gif", parts: [{ offset: 0, bytes: asciiBytes("GIF89a") }] },
  {
    mime: "image/webp",
    parts: [
      { offset: 0, bytes: asciiBytes("RIFF") },
      { offset: 8, bytes: asciiBytes("WEBP") },
    ],
  },
];

export function sniffImageMime(bytes: Uint8Array): string | null {
  for (const signature of MAGIC_SIGNATURES) {
    const matched = signature.parts.every(({ offset, bytes: magic }) => {
      if (bytes.length < offset + magic.length) {
        return false;
      }
      return magic.every((b, i) => bytes[offset + i] === b);
    });
    if (matched) {
      return signature.mime;
    }
  }
  return null;
}

function boardAssetBytes(db: Database, boardId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(size), 0) AS total FROM assets WHERE board_id = ?",
    )
    .get(boardId) as { total: number };
  return row.total;
}

interface IngestAssetInput {
  bytes: Uint8Array;
  // Declared mime: Content-Type for binary uploads, extension-derived for
  // {path} copies. Sniffed magic bytes must agree with it.
  mime: string;
  source: AssetSource;
  actor: string;
}

export interface VerifiedAsset {
  mime: string;
  bytes: Uint8Array;
}

// The ingest pipeline's verification core (mime allowlist → magic bytes /
// svg parse-and-sanitize), shared by ingestAsset and bundle import — import
// must re-run THIS function, never a forked copy of the checks, or the
// quarantine re-examination (docs/security.md "Import quarantine") drifts
// from what ingest actually enforces. Size caps stay with the callers
// (ingestAsset / the import validator) so each names its own context.
// Throws AssetTypeNotAllowed / AssetNotAnImage on rejection.
export function verifyAssetBytes(
  bytes: Uint8Array,
  declaredMime: string,
): VerifiedAsset {
  // content-type parameters (charset etc.) never participate in the check
  const mime = declaredMime.split(";")[0].trim().toLowerCase();
  if (!ASSET_MIME_ALLOWLIST.has(mime)) {
    throw new AssetTypeNotAllowed(`"${mime}" is not on the image allowlist`);
  }

  const sniffed = sniffImageMime(bytes);
  if (mime === "image/svg+xml") {
    // real image bytes posing as svg are a lie about the type, not an svg
    if (sniffed !== null) {
      throw new AssetNotAnImage(
        `declared ${mime} but the bytes match ${sniffed} magic`,
      );
    }
    // SVG's verification is parse-and-sanitize: the sanitized bytes — never
    // the original — are what gets stored (docs/security.md "Assets")
    const sanitized = sanitizeSvgDocument(new TextDecoder().decode(bytes));
    if (sanitized === null) {
      throw new AssetNotAnImage("no svg document survived sanitization");
    }
    return { mime, bytes: new TextEncoder().encode(sanitized) };
  }
  if (sniffed === null) {
    throw new AssetNotAnImage(
      "magic bytes do not match any allowlisted image type",
    );
  }
  if (sniffed !== mime) {
    throw new AssetNotAnImage(
      `declared ${mime} but the bytes match ${sniffed} magic`,
    );
  }
  return { mime: sniffed, bytes };
}

export function ingestAsset(
  db: Database,
  dataDir: string,
  boardId: string,
  input: IngestAssetInput,
): Asset {
  requireOpenBoard(db, boardId);
  if (input.bytes.byteLength > MAX_ASSET_BYTES) {
    throw new AssetTooLarge(input.bytes.byteLength);
  }
  const verified = verifyAssetBytes(input.bytes, input.mime);
  const storedMime = verified.mime;
  const storedBytes = verified.bytes;

  const total = boardAssetBytes(db, boardId);
  if (total + storedBytes.byteLength > MAX_BOARD_ASSET_BYTES) {
    throw new BoardAssetQuotaExceeded(boardId, total);
  }

  const id = newId(
    db,
    (candidate) =>
      db.prepare("SELECT 1 FROM assets WHERE id = ?").get(candidate) !== null,
  );
  const file = `${id}.${EXTENSION_BY_MIME[storedMime]}`;
  const dir = join(dataDir, "boards", boardId, "assets");
  mkdirSync(dir, { recursive: true });
  // Files before the db transaction (same rationale as publishVersion): an
  // orphan file after a crash is harmless — no row points at it.
  writeFileSync(join(dir, file), storedBytes);
  const createdAt = new Date().toISOString();
  const write = db.transaction(() => {
    const ev = appendEventDb(db, {
      actor: input.actor,
      type: "asset.added",
      boardId,
      payload: {
        asset_id: id,
        mime: storedMime,
        size: storedBytes.byteLength,
        source: input.source,
      },
    });
    db.prepare(
      "INSERT INTO assets (id, board_id, file, mime, size, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      boardId,
      file,
      storedMime,
      storedBytes.byteLength,
      input.source,
      input.actor,
      createdAt,
    );
    return ev;
  });
  const ev = write();
  mirrorEventFiles(dataDir, ev);
  return {
    id,
    board_id: boardId,
    file,
    mime: storedMime,
    size: storedBytes.byteLength,
    source: input.source,
    created_by: input.actor,
    created_at: createdAt,
  };
}

export interface IngestAssetFromPathInput {
  path: string;
  actor: string;
}

// The {path} file-copy variant — the agent path and the MCP tool's path.
// Derives the declared mime from the file extension, then funnels through the
// same verification pipeline as binary uploads.
export function ingestAssetFromPath(
  db: Database,
  dataDir: string,
  boardId: string,
  input: IngestAssetFromPathInput,
): Asset {
  requireOpenBoard(db, boardId);
  if (!isAbsolute(input.path)) {
    // a relative path would resolve against the daemon's cwd — unpredictable
    throw new AssetUnreadable("path must be absolute");
  }
  const dot = input.path.lastIndexOf(".");
  const ext = dot === -1 ? "" : input.path.slice(dot + 1).toLowerCase();
  const mime = MIME_BY_EXTENSION[ext];
  if (mime === undefined) {
    throw new AssetTypeNotAllowed(
      `"${ext || "none"}" is not an allowlisted image extension`,
    );
  }
  let stat: Stats;
  try {
    stat = statSync(input.path);
  } catch (err) {
    throw new AssetUnreadable(errText(err));
  }
  if (!stat.isFile()) {
    throw new AssetUnreadable("not a regular file");
  }
  const size = stat.size;
  // stat before read caps the read: an over-cap file is never pulled into
  // memory (the re-check after the read catches files changed in between)
  if (size > MAX_ASSET_BYTES) {
    throw new AssetTooLarge(size);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(input.path));
  } catch (err) {
    throw new AssetUnreadable(errText(err));
  }
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new AssetTooLarge(bytes.byteLength);
  }
  return ingestAsset(db, dataDir, boardId, {
    bytes,
    mime,
    source: "copy",
    actor: input.actor,
  });
}

export function getAsset(db: Database, id: string): Asset | null {
  const row = db
    .prepare("SELECT * FROM assets WHERE id = ?")
    .get(id) as AssetRow | null;
  return row === null ? null : mapAssetRow(row);
}

// Export (bundle-export.ts) reads every asset of a board — index order is the
// bundle's asset order, so keep it stable.
export function listAssets(db: Database, boardId: string): Asset[] {
  const rows = db
    .prepare("SELECT * FROM assets WHERE board_id = ? ORDER BY created_at, id")
    .all(boardId) as AssetRow[];
  return rows.map(mapAssetRow);
}

// Binary uploads (img-style) arrive as the raw request body — raw bytes cannot
// also carry a JSON envelope, which is why board scoping rides ?board_id=.
// Over-cap bodies are rejected from the honest content-length header before
// buffering, and during the stream when the header lies (readCappedBody).
export async function readBinaryAssetBody(req: Request): Promise<Uint8Array> {
  return readCappedBody(
    req,
    MAX_ASSET_BYTES,
    (size) => new AssetTooLarge(size),
  );
}
