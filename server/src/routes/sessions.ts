import { HttpError, jsonOk } from "../http.ts";
import {
  exchangeSession,
  InvalidExchangeToken,
  listSessions,
  revokeSession,
} from "../sessions.ts";
import { asString } from "../validate.ts";
import {
  bodyFields,
  type RequestContext,
  type Route,
  requireHuman,
} from "./route.ts";

// auth: false — this endpoint IS the auth bootstrap (docs/security.md: the
// one-time ?token= exchange). Every other middleware (Host allowlist,
// Sec-Fetch-Site rejection, JSON-only writes) still applies because the route
// runs through the same api pipeline as everything else.

function exchangeHandler(_req: Request, ctx: RequestContext): Response {
  const body = bodyFields(ctx.body);
  const exchangeToken = asString(body.token, "token");
  let sessionToken: string;
  try {
    sessionToken = exchangeSession(ctx.db, exchangeToken);
  } catch (err) {
    if (err instanceof InvalidExchangeToken) {
      // Invariant 7 (tokens stored hashed): describe the failure, never the
      // credential.
      throw new HttpError(
        401,
        "unauthorized",
        "invalid, expired, or already-used exchange token",
      );
    }
    throw err;
  }
  return jsonOk({ token: sessionToken });
}

// Human-only operator surfaces (M7 audit view, docs/security.md "Audit
// view"): the session inventory + revocation are the leak remediation — the
// owner once pasted a live ?token= into a comment and had no way to kill the
// resulting credential. requireHuman 403s agent bearers: enumerating human
// sessions is recon (the mirror of mcp.ts's D16 human-rejection).
function listSessionsHandler(_req: Request, ctx: RequestContext): Response {
  requireHuman(ctx);
  return jsonOk({ sessions: listSessions(ctx.db) });
}

// Revoking the CURRENT session is allowed on purpose (self-revoke — the UI's
// re-exchange flow handles the dead credential); the API just guarantees the
// row is gone, so the very next request with that bearer 401s. 204, no body.
function revokeSessionHandler(_req: Request, ctx: RequestContext): Response {
  requireHuman(ctx);
  if (!revokeSession(ctx.db, ctx.params.id)) {
    // the id is the (non-secret) sha256 row id — echoing it is safe, since
    // invariant 7 (tokens stored hashed) concerns token material
    throw new HttpError(
      404,
      "session_not_found",
      `no session "${ctx.params.id}"`,
    );
  }
  return new Response(null, { status: 204 });
}

export const sessionRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/session/exchange",
    auth: false,
    handler: exchangeHandler,
  },
  { method: "GET", path: "/api/sessions", handler: listSessionsHandler },
  {
    method: "DELETE",
    path: "/api/sessions/:id",
    handler: revokeSessionHandler,
  },
];
