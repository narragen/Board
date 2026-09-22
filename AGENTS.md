# AGENTS.md

Guidance for AI coding agents working in this repository. Humans: this applies to you too.

## What this is

`board` is a local-first shared board system: an always-on Bun daemon hosts rich boards (markdown + interactive HTML) that agents publish via MCP/REST, a human annotates with anchored comments in a web UI, and everyone consumes via an append-only event log.

**Current status: M1–M8 all complete (2026-09-16)** — the feedback loop is live end to end and dogfooded: agents publish boards via REST or MCP (15 tools — 13 on the daemon's stateless Streamable HTTP `:7800/mcp` + 2 connector-local discovery/connect tools, `board_servers`/`board_connect`, per D23 D4 — wired since D22 through the local stdio connector `board mcp` so the tools work against any running board server — shared daemon or session instance — and explicit targeting via `BOARD_INSTANCE` or a `board_connect` pin beats auto-resolution), every board — markdown and agent HTML — renders in the host chrome with full anchoring (text selection, sections, rows, images; html boards get auto-injected `data-ba` at publish, scripts run per D18), humans comment with threads + resolve + live SSE (image comments carry arrow/box overlays, overlays post without body text — the overlay is the payload), agents consume feedback via the comments cursor (D15) or HMAC-signed webhooks; assets ingest through verification (magic bytes + mime allowlist + caps, SVG sanitized) and boards round-trip through export/import with the D18 quarantine re-examination. M7 added: the audit view (`GET /api/events` filters + human-only sessions list/revoke + token inventory; UI at `#/audit`), restore-to-version, the hardening pass (stream-enforced body caps, host headers on `/api` + `/mcp`, 30-day session TTL per D19), reference docs ([api](docs/api.md) / [anchors](docs/anchors.md) / [feedback-grammar](docs/feedback-grammar.md) / [deployment](docs/deployment.md) incl. Dockerfile), and `make smoke` (the scripted two-agents+human acceptance loop). M8 added agent-managed session instances (D20): `board up`/`down`/`instances` run a task-scoped loopback daemon the agent owns end to end — OS-temp data dir, print-once token + 0600 credential env file, pid-identity + structural-guard teardown (audit-hardened: OS-tmp-shape check, scrubbed child env, boot-window cleanup), zip keepsakes — while the shared daemon stays human-managed. `make install` wires the MCP connector into local agents and auto-mints tokens. The approved v1 plan is [docs/plan.md](docs/plan.md). Read the plan before writing code; read [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md) before touching `server/`.

## Read order

1. [docs/plan.md](docs/plan.md) — scope, data model, milestones (source of truth)
2. [docs/architecture.md](docs/architecture.md) — process model, request flows, events
3. [docs/security.md](docs/security.md) — threat model and the invariants below
4. [docs/style-guide.md](docs/style-guide.md) — code conventions
5. [docs/decisions.md](docs/decisions.md) — why things are the way they are

Below this required reading sit the reference docs — [docs/api.md](docs/api.md) (the API inventory), [docs/anchors.md](docs/anchors.md), [docs/feedback-grammar.md](docs/feedback-grammar.md), [docs/deployment.md](docs/deployment.md) — same binding rule: a change to the API surface, anchors, feedback loop, or deployment updates its doc in the same change.

## Commands

All targets are live (`make list`/`export`/`import` arrived with M6; session `up`/`down`/`instances` with M8):

| Task | Command |
|---|---|
| One-command setup (new device) | `make setup` (or `./scripts/setup.sh`) — deps + web build + agent wiring; never starts the daemon (D21) |
| Install deps | `make deps` (wraps `bun install`) |
| Wire agents (MCP connector + skill + tokens) | `make install` (`--force` via `make install FLAGS=--force`) — wires the D22 stdio connector (`board mcp`) into opencode/claude |
| Test | `make test` (wraps `bun test`) |
| End-to-end smoke | `make smoke` (temp daemon + scratch ports, never `~/.board`) |
| Typecheck | `bunx tsc --noEmit` |
| Lint + format | `bunx biome check --write .` |
| Run daemon | `make serve` |
| Dev (hot reload) | `make dev` |
| Spawn a session board | `make up [FILE=<md>] [TITLE="…"] [FLAGS=…]` (or positional `make up plan.md`) |
| Tear down a session board | `make down [ID=s-xxxx] [FLAGS=…]` |
| List session boards | `make instances [FLAGS=--all|--prune]` |
| Mint agent token | `make token add <name>` (`--force` via `make token add <name> FLAGS=--force` re-mints a taken name, D17) |
| Build web app | `make web` |
| Open UI | `make open [board id]` |

Run typecheck, lint, and tests before finishing any change. If a command doesn't exist yet, you're early — don't invent behavior that contradicts the plan.

## Non-negotiable invariants

These exist for security reasons ([docs/security.md](docs/security.md)). Do not violate them, even temporarily, even in tests:

1. Bind loopback only (`127.0.0.1`) unless the user explicitly configures otherwise.
2. Agent HTML boards render in the host chrome with scripts running (D18, owner decision 2026-09-15). The host CSP is the guard: `connect-src 'self'` never opens, `form-action 'self'` stays. Never widen the host CSP beyond the allowlist in [docs/security.md](docs/security.md).
3. All writes go through the daemon API. Agents never write to `~/.board` directly.
4. Events are append-only. Never mutate or delete an event row.
5. Markdown published content passes through DOMPurify — no exceptions. html-format boards are exempt per D18; never add sanitization to them, or skip it for markdown, without the owner's say-so.
6. Asset ingest verifies magic bytes + mime allowlist + size cap; the `{path}` file-copy route must never be usable to read non-image files.
7. Never log or commit tokens; tokens are stored hashed. (The one sanctioned ephemeral exception is the D20 session-instance credential env file — mode 0600, purged at `board down`.)

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
