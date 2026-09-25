import type { Database } from "bun:sqlite";
import type { Actor } from "./domain.ts";
import { HttpError } from "./http.ts";
import { verifySessionToken } from "./sessions.ts";
import { verifyToken } from "./tokens.ts";

// Bearer header preferred; ?token= query fallback for clients that cannot set
// headers (EventSource). Shared by the SSE stream and the MCP endpoint (D13).
export function resolveRequestToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ") === true) {
    const token = header.slice(7).trim();
    if (token.length > 0) {
      return token;
    }
  }
  return new URL(req.url).searchParams.get("token");
}

// Token → Actor: agent tokens first, then human session tokens; null when
// neither matches. One core under every bearer surface, with exactly two
// deliberate variants on top: requireAuth (REST) is header-ONLY with strict
// scheme parsing because every REST client can set headers — no reason to
// put a token in a URL where it leaks into logs; the MCP endpoint and the
// SSE stream accept header OR ?token= because EventSource (D13) and thin MCP
// tooling cannot set headers. MCP additionally rejects the human actor (D16).
export function resolveActor(db: Database, token: string): Actor | null {
  const info = verifyToken(db, token);
  if (info !== null) {
    return { kind: "agent", name: info.name };
  }
  // Human browser sessions (docs/security.md): a kind='session' row from the
  // one-time ?token= exchange authenticates as the single local human.
  if (verifySessionToken(db, token)) {
    return { kind: "human", name: "human" };
  }
  return null;
}

export function requireAuth(req: Request, db: Database): Actor {
  const header = req.headers.get("authorization");
  if (header === null) {
    throw new HttpError(401, "unauthorized", "missing Authorization header");
  }
  const trimmed = header.trim();
  const space = trimmed.indexOf(" ");
  const scheme = space === -1 ? "" : trimmed.slice(0, space).toLowerCase();
  const token = space === -1 ? "" : trimmed.slice(space + 1).trim();
  if (scheme !== "bearer" || token.length === 0) {
    throw new HttpError(
      401,
      "unauthorized",
      "expected Authorization: Bearer <token>",
    );
  }
  const actor = resolveActor(db, token);
  if (actor !== null) {
    return actor;
  }
  // Invariant 7 (tokens stored hashed): the token value must never surface in
  // errors or logs — describe the failure, not the credential.
  throw new HttpError(401, "unauthorized", "invalid or revoked token");
}
