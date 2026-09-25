import type { Database } from "bun:sqlite";
import type { Actor } from "../domain.ts";
import { decodeSegment, HttpError } from "../http.ts";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestContext {
  body?: unknown;
  params: Record<string, string>;
  actor?: Actor;
  db: Database;
  dataDir: string;
}

// Authed routes always get an actor from the daemon middleware; this guard
// only fires on a route-table misconfiguration. Shared by every route file
// that needs the actor's name (was copy-pasted in boards/comments/assets/
// webhooks).
export function actorName(ctx: RequestContext): string {
  if (ctx.actor === undefined) {
    throw new HttpError(
      500,
      "internal_error",
      "authenticated route ran without an actor",
    );
  }
  return ctx.actor.name;
}

// Human-only surfaces (the M7 operator panels: session inventory/revocation,
// token inventory). The mirror of mcp.ts's requireMcpActor (D16), which
// rejects human tokens for the inverse reason — same shape, opposite
// direction: an agent enumerating human sessions or token names is recon,
// so a VALID agent bearer still gets 403, not 401.
export function requireHuman(ctx: RequestContext): Actor {
  if (ctx.actor === undefined) {
    throw new HttpError(
      500,
      "internal_error",
      "authenticated route ran without an actor",
    );
  }
  if (ctx.actor.kind !== "human") {
    throw new HttpError(403, "forbidden", "human session required");
  }
  return ctx.actor;
}

// Non-object bodies read as {} so field validators reject them with the
// missing field name (e.g. "title must be a string") instead of crashing.
// Takes the raw body value (not the ctx) so raw-body routes can hand it a
// body they parsed themselves.
export function bodyFields(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : {};
}

export interface Route {
  method: HttpMethod;
  // pattern: literals plus ":name" path params, e.g. "/api/boards/:id/versions/:n"
  path: string;
  // default true: bearer auth on everything; only health opts out
  auth?: boolean;
  // raw-body routes read their own request body — the daemon skips its
  // JSON-only content-type enforcement + parse for them (binary asset ingest)
  rawBody?: boolean;
  handler: (req: Request, ctx: RequestContext) => Response | Promise<Response>;
}

export function routeRequiresAuth(route: Route): boolean {
  return route.auth ?? true;
}

const PATH_PATTERN_CACHE = new Map<string, RegExp>();

// ":name" segments become non-empty named captures ([^/]+ — no crossing into
// the next segment); literal segments are escaped verbatim.
function patternRegExp(path: string): RegExp {
  let re = PATH_PATTERN_CACHE.get(path);
  if (re === undefined) {
    const source = path
      .split("/")
      .map((segment) =>
        segment.startsWith(":")
          ? `(?<${segment.slice(1)}>[^/]+)`
          : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/");
    re = new RegExp(`^${source}$`);
    PATH_PATTERN_CACHE.set(path, re);
  }
  return re;
}

// Pattern-only match (method ignored) — the daemon uses this to compute 405 Allow.
export function matchPath(
  route: Route,
  pathname: string,
): Record<string, string> | null {
  const match = patternRegExp(route.path).exec(pathname);
  if (match === null) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(match.groups ?? {})) {
    params[name] = decodeSegment(value);
  }
  return params;
}

export function matchRoute(
  route: Route,
  method: string,
  pathname: string,
): Record<string, string> | null {
  if (route.method !== method) {
    return null;
  }
  return matchPath(route, pathname);
}
