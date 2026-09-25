import { jsonOk } from "../http.ts";
import { listTokens } from "../tokens.ts";
import { type RequestContext, type Route, requireHuman } from "./route.ts";

// Token inventory for the M7 audit view — the API mirror of `board token
// list` (cli/src/commands/token.ts surfaces NAME/CREATED/LAST USED/REVOKED):
// consistency, not new knowledge. The response NEVER carries token values or
// hashes — adjacent to invariant 7 (tokens stored hashed): the DB stores
// sha256s, this surface shows inventory, not credentials. last_used_at is renamed last_seen to match
// the naming the audit UI already consumes for sessions and subscribers.
// Human-only via requireHuman: enumerating agent token names is recon (the
// mirror of mcp.ts's D16 human-rejection — docs/security.md "Audit view").
function listTokensHandler(_req: Request, ctx: RequestContext): Response {
  requireHuman(ctx);
  return jsonOk({
    tokens: listTokens(ctx.db).map((info) => ({
      name: info.name,
      created_at: info.created_at,
      revoked_at: info.revoked_at,
      last_seen: info.last_used_at,
    })),
  });
}

export const tokenRoutes: Route[] = [
  { method: "GET", path: "/api/tokens", handler: listTokensHandler },
];
