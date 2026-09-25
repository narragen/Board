// Static serving for the host server: the built SPA out of web/dist and the
// vendored pinned libs out of server/libs. Path resolution is the security
// surface here — staticRelativePath is what keeps a request from escaping the
// directory it is served from, and every serve path goes through it.
//
// The caller resolves WHERE (daemon.ts owns resolveWebDist / the libs dir);
// this file only decides what to send back from a given directory.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeSegment, jsonError } from "./http.ts";

// Small explicit map (not Bun.file's sniffing) so header values are pinned by
// tests and never pick up charset quirks per environment.
const MIME_BY_EXTENSION: Record<string, string> = {
  css: "text/css; charset=utf-8",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  // Unknown extensions stay octet-stream: never guess an active type.
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

// URL pathname → relative path inside web/dist. Segments are decoded first
// (assets can carry %20 etc.), then anything that could escape the dist dir —
// dot segments, embedded separators, NUL — rejects outright.
export function staticRelativePath(pathname: string): string | null {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw.length === 0) {
      continue;
    }
    const segment = decodeSegment(raw);
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function staticFileResponse(
  path: string,
  headers: Record<string, string>,
): Response {
  return new Response(Bun.file(path), {
    headers: { ...headers, "content-type": contentTypeFor(path) },
  });
}

function hasExtension(rel: string): boolean {
  return rel.slice(rel.lastIndexOf("/") + 1).includes(".");
}

// SPA cache policy: vite emits content-hashed files under assets/ — those are
// immutable forever. Everything else (index.html, the SPA shell fallback,
// fonts) revalidates on every load so a rebuild can never leave a tab running
// a stale bundle (dogfooded the hard way: Enter-to-submit "missing" was an old
// cached bundle; the new one was on disk all along).
function cacheControlFor(rel: string): string {
  return rel.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

// Static serving for the host server: real files, the SPA shell for
// extensionless unknown paths (hash routing means routes never hit the
// server), and a pointed 404 when the SPA simply isn't built.
export function serveWebPath(
  pathname: string,
  webDist: string,
  headers: Record<string, string>,
): Response {
  if (!existsSync(webDist)) {
    return jsonError(404, "web_not_built", "run: make web", headers);
  }
  const rel = staticRelativePath(pathname);
  if (rel === null) {
    return jsonError(404, "not_found", "not found", headers);
  }
  const index = join(webDist, "index.html");
  const candidate = rel.length === 0 ? index : join(webDist, rel);
  const cacheHeaders = { ...headers, "cache-control": cacheControlFor(rel) };
  if (isFile(candidate)) {
    return staticFileResponse(candidate, cacheHeaders);
  }
  if (rel.length === 0 || hasExtension(rel)) {
    return jsonError(404, "not_found", "not found", headers);
  }
  if (isFile(index)) {
    return staticFileResponse(index, cacheHeaders);
  }
  return jsonError(404, "not_found", "not found", headers);
}

// Version documents are immutable by design (restoring republishes as a NEW
// version — never a rewrite), and so are the vendored libs (filenames carry
// the lib version — the upgrade contract adds a file, never rewrites one).
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// GET /libs/<file> serves the vendored, version-stamped libraries from
// <repo>/server/libs — D18: board scripts run in the app origin and load
// them root-relative, so the host serves them itself. Filenames carry the
// lib version, so an upgrade adds a file and immutable caching can never
// strand an old board.
export function serveLib(
  libsDir: string,
  pathname: string,
  headers: Record<string, string>,
): Response {
  // same decode-then-reject rules as web/dist statics: one flat segment, no
  // dot segments, no embedded separators
  const rel = staticRelativePath(pathname.slice("/libs/".length));
  if (rel === null || rel.includes("/")) {
    return jsonError(404, "not_found", "not found", headers);
  }
  const candidate = join(libsDir, rel);
  if (!isFile(candidate)) {
    return jsonError(404, "not_found", "not found", headers);
  }
  return staticFileResponse(candidate, {
    ...headers,
    "cache-control": IMMUTABLE_CACHE,
  });
}
