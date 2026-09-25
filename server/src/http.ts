import type { Config } from "./config.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Percent-decoding for one URL path segment, shared by the route matcher and
// static path resolution. A malformed escape keeps the raw segment rather than
// throwing: a bad URL is a 404 from the caller's own rules, never a 500.
export function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export function jsonOk(data: unknown, status = 200): Response {
  return jsonResponse(status, data);
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
  details: Record<string, unknown> = {},
): Response {
  return jsonResponse(
    status,
    { error: { code, message, ...details } },
    headers,
  );
}

function jsonResponse(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// 8 MB document cap from docs/security.md ("Content rules").
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Body-read core for every capped read surface (JSON api, MCP, binary assets,
// import zips): an honest Content-Length is rejected up front, and a lying or
// absent one is caught DURING the stream — the cap is enforced chunk-wise, so
// no route ever buffers unbounded input before checking (M7 hardening; the
// previous readers awaited req.arrayBuffer() and checked after, leaving a
// chunked body free to fill memory up to whatever the runtime accepted).
// tooLarge receives the bytes actually seen (exact for a declared length, a
// lower bound for the streaming case) so each caller throws its own error
// type — HttpError 413 / AssetTooLarge / ImportRejected — with no http.ts
// import of the domain (which would cycle).
export async function readCappedBody(
  req: Request,
  maxBytes: number,
  tooLarge: (bytes: number) => Error,
): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw tooLarge(length);
    }
  }
  const stream = req.body;
  if (stream === null) {
    return new Uint8Array();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(total);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody(req: Request): Promise<unknown> {
  const bytes = await readCappedBody(req, MAX_BODY_BYTES, () => {
    throw new HttpError(
      413,
      "payload_too_large",
      `request body exceeds ${MAX_BODY_BYTES} bytes`,
    );
  });
  if (bytes.byteLength === 0) {
    return undefined;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

// JSON-only writes kill "simple request" form POSTs — CSRF defense per docs/security.md ("API hardening").
export function requireJsonContentType(req: Request): void {
  const mediaType = req.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      `writes require Content-Type: application/json, got ${mediaType ?? "none"}`,
    );
  }
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function hostnameFromHostHeader(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? "" : value.slice(1, close);
  }
  const colon = value.indexOf(":");
  if (colon > 0 && value.indexOf(":", colon + 1) === -1) {
    return value.slice(0, colon);
  }
  return value;
}

// DNS-rebinding defense: strict Host-header allowlist, any port allowed (docs/security.md "API hardening").
export function assertAllowedHost(req: Request, config: Config): void {
  const host = req.headers.get("host");
  if (host === null) {
    throw new HttpError(421, "bad_host", "missing Host header");
  }
  const hostname = hostnameFromHostHeader(host);
  if (!LOOPBACK_HOSTNAMES.has(hostname) && !config.bind.includes(hostname)) {
    throw new HttpError(421, "bad_host", `Host "${hostname}" is not allowed`);
  }
}

// CSRF defense (docs/security.md): browsers always send Sec-Fetch-Site; non-browser clients (curl, agents) omit it.
export function rejectCrossSite(req: Request): void {
  if (
    isUnsafeMethod(req.method) &&
    req.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new HttpError(
      403,
      "cross_site_blocked",
      "cross-site writes are rejected",
    );
  }
}
