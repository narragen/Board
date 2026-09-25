// The daemon: process lifecycle plus the three-way host router every surface is
// mounted on (docs/architecture.md "Process model"). What is where:
// `/api/*` → the `routes` table below, `/mcp` → the stateless MCP transport,
// `/assets/<id>` → board asset bytes, `/libs/*` → the vendored pinned libs,
// everything else → the built SPA (static.ts serves the last two).
//
// Must-not: this file decides no status codes of its own. Error → HTTP
// translation lives in errors.ts and nowhere else (docs/style-guide.md);
// handlers and services throw domain errors.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { requireAuth } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { errorResponse } from "./errors.ts";
import { onEvent } from "./events.ts";
import {
  assertAllowedHost,
  HttpError,
  isUnsafeMethod,
  jsonError,
  readJsonBody,
  rejectCrossSite,
  requireJsonContentType,
} from "./http.ts";
import { handleMcpNonPost, handleMcpPost, requireMcpActor } from "./mcp.ts";
import { assetRoutes, isBoardAssetPath, serveAsset } from "./routes/assets.ts";
import { boardRoutes } from "./routes/boards.ts";
import { commentRoutes } from "./routes/comments.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoute } from "./routes/health.ts";
import {
  matchPath,
  matchRoute,
  type RequestContext,
  type Route,
  routeRequiresAuth,
} from "./routes/route.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { streamRoute } from "./routes/stream.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { serveLib, serveWebPath } from "./static.ts";
import { type DispatcherOptions, startWebhookDispatcher } from "./webhooks.ts";

interface Daemon {
  hostServer: Bun.Server<undefined>;
  hostUrl: string;
  db: Database;
  stop(): Promise<void>;
}

interface DaemonOptions {
  // Where resolveWebDist starts walking to find the repo root; the test seam
  // for pointing the daemon at a fixture web/dist.
  webRootHint?: string;
  // Webhook dispatcher knobs (test seam for the retry backoff).
  webhook?: DispatcherOptions;
}

const routes: Route[] = [
  healthRoute,
  ...sessionRoutes,
  ...boardRoutes,
  ...commentRoutes,
  ...eventRoutes,
  ...webhookRoutes,
  ...assetRoutes,
  ...tokenRoutes,
  streamRoute,
];

// Host-app CSP, exact (D18). Agent board scripts run in the app's origin —
// hence script-src 'unsafe-inline' — at the owner's explicit risk acceptance
// (docs/decisions.md D18). What survives as the guard: connect-src 'self' is
// the exfiltration kill-switch (never opens), form-action 'self' keeps boards
// from form-navigating the app away, and frame-ancestors 'none' still
// protects the app from being framed by anyone.
export function hostSecurityHeaders(): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
  };
}

export function originUrlFor(host: string, port: number): string {
  // IPv6 needs brackets in a URL authority (`http://::1:7800` is unparseable);
  // already-bracketed input passes through untouched.
  const hostname =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

// The daemon locates the repo root by walking up from daemon.ts (or a
// caller-supplied hint) until it sees package.json + Makefile, so it never
// needs a configured path. rootHint is the seam tests use to point at a
// fixture tree.
export function resolveRepoRoot(rootHint?: string): string {
  let dir = rootHint ?? import.meta.dir;
  for (;;) {
    if (
      existsSync(join(dir, "package.json")) &&
      existsSync(join(dir, "Makefile"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not locate the board repo root (package.json + Makefile) starting from ${
          rootHint ?? import.meta.dir
        }`,
      );
    }
    dir = parent;
  }
}

export function resolveWebDist(rootHint?: string): string {
  return join(resolveRepoRoot(rootHint), "web", "dist");
}

async function handleApiRequest(
  req: Request,
  config: Config,
  db: Database,
  dataDir: string,
): Promise<Response> {
  try {
    assertAllowedHost(req, config);
    rejectCrossSite(req);
    const { pathname } = new URL(req.url);
    // Match the route first: raw-body routes (binary asset ingest) read their
    // own body and are exempt from the JSON-only enforcement below.
    let matched: { route: Route; params: Record<string, string> } | null = null;
    for (const route of routes) {
      const params = matchRoute(route, req.method, pathname);
      if (params !== null) {
        matched = { route, params };
        break;
      }
    }
    // JSON-only writes + the body cap stay AHEAD of any routing outcome
    // (415/413 must not lose to 404/405) — except raw-body routes.
    let body: unknown;
    if (isUnsafeMethod(req.method) && matched?.route.rawBody !== true) {
      requireJsonContentType(req);
      body = await readJsonBody(req);
    }
    if (matched === null) {
      // 405 is computed over routes whose pattern matches the concrete pathname
      const allowed = [
        ...new Set(
          routes
            .filter((route) => matchPath(route, pathname) !== null)
            .map((route) => route.method),
        ),
      ];
      if (allowed.length > 0) {
        return jsonError(
          405,
          "method_not_allowed",
          `${req.method} is not allowed for ${pathname}`,
          { allow: allowed.join(", ") },
        );
      }
      throw new HttpError(404, "not_found", `no route for ${pathname}`);
    }
    const ctx: RequestContext = {
      body,
      params: matched.params,
      db,
      dataDir,
    };
    if (routeRequiresAuth(matched.route)) {
      ctx.actor = requireAuth(req, db);
    }
    return await matched.route.handler(req, ctx);
  } catch (err) {
    return errorResponse(err);
  }
}

// The MCP endpoint: same request hardening as /api (DNS-rebinding, CSRF,
// JSON-only writes), then agent-only bearer auth, then the stateless
// JSON-mode MCP transport (D16, server/src/mcp.ts).
async function handleMcpRequest(
  req: Request,
  config: Config,
  db: Database,
  dataDir: string,
): Promise<Response> {
  try {
    assertAllowedHost(req, config);
    rejectCrossSite(req);
    if (req.method !== "POST") {
      return handleMcpNonPost();
    }
    requireJsonContentType(req);
    const actor = requireMcpActor(req, db);
    return await handleMcpPost(req, { db, dataDir, actor });
  } catch (err) {
    return errorResponse(err);
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

// The host server is four things in one: /api/* (plus /mcp) through the route
// table, /libs/* (vendored pinned libs — D18: board scripts run in the app
// origin and load them root-relative), board assets under /assets/<id>, and
// everything else the built SPA — all with the same request hardening.
async function handleHostRequest(
  req: Request,
  config: Config,
  db: Database,
  dataDir: string,
  webDist: string,
  libsDir: string,
  headers: Record<string, string>,
): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (isApiPath(pathname)) {
    return withHostHeaders(
      await handleApiRequest(req, config, db, dataDir),
      headers,
    );
  }
  // /mcp is mounted here as a bare branch, deliberately OUTSIDE the routes[]
  // table: the table's middleware runs requireAuth, which accepts human
  // session tokens, and the MCP endpoint is agent-tokens-only (D16 — see
  // requireMcpActor). It also answers non-POST with its own 405 envelope.
  if (pathname === "/mcp") {
    return withHostHeaders(
      await handleMcpRequest(req, config, db, dataDir),
      headers,
    );
  }
  try {
    assertAllowedHost(req, config);
    rejectCrossSite(req);
    if (req.method !== "GET") {
      return jsonError(
        405,
        "method_not_allowed",
        `${req.method} is not allowed for static paths`,
        { ...headers, allow: "GET" },
      );
    }
    // board assets before the SPA statics: the 10-char id shape is what keeps
    // vite's hashed /assets/* bundle files falling through to web/dist
    if (isBoardAssetPath(pathname)) {
      return serveAsset(req, db, dataDir, headers);
    }
    if (pathname.startsWith("/libs/")) {
      return serveLib(libsDir, pathname, headers);
    }
    return serveWebPath(pathname, webDist, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
}

// Every response class carries the host headers — CSP + nosniff on api/mcp
// responses too (the route layer's jsonOk/jsonError know no headers; M7 audit:
// docs/security.md "API hardening" applies to every request), plus no-cache
// unless the route pinned its own cache policy (the SSE stream's no-cache, the
// immutable asset/lib routes — those carry host headers already anyway).
// Route-set content-type etc. survive: only the host header names are set.
function withHostHeaders(
  res: Response,
  headers: Record<string, string>,
): Response {
  const merged = new Headers(res.headers);
  for (const [name, value] of Object.entries(headers)) {
    merged.set(name, value);
  }
  if (!merged.has("cache-control")) {
    merged.set("cache-control", "no-cache");
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: merged,
  });
}

function boundPort(server: Bun.Server<undefined>): number {
  const port = server.port;
  if (port === undefined) {
    throw new Error("server has no bound port");
  }
  return port;
}

export function startDaemon(config: Config, opts: DaemonOptions = {}): Daemon {
  const db = openDb(config.dataDir);
  // Webhook dispatcher: fire-and-forget off the event bus — event appends and
  // request handling never wait on deliveries (docs/architecture.md).
  const dispatchWebhooks = startWebhookDispatcher(
    db,
    config.dataDir,
    opts.webhook,
  );
  const offDispatch = onEvent(dispatchWebhooks);
  // Vendored pinned libs for board scripts (D18: they run in the app origin
  // and load /libs/* root-relative). Missing dir just 404s at serve time.
  const libsDir = join(resolveRepoRoot(opts.webRootHint), "server", "libs");
  let hostServer: Bun.Server<undefined>;
  try {
    const webDist = resolveWebDist(opts.webRootHint);
    const webHeaders = hostSecurityHeaders();
    hostServer = Bun.serve({
      hostname: config.host,
      port: config.port,
      fetch: (req) =>
        handleHostRequest(
          req,
          config,
          db,
          config.dataDir,
          webDist,
          libsDir,
          webHeaders,
        ),
    });
  } catch (err) {
    offDispatch();
    db.close();
    throw err;
  }
  return {
    hostServer,
    hostUrl: originUrlFor(config.host, boundPort(hostServer)),
    db,
    stop: async () => {
      offDispatch();
      await hostServer.stop(true);
      db.close();
    },
  };
}
