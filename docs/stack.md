# Technology stack

The build-time technology choices, and the ones deliberately rejected. Where a choice's reasoning is owned by a decision, the *Why* column cites it rather than restating it — [decisions.md](decisions.md) is the log, [architecture.md](architecture.md) the system design.

## Choices

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun** | One tool for runtime + test runner, `bun:sqlite` builtin, single-binary distribution still possible (D2). |
| Language | **TypeScript (strict)** | One language across daemon, web, and CLI; the MCP SDK is TS (D2). |
| HTTP | **raw `Bun.serve()`** — no framework | One host origin and one flat router table (API + MCP + statics) don't earn a framework's weight (D2). |
| Storage | **SQLite (`bun:sqlite`, WAL)** + on-disk mirrors | Queryable source of truth, concurrent agent writes safe under WAL, per-board bundles for portability and greppability (D6; `bun:sqlite` per D2). |
| Web UI | **React + Vite** | Standard SPA built to `dist/` and served by the daemon; plannotator/OpenDesign precedent. No decision entry owns this one — the approved scope is [plan.md](plan.md) "Web UI". |
| Markdown | **marked (GFM) → DOMPurify → data-ba injection → katex → Shiki** | Rendered server-side at publish, sanitized once, stored as one immutable HTML document (D5's surviving half; the happy-dom correctness patch DOMPurify needs is D11). Mermaid fences stay source in the stored doc — the web app renders them client-side (D12). The pipeline itself: [architecture.md](architecture.md#one-document-model). |
| Vendored board libs | exact pins served from `/libs/*` on the host origin — [`server/libs/README.md`](../server/libs/README.md) is the inventory; mermaid, katex, and Shiki ship as npm deps bundled into the app instead (D12, D26) | No runtime CDNs — supply-chain control (D8, as trimmed by D18: one origin); a board authored today renders identically next year. |
| MCP | **`@modelcontextprotocol/sdk`**, Streamable HTTP (rev 2026-07-28) | Rides the same daemon and port, every harness supports it natively, plain REST stays first-class alongside (D9; stateless JSON mode is D16). |
| Lint/format | **biome** | One fast tool for both; `bunx tsc --noEmit` remains the typecheck (D2). |
| Tests | **bun test** | Builtin, fast, no config sprawl (D2). |
| Ops | **Makefile** wrapping a thin `board` CLI | The user-facing operational interface, no auto-spawn magic (D10) — for the shared daemon, which D21 made optional; agents manage throwaway session instances via `make up/down/instances` (D20). |

## Deliberately avoided

- **Forks as a base.** open-canvas (archived, Supabase-bound), open-artifacts (Cloudflare-bound), OpenDesign (96k-star ecosystem with always-on telemetry), plannotator (per-session review model — wrong persistence shape). We steal patterns, not codebases; see [research.md](research.md).
- **Web frameworks (Express/Hono/Fastify).** Two static-ish routers; a framework adds dependencies without adding safety.
- **Next.js / SSR / Electron.** Localhost SPA served by the daemon; no desktop packaging in v1.
- **CRDTs (Yjs/Automerge) in v1.** Boards are agent-published immutable rounds, not concurrently-edited documents. Revisit in phase 2.
- **External CDNs at runtime.** Everything vendored + pinned under `/libs/` on the host origin.
- **A chat pane in the web UI.** The terminal stays the chat; the board is for artifacts + anchored feedback.

## Versioning policy

- App dependencies: standard semver ranges, lockfile committed.
- Vendored board libraries: **exact pins**, upgraded deliberately and never floating — old boards must keep rendering.
