// The one place the `unknown`-to-message narrowing lives. `catch` binds
// `unknown` under strict mode, so every reporting site needs this narrowing;
// written out inline it appeared at 32 sites across server/, cli/ and web/.
//
// It lives under server/src because that is the only directory all three areas
// already import from at runtime (web/src/components/CommentSidebar.tsx imports
// feedback.ts) — a shared workspace for one function is not worth the build
// surface.
//
// NOT importable from cli/src/mcp-connector.ts: that file runs under plain
// `node` and cannot import anything in the Bun graph, so it keeps its own copy
// on purpose. See the comment at its own definition there.
//
// `fallback` exists because the 32 sites were not one idiom but two. Server,
// CLI and script sites all end `: String(err)` — the thrown value is going
// into a log or an error envelope, so stringifying it is the useful thing.
// Every web/ site instead ends in a domain string ("upload failed"), because
// that text is rendered to a human, and `String(err)` on a non-Error yields
// "[object Object]". Collapsing the second kind into the first is a
// user-visible regression; pass the domain string here to keep it.
export function errText(err: unknown, fallback?: string): string {
  if (err instanceof Error) {
    return err.message;
  }
  return fallback ?? String(err);
}
