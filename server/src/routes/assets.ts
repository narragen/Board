import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  getAsset,
  ingestAsset,
  ingestAssetFromPath,
  readBinaryAssetBody,
} from "../assets.ts";
import { HttpError, jsonError, jsonOk, readJsonBody } from "../http.ts";
import { isFile } from "../static.ts";
import { asString } from "../validate.ts";
import {
  actorName,
  bodyFields,
  type RequestContext,
  type Route,
} from "./route.ts";

// Variant discrimination (docs/security.md "Assets"): the binary variant is
// raw image bytes — an img-style upload cannot also carry a JSON envelope —
// so Content-Type: application/json selects the {board_id, path} file-copy
// body and every other content-type is the binary upload, board-scoped via
// ?board_id=. One-dimensional rule, keyed on the same content-type signal the
// daemon's JSON-only-writes middleware already uses.
async function createAssetHandler(
  req: Request,
  ctx: RequestContext,
): Promise<Response> {
  const actor = actorName(ctx);
  const contentType = req.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType === "application/json") {
    // ctx.body is unset on this raw-body route — read the JSON envelope here
    const fields = bodyFields(await readJsonBody(req));
    const asset = ingestAssetFromPath(
      ctx.db,
      ctx.dataDir,
      asString(fields.board_id, "board_id"),
      { path: asString(fields.path, "path"), actor },
    );
    return jsonOk(asset, 201);
  }
  const boardId = new URL(req.url).searchParams.get("board_id");
  if (boardId === null) {
    throw new HttpError(
      400,
      "invalid_request",
      "board_id query param is required for binary asset uploads",
    );
  }
  if (contentType === undefined || contentType.length === 0) {
    throw new HttpError(
      400,
      "invalid_request",
      "binary asset uploads require a Content-Type header",
    );
  }
  const bytes = await readBinaryAssetBody(req);
  const asset = ingestAsset(ctx.db, ctx.dataDir, boardId, {
    bytes,
    mime: contentType,
    source: "binary",
    actor,
  });
  return jsonOk(asset, 201);
}

export const assetRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/assets",
    // reads its own body: the binary variant is not JSON — the daemon skips
    // its JSON-only content-type enforcement for this route
    rawBody: true,
    handler: createAssetHandler,
  },
];

// GET /assets/:id is deliberately NOT under /api and NOT bearer-authed
// (docs/security.md "Assets"): published markdown embeds
// <img src="/assets/<id>"> and img elements cannot send Authorization headers.
// The guards instead: the host middleware (loopback bind + Host allowlist),
// nosniff, and a content-type pinned from the stored allowlisted mime — never
// from the request. Assets are content-addressed by unique id and never
// overwritten, so they cache immutably.

// The 10-char id shape disambiguates board assets from the SPA's hashed
// bundle files, which vite also serves under /assets/* — those keep falling
// through to web/dist static serving in the daemon's dispatch.
const ASSET_PATH = /^\/assets\/([0-9A-Za-z]{10})$/;

export function isBoardAssetPath(pathname: string): boolean {
  return ASSET_PATH.test(pathname);
}

const ASSET_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export function serveAsset(
  req: Request,
  db: Database,
  dataDir: string,
  headers: Record<string, string>,
): Response {
  if (req.method !== "GET") {
    return jsonError(
      405,
      "method_not_allowed",
      `${req.method} is not allowed for assets`,
      { ...headers, allow: "GET" },
    );
  }
  const match = ASSET_PATH.exec(new URL(req.url).pathname);
  if (match === null) {
    return jsonError(404, "not_found", "not found", headers);
  }
  const asset = getAsset(db, match[1]);
  if (asset === null) {
    return jsonError(
      404,
      "asset_not_found",
      `asset "${match[1]}" not found`,
      headers,
    );
  }
  // ingest generates file names (shortId.ext); the shape check is defense in
  // depth against a drifted db row ever escaping the board's assets dir
  if (!/^[0-9A-Za-z]+\.[a-z0-9]+$/.test(asset.file)) {
    throw new Error(
      `stored asset file name has an unexpected shape: ${asset.file}`,
    );
  }
  const path = join(dataDir, "boards", asset.board_id, "assets", asset.file);
  if (!isFile(path)) {
    // db row without its bundle file — divergence is a server bug, not a
    // client error; still never serve anything but the indexed file
    console.error(`boardd: asset row "${asset.id}" is missing its file`);
    return jsonError(
      404,
      "asset_not_found",
      `asset "${asset.id}" not found`,
      headers,
    );
  }
  return new Response(Bun.file(path), {
    headers: {
      ...headers,
      "content-type": asset.mime,
      "cache-control": ASSET_IMMUTABLE_CACHE,
    },
  });
}
