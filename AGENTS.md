# AGENTS.md

Guidance for AI coding agents working in this repository. Humans: this applies to you too.

## What this is

`board` is a local-first shared board system: an always-on Bun daemon hosts rich boards (markdown + interactive HTML) that agents publish via MCP/REST, a human annotates with anchored comments in a web UI, and everyone consumes via an append-only event log.

**Current status: M1–M8 complete (2026-09-16), dogfooded, the feedback loop live end to end.** Agents publish markdown or html boards over REST or the 15-tool MCP surface, a human annotates them with anchored comments — text, section, table row, image overlay — in the web UI, and agents consume the result through the comments cursor (D15) or HMAC-signed webhooks. Two daemon flavours exist: the shared daemon on `127.0.0.1:7800`, human-managed and optional since D21, and agent-owned throwaway session instances (`board up`/`down`, D20) — and harnesses reach MCP through a local stdio connector (`board mcp`, D22) that resolves one of them per request, so the wired tools work against whichever is running. The milestone narrative lives in [docs/plan.md](docs/plan.md).

### Source tree

| Area | Entrypoint | Owns | Must not |
|---|---|---|---|
| `server/src` | `main.ts` (`runDaemon`) | the daemon: `Bun.serve` + request middleware (`daemon.ts`, `http.ts`), auth, the SQLite store, the render pipeline, events, webhooks, MCP handlers | bypass the store's event append; widen the host CSP; open a second write path onto `~/.board` |
| `server/src/routes` | `route.ts` (the `Route` contract, path matching, the `actorName`/`requireHuman` guards) | one file per REST area, each exporting its own routes — `daemon.ts`'s `routes` concatenates them into the one served table; handlers parse, validate, delegate | hold business logic — it belongs one level up, where MCP calls it too |
| `server/src/mcp-tools.ts` | imported by daemon *and* connector | the single-source MCP manifest: names, descriptions, zod schemas, registration order | import anything but zod — the connector runs this file under node's type-stripping |
| `cli/src` | `main.ts` (argv dispatch + `USAGE`) | session-instance lifecycle (`instances.ts`), the registry, instance/credential resolution (`resolve.ts`), table printing | hold one command's argv parsing or printed output — that is `commands/`'s job |
| `cli/src/commands` | one file per command, plus helpers shared only between them (`rest.ts` argv scanner + REST plumbing, `handles.ts` generated handles) | argv parsing, the per-command flow, and printed UX | duplicate or re-implement what the layer above owns (`instances.ts`, `resolve.ts`, `table.ts`) |
| `cli/src/mcp-connector.ts` | stdio, spawned by the agent harness | `initialize`/`ping`, `tools/list` off the manifest, per-request backend resolution, `board_servers`/`board_connect` answered locally | import the Bun graph or write to disk — it runs as plain `node`, in the **agent's** process |
| `web/src` | `main.tsx` | the React + Vite SPA: board list, board view + comment sidebar, audit view, image overlay editor; `styles.css` owns `.board-ui` | rename a `.board-ui` class — published versions are immutable and already use it (D26) |
| `server/libs` | served at `GET /libs/<file>` | vendored, version-stamped libs (chart.js 4.4.9, tailwind 4.3.3) | rewrite an existing file, or load a library from a CDN at runtime |
| `skills/` | `board/SKILL.md`, `interview/SKILL.md` | agent-facing instructions plus `templates/` | restate the [docs/api.md](docs/api.md) contract — link to it |
| `scripts/` | `setup.sh`, `smoke.ts` | the one-command bootstrap; the 21-step acceptance loop | touch `~/.board` or `:7800` — temp data dir and scratch ports only |
| `docs/` | `architecture.md` | the reference set (read order below) | let a doc outlive the change that invalidated it |

### How the CLI is actually invoked

- `board <cmd>` in the docs means **`bun run cli/src/main.ts <cmd>`**; the `make` targets below are the supported spelling.
- `cli/package.json` declares a `bin` named `board`, but `private: true` in a Bun workspace means it is never linked — there is no `board` on your `PATH`.
- The connector is the one thing spawned directly, and as plain **`node cli/src/mcp-connector.ts`**: agent harness PATHs have node, not reliably bun.

The `USAGE` string in `cli/src/main.ts` is the authoritative command list. What the `make` table below omits:

```
  list                 boards: status, current version, unresolved comments
  export <id> [file]   save a board bundle as a zip (default <id>.zip)
  import <file>        recreate a board from a bundle under a fresh board id
  status <board id>    one board's health: status, version, unresolved comments
  mcp                  the stdio MCP connector an agent harness spawns

  --instance <id> / BOARD_INSTANCE   target a session instance's daemon + db
  --token <tok>   / BOARD_TOKEN      the REST credential (list/status/export/import)
```

## Read order

1. [docs/architecture.md](docs/architecture.md) — process model, request flows, events
2. [docs/security.md](docs/security.md) — the threat model, and the reasoning behind the invariants below
3. [docs/style-guide.md](docs/style-guide.md) — code conventions
4. [docs/decisions.md](docs/decisions.md) — why things are the way they are; the `D<n>` markers cited throughout the code resolve here
5. [docs/plan.md](docs/plan.md) — the project record: approved scope and milestone history

Below this required reading sit the reference docs — [docs/api.md](docs/api.md) (the API contract), [docs/anchors.md](docs/anchors.md), [docs/feedback-grammar.md](docs/feedback-grammar.md), [docs/deployment.md](docs/deployment.md), [docs/stack.md](docs/stack.md) (the build-time technology choices, and the ones deliberately rejected) — same binding rule: a change to the API surface, anchors, feedback loop, deployment, or the dependency/toolchain set updates its doc in the same change.

## Commands

All targets are live (`make list`/`export`/`import` arrived with M6; session `up`/`down`/`instances` with M8):

| Task | Command |
|---|---|
| One-command setup (new device) | `make setup` (or `./scripts/setup.sh`) — deps + web build + agent wiring; never starts the daemon (D21) |
| Install deps | `make deps` (wraps `bun install`) |
| Wire agents (MCP connector + skill + tokens) | `make install` (`--force` via `make install FLAGS=--force`) — wires the D22 stdio connector (`board mcp`) into opencode/claude |
| Test | `make test` (wraps `bun test`) |
| End-to-end smoke | `make smoke` (temp daemon + scratch ports, never `~/.board`) |
| Typecheck | `make typecheck` (wraps `bunx tsc --noEmit`) |
| Lint + format | `make lint` (wraps `bunx biome check --write .`) |
| Run daemon | `make serve` |
| Dev (hot reload) | `make dev` |
| Spawn a session board | `make up [FILE=<md>] [TITLE="…"] [FLAGS=…]` (or positional `make up plan.md`) |
| Tear down a session board | `make down [ID=s-xxxx] [FLAGS=…]` |
| List session boards | `make instances [FLAGS=--all\|--prune]` |
| Mint agent token | `make token add [name]` (no name mints a generated color-animal handle — the @mention handle, D23; `--force` via `make token add <name> FLAGS=--force` re-mints a taken name, D17) |
| Build web app | `make web` |
| Open UI | `make open [board id]` |

Run typecheck, lint, and tests before finishing any change. If a command doesn't exist yet, you're early — don't invent behavior that contradicts the plan.

## Non-negotiable invariants

These exist for security reasons ([docs/security.md](docs/security.md)). Do not violate them, even temporarily, even in tests. **Cite one as `invariant N (short name)`** — the bolded name below is the canonical one. Cite the name because a bare ordinal cannot be checked against the sentence it sits in: nothing catches an author who half-remembers the list — not a reviewer, not `tsc`, not a test. A wrong *name* is visibly wrong on sight (“invariant 4, events are append-only” beside a sentence about which database a token row lands in reads as a mismatch immediately); a wrong *number* reads as fine. The name is required wherever the ordinal is the **only** statement of the rule — a terse cross-reference, a file header, a test name that names no behavior — and optional wherever the sentence already states it (`no result ever carries token material (invariant 7)`, `cli/src/mcp-connector.ts`), because there the ordinal is checkable against the prose beside it, which is the whole point: the exception follows from the reason for the convention rather than weakening it. Every miscitation this convention was written to fix was wrong the day it was written, not stale — there have only ever been seven, so “invariant 8” was never right. Surviving a renumber is a real benefit, but a secondary one:

1. **Loopback bind.** Bind loopback only (`127.0.0.1`) unless the user explicitly configures otherwise.
2. **Host-render, CSP is the guard.** Agent HTML boards render in the host chrome with scripts running (D18, owner decision 2026-09-15). The host CSP is the guard: `connect-src 'self'` never opens, `form-action 'self'` stays. Never widen the host CSP beyond the allowlist in [docs/security.md](docs/security.md).
3. **Writes go through the daemon.** All writes go through the daemon API. Agents never write to `~/.board` directly.
4. **Events are append-only.** Never mutate or delete an event row.
5. **Markdown through DOMPurify.** Markdown published content passes through DOMPurify — no exceptions. html-format boards are exempt per D18; never add sanitization to them, or skip it for markdown, without the owner's say-so.
6. **Verified asset ingest.** Asset ingest verifies magic bytes + mime allowlist + size cap; the `{path}` file-copy route must never be usable to read non-image files.
7. **Tokens stored hashed.** Never log or commit tokens; tokens are stored hashed. (The one sanctioned ephemeral exception is the D20 session-instance credential env file — mode 0600, purged at `board down`.)

## Conventions

- TypeScript strict mode; formatting via biome — see [docs/style-guide.md](docs/style-guide.md).
- **Minimal codebase**: when a feature is removed, its code, tests, and fixtures are removed in the same change — no dead code, no vestigial surfaces, no "might be useful later."
- **Decision comments**: every non-obvious decision site in code carries a short comment with its why (and a [docs/decisions.md](docs/decisions.md) reference when one exists) so future agents inherit the context.
- **Structural guards, not just identity checks**: a destructive path validates the *shape* of what it is about to touch (expected path roots, id shapes), not merely who or what it appears to be — corrupt state can falsify an identity check; it cannot falsify filesystem shape (M8 audit lesson, D20).
- A change that affects the API surface, anchor schema, event types, or security headers updates the matching doc in the same change.
- Decisions that deviate from the plan get a new entry in [docs/decisions.md](docs/decisions.md) — don't silently amend the plan.
- Mark milestone progress by appending status to the milestone bullet in [docs/plan.md](docs/plan.md).
- Commit messages: short imperative subject, e.g. `m1: wire publish + 409 conflict handling`.
- Tasks with a human decision point go on a board for async review — when/how per [skills/board/SKILL.md](skills/board/SKILL.md) (shared daemon for persistent review, `make up` for task-scoped sessions).
- `~/.board` is user data — tests and dev runs use a temp `BOARD_DATA_DIR`, never the real one.

## Extending the surface

**Adding an MCP tool.**

1. `server/src/mcp-tools.ts` — add the name to the `McpToolName` union.
2. Same file — add the definition to `MCP_TOOLS`: name, description, zod `inputSchema`. **Registration order is wire order** (the SDK preserves it, and the connector's offline listing must match), so append rather than insert. **This file may import only zod** — the header comment says why: the connector is spawned as `node …/mcp-connector.ts` and imports the manifest under node's type-stripping, so a Bun API, a `bun:sqlite` import, or a reach into the store breaks every agent's tool list. This is the step a first attempt gets wrong.
3. `server/src/mcp.ts` — mirror the argument shape in `ToolArgs` (types only; the manifest's zod schema is the runtime validation).
4. Same file — add the handler to `TOOL_HANDLERS`. It calls a **service** function, never a route handler.
5. [docs/api.md](docs/api.md) — add the row to the MCP tool table, in the same change.

**Adding a REST route.**

1. Add or extend the service function in `server/src/*.ts` (`boards.ts`, `comments.ts`, `assets.ts`, `bundle-export.ts`/`bundle-import.ts`, `webhooks.ts`, …) so MCP can reach the same behavior.
2. Add the entry to the route table in the matching `server/src/routes/*.ts`; the handler parses params, validates, and delegates.
3. New domain error? Map it to its status + code in `errorResponse` (`server/src/errors.ts`) — the single translation point, per the style guide. Handlers and services throw typed errors and know nothing about status codes.
4. [docs/api.md](docs/api.md) — the route row plus any new error code.

**Adding an event type.**

1. `server/src/domain.ts` — add it to the `EventType` union.
2. Append it via `appendEvent` (`server/src/events.ts`) at the mutation site, inside the same service function that made the change. That one call writes the db row and mirrors both jsonl files; never hand-roll a second write path.
3. Additive only — invariant 4 (events are append-only) means an existing row is never mutated or deleted to accommodate a new type.
4. [docs/architecture.md](docs/architecture.md) "Events" and [docs/api.md](docs/api.md).
