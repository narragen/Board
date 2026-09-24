# Shared Board — v1 Implementation Plan

A local-first, always-on shared board system: a Bun daemon hosting rich boards (markdown + interactive HTML) that agents publish via MCP/REST, you annotate with anchored comments, and everyone consumes via an append-only event log. Working name: **board** (repo is `/home/zr/geek/board`; rename anytime).

> **Approved 2026-09-15.** This document is the source of truth for v1 scope. The decision log is [decisions.md](decisions.md); the survey behind it is [research.md](research.md). Milestones get status markers appended as they complete.

## Locked decisions

| Decision | Choice |
|---|---|
| Stack | TypeScript + Bun; single daemon process, two origins |
| Agent feedback model | **Async only** — no blocking waits; agents poll cursors / tail events / SSE |
| Anchoring | **Phased**: v1 = sections + text highlights on markdown boards, `data-ba` section markers + board-level on HTML boards; full in-HTML bridge overlay deferred to v1.1 |
| Preloaded libs (pinned, vendored, no CDNs) | mermaid, tailwind (play-cdn script), plotly, katex |
| Base | Build from scratch; steal patterns from plannotator (feedback grammar, anchor model), easel (daemon, rounds, per-agent cursors), open-artifacts (immutable versions + `expected_version` 409), Claude Artifacts (thread lifecycle, CSP allowlist approach) |

## Architecture

```
~/.board/                          (BOARD_DATA_DIR, overridable)
  board.db                         SQLite (WAL) — boards, versions, comments, events, tokens, subscribers
  events.jsonl                     append-only GLOBAL event log (audit + integration substrate)
  boards/<id>/                     self-contained, zip-portable board bundle
    board.json                     metadata snapshot
    versions/NNN.html              immutable documents (+ NNN.md source when markdown input)
    assets/<id>.<ext>              images bundled with their board
    events.jsonl                   per-board event channel (mirrors this board's rows in board.db)

one process: boardd (Bun.serve, single port — D18)
  127.0.0.1:7800  host app (React+Vite SPA) | /api/* REST | /mcp (Streamable HTTP) | /api/stream SSE | /libs/* vendored libs
```

- **One origin** (D18, 2026-09-15): every board renders in the host chrome — the planned two-origin sandbox was built for M4, dogfooded one round, and removed by the owner's decision; the host CSP is the guard (`connect-src 'self'`, `form-action 'self'` — see [decisions.md](decisions.md) D18 and [security.md](security.md)). Port configurable (`BOARD_PORT`); default bind `127.0.0.1`, with a configurable bind list for Docker-hosted agents (see Deployment docs).
- **SQLite is the queryable source of truth; every board is also a self-contained bundle on disk** — `boards/<id>/` holds its versions, assets, metadata, and its own `events.jsonl`, so a board zips/moves/greps as one unit (export/import are built on this). The global `events.jsonl` remains the machine-wide audit log + tail/file-watch substrate (Claude `FileChanged`, opencode plugin events) requiring no client library.
- **Lifecycle via Makefile** — the primary operational interface: `make serve` (foreground daemon; tmux/systemd unit documented), `make open`, `make list`, `make token`, `make install`, `make test`, `make dev`. No auto-spawn magic (for the shared daemon — D20 later gave agents their own throwaway session instances).

## Data model (SQLite)

- **boards**: `id` (short nanoid), `title`, `format` (`markdown`|`html` — input convenience only; **every version is stored and served as an HTML document**), `status` (`open`|`ended`), `tags`, `created_by`, `created_at`, `current_version`
- **versions**: `board_id`, `n`, `label?`, `note?`, `content` (HTML document) + `source_md?` (original markdown when `format: markdown`), `anchors` (extracted at publish), `created_by`, `created_at` — **immutable**; publish with `expected_version` → **409** on conflict
- **comments**: `id`, `board_id`, `version_n`, `anchor`, `body`, `author` (human | agent name), `in_reply_to?`, `created_at`, `edited_at?`, `resolved_at?`, `resolved_by?` — `body` is required except for a ROOT comment whose anchor is `{type:"image"}` with ≥1 overlay item (the overlay IS the payload — overlay-only annotations post with an empty body; dogfooded fix)
  - `anchor` variants: `{type:"board"}` | `{type:"section", section_id}` | `{type:"text", section_id, originalText, startOffset, endOffset}` (plannotator's block+offset+quote model; re-anchor by `originalText` match) | `{type:"row", section_id, row_id}` | `{type:"image", asset_id, overlay?}`
- **events**: global monotonic `seq`, `ts`, `actor`, `type` (`board.created`, `board.published`, `board.ended`, `board.restored`, `comment.created`, `comment.replied`, `comment.resolved`, `asset.added`, `agent.subscribed`, `webhook.failed`…), `board_id?`, `payload` — queryable globally or per board (db + per-board jsonl mirror)
- **subscribers**: `board_id`, `agent`, `kind` (`sse` | `cursor` | `webhook`), `webhook_url?`, `secret?` (HMAC key), `last_seq`, `last_seen` — presence tracking + webhook registry
- **tokens**: agent name, SHA-256 hash, scopes, `created_at` — per-agent bearer tokens

## Boards: one document model (D18)

**Unified document model**: there is only one stored artifact — every version is an **HTML document**, rendered in the host chrome. `format` is an input convenience only:

- `format: markdown` — the daemon renders it at publish (`marked` GFM → **DOMPurify** → mermaid `securityLevel:'strict'` → katex → code highlighting) and **auto-injects `data-ba` ids onto every top-level block, heading, and table row** — sections and rows become annotatable with zero agent effort. Both markdown source and derived HTML are kept.
- `format: html` — the author's document, **unsanitized by owner decision (D18)**: at publish the daemon injects `data-ba` ids onto unlabeled top-level blocks and table rows (opt-in `data-ba="id"` + `data-ba-label` markers kept verbatim), stores the derived document, and the web app mounts it into the host DOM with head styles carried over and scripts re-created so they execute. Every board gets the full anchoring UX: hover affordances on sections/rows and text-selection comments.

**Image annotation** — images are **file-copy ingested** (on localhost, "upload" is really a local copy): human drag/drop in the UI, or agent `POST /assets` with a binary body **or** `{"path": "/abs/file.png"}` for the daemon to copy locally. Path ingest is safe by construction: magic-byte image verification + mime allowlist + size cap mean it cannot be repurposed to read arbitrary host files. Assets live inside the board bundle (`boards/<id>/assets/`), served at `/assets/<id>` from the host origin. **Note (D18):** imported assets/boards are foreign content — the import path (M6) must re-examine quarantine before shipping. Annotation overlay = JSON `{arrows:[{x1,y1,x2,y2}], boxes:[{x,y,text}]}` rendered as an SVG overlay; an overlay set is a comment anchored to `{type:"image", asset_id, overlay}` (timestamped, author-tagged, threaded). Schema documented so agents can annotate screenshots programmatically. Hand-rolled minimal editor (drag arrow, drag textbox) — no excalidraw dependency. **Docker-hosted agents** can't reach host loopback by default — documented options: run with `--network=host`, or `extra_hosts: ["host.docker.internal:host-gateway"]` with the daemon's configurable bind list, or volume-mount `~/.board` and tail `boards/<id>/events.jsonl` from inside the container.

## REST API (`:7800/api`, bearer auth)

- `POST /boards` · `GET /boards` (filters: status/tag/author; flags unresolved-comment counts + live subscriber count — both shipped: counts M3, subscribers M7) · `GET /boards/:id` · `GET /boards/:id/versions/:n`
- `POST /boards/:id/publish` (new version; `expected_version` → 409) · `POST /boards/:id/end` (writes → 409, reads stay) · `POST /boards/:id/restore` (publishes copy of an old version as a new one, noted)
- `GET /boards/:id/comments?since=<seq>` — **per-agent cursors** (`workspace:agent` scoped; resume returns exactly the unacked backlog)
- `POST /boards/:id/comments` · `POST /comments/:id/reply` · `POST /comments/:id/resolve`
- `GET /boards/:id/feedback?since=` — **feedback markdown grammar** (plannotator-style): numbered items with anchor type, section/row refs, quoted `originalText`, `> comment`, nested replies, resolve state, label summary — one artifact, human-readable *and* agent-parseable
- **Subscriptions, callbacks & presence**: `POST /boards/:id/subscribe` (`{webhook_url, webhook_secret?}` — `webhook_url` required, since webhook-less listening is auto-detected from SSE/cursor behavior; re-subscribing replaces the caller's webhook) · `GET /boards/:id/subscribers` (who is listening, how, `last_seq`/`last_seen`) · `DELETE /boards/:id/subscribe`. Webhook deliveries are HMAC-signed POSTs (3 retries, backoff); failures become `webhook.failed` events (dead-letter, visible in the audit view)
- `GET /events?since=` · `GET /boards/:id/events?since=` (per-board channel — also readable directly as `boards/<id>/events.jsonl`) · `GET /stream` (SSE, 25s heartbeats, reconnect via last seq)
- `POST /assets` (binary body or `{path}` file-copy; caps: board 8 MB, asset 10 MB; SVG sanitized at ingest)
- `GET /boards/:id/export` (zip of the self-contained bundle) · `POST /boards/import` (recreate a board from a bundle — the save/load-old-boards story)

## MCP server (Streamable HTTP, `:7800/mcp`, rev 2026-07-28, `@modelcontextprotocol/sdk`)

Tools: `board_create`, `board_publish`, `board_list`, `board_get`, `board_get_comments(since)`, `board_reply`, `board_resolve`, `board_restore`, `board_end`, `board_status`, `board_subscribe`, `board_upload_image`, `board_export` (v1, 13 tools — REST parity, D15: comments+cursor is the one consumption path). No wait/blocking tool (async-only). Optional: `board://<id>` resources (list/read) if time allows.

Async consumption loop (documented in skill): publish → `board_get_comments?since=cursor` on each iteration / on task boundaries; or tail `~/.board/events.jsonl`.

## Security implementation checklist

- Host CSP (D18 — the one guard for board script): `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'` — `connect-src 'self'` (exfil kill-switch) and `form-action 'self'` never open. *The former board-origin CSP and Permissions-Policy set was removed with the origin server by D18.*
- API middleware: Host-header allowlist (127.0.0.1/localhost only — DNS-rebinding defense), reject `Sec-Fetch-Site: cross-site` on unsafe methods, `application/json`-only writes, no CORS, no GET mutations
- Per-agent bearer tokens (hashed at rest); human browser session via one-time `?token=` exchange from `board open` (stored localStorage, sent as bearer)
- DOMPurify for markdown (invariant 5; html-format boards exempt per D18); mermaid strict; uploads mime-allowlisted + size-capped; SVG sanitized
- ~~PostMessage nonce-handshake bridge~~ — dropped by D18 (no iframe to bridge)

## Web UI (React + Vite, served by daemon)

1. **Board list** — status, author, unresolved-comment counts, **presence badges (which agents are subscribed/listening, and how — SSE / cursor / webhook)**, tags; create/open/end
2. **Board view** — rendered board + **comment sidebar**: select text → comment; hover section header → comment; comment a table row; general board comment; threaded replies; resolve; author badges (you vs. each agent) + timestamps; version switcher; restore-to-version
3. **Audit view** — filterable event log (all boards / per board), derived from the events table
4. **Image viewer** — overlay annotation editor (arrow + textbox) and display
5. Live updates via SSE. Ended boards render read-only.

## Documentation & skills (first-class deliverables)

- **`docs/`**: `README.md` (quickstart via make), `api.md` (REST + curl examples), `mcp.md`, `anchors.md` (`data-ba` conventions + anchor JSON schema), `feedback-grammar.md` (machine-parseable spec), `templates.md`, `security.md` (threat model, headers, token model), `deployment.md` (loopback, tmux/systemd, **Docker agents**, ngrok caveats)
- **Skills** — `skills/board/SKILL.md` in-repo; `make install` places per-agent copies (opencode, claude, `~/.agents/skills/`): board-creation patterns, template usage, `data-ba` convention, vendored-lib paths, the async consumption loop (cursor polling / `events.jsonl` tailing / webhook), and how to read the feedback grammar
- **`templates/`**: plan, decision-brief (MADR-shaped: context → drivers → options w/ per-option pros/cons → verdict field), explainer, progress report, HTML dashboard starter — markdown templates get auto-anchors; HTML templates carry `data-ba` markers
- **`.mcp.json`** at repo root

## Operations: Makefile + install

**Makefile is the primary interface**: `make serve` · `make open [ID]` · `make list` · `make token add|list|revoke AGENT` · `make install` · `make test` · `make dev` (daemon + web hot-reload) · `make export ID=` / `make import FILE=` · `make up [FILE=]` / `make down [ID=]` / `make instances` (session boards, D20) — thin wrappers over the `board` CLI; no auto-spawn magic for the shared daemon (session instances are agent-managed per D20).

`make install` writes, per agent:
- **opencode** (live on this machine): `mcp` entry in `~/.config/opencode/opencode.jsonc` + skill in `~/.config/opencode/skills/` + npm plugin stub (entry shape superseded by D22 — local stdio connector — and again by D24 — opencode v2 native `mcp.servers` shape, v1 dropped; see decisions.md)
- **claude code** (live): `claude mcp add --transport http board ...` (user scope) + skill in `~/.claude/skills/` (entry shape superseded by D22 — local stdio connector — and again by D24 — opencode v2 native `mcp.servers` shape, v1 dropped; see decisions.md)
- **codex / pi** (not installed here): emit `.mcp.json` + `~/.agents/skills/` placement (the cross-agent dir this machine already uses); instructions written, testing deferred until installed

## Milestones (each ends runnable + verified)

- **M1** Scaffold (Bun workspaces monorepo: `server/`, `web/`, `cli/`, `skill/`, `docs/`), daemon on two ports, SQLite + WAL, board-bundle layout, global + per-board events (dual-write), auth middleware (Host/Sec-Fetch/bearer), board + version CRUD with the unified HTML document model (markdown rendered at publish), 409 conflict, Makefile, `tsc --noEmit` + biome + `bun test` wired — **done 2026-09-15** (226 tests green; restore rejects on ended boards per spec; happy-dom↔DOMPurify compat patches logged as D11)
- **M2** Web shell: board list, markdown-derived boards rendered in host chrome (marked → DOMPurify → mermaid → katex, auto `data-ba`), version switcher, token exchange flow — **done 2026-09-15** (287 tests green; daemon serves the SPA with host CSP; mermaid renders client-side per D12; human sessions via one-time exchange + `make open`)
- **M3** Comments + anchoring (section, text-highlight, and table-row anchors; re-anchor by quote), sidebar w/ threads + resolve, SSE live updates, feedback-markdown serializer, per-agent comment cursors — **done 2026-09-15** (357 tests green; anchors validated server-side against the stored version; feedback grammar golden-tested; SSE with replay + heartbeats per D13; unresolved counts on the board list; live smoke: publish → comment → reply → resolve → cursor poll → feedback → SSE)
- **M4** HTML boards: `:7801` serving + security headers, sandboxed iframe embed, vendored/pinned mermaid+tailwind+plotly+katex, publish-time anchor extraction (`data-ba`), HTML dashboard template working end-to-end inside the sandbox — **status: complete 2026-09-15 under D18 (full host-render), owner-accepted same day**: the two-origin sandbox was built (waves A–B: origin serving, iframe embed, fragment aiming, section picker), dogfooded for one round, and **removed by the owner's decision the same day** (D18) in favor of full host-render — agent HTML mounts in the host chrome with scripts running, html publishes store id-injected derived documents (auto `data-ba` → full hover/selection anchoring on every board), `/libs/*` vendored pinned libs are served by the host (chart.js 4.4.9 verified in-browser during the spike), and the net code change of the pivot is −525 lines. Template at `skills/templates/dashboard.html`. Acceptance verified in-browser by the owner: chart renders, interactive form tallies, text-selection + section anchoring work on html boards (the script-mount ordering bug found during acceptance — head scripts dropped + inline racing the lib fetch — was fixed and regression-tested, `b8a0dd2`).
- **M5** MCP Streamable HTTP endpoint + all tools; SDK-client integration test; subscriptions/presence + webhook dispatcher (HMAC, retry, dead-letter); skill + templates + `.mcp.json` + `make install` for opencode + claude — **status: complete 2026-09-15**: `/mcp` live (stateless JSON-mode Streamable HTTP, D16) with the SDK-client integration tests; `make install` auto-mints per-agent tokens and wires opencode (comment-preserving JSONC merge) + claude (`claude mcp add`) + codex/pi snippets; skill shipped at `skills/board/`; webhooks shipped 2026-09-15 — `POST/DELETE /boards/:id/subscribe` + `GET /boards/:id/subscribers` REST, `board_subscribe` MCP tool, dispatcher with HMAC-signed deliveries, 3 attempts with exponential backoff, and `webhook.failed` dead-letter events.
- **M6** Assets + image annotation (file-copy ingest via binary or `{path}`, overlay editor + SVG render, image-anchored comments, agent-side overlay schema); bundle export/import — **status: complete 2026-09-15**: `POST /api/assets` (magic-byte + mime allowlist + caps, SVG sanitized at ingest, `{path}` route never echoes file content) + unauth loopback `GET /assets/:id` (nosniff, pinned content-type, immutable) + `![alt](asset:<id>)` markdown embeds; image-anchored comments `{type:"image", asset_id, overlay:{arrows:[{x1,y1,x2,y2}], boxes:[{x,y,text}]}}` (coords normalized 0..1) with a hand-rolled web overlay editor (drop-to-upload + annotate affordance, no new deps); `GET /boards/:id/export` self-contained zip + `POST /boards/import` with the D18 quarantine re-examination (markdown re-sanitized, html re-derived, assets re-verified with id remap, zip-slip defense, atomic validate-then-write, always-new board id); `board_upload_image` + `board_export` MCP tools (13 total); `make list` / `make export` / `make import` CLI surfaces.
- **M7** Audit view, restore UI, docs complete (api / anchors / feedback-grammar / security / deployment incl. Docker), hardening pass (caps, sanitize, headers audit), full smoke: two simulated agents + human comments → async feedback consumed via cursor and webhook — **status: complete 2026-09-16**: audit view live (`GET /api/events` with board/type/since/limit filters over the append-only log — dead-letters visible via `type=webhook.failed`; human-only `GET /api/sessions` + `DELETE /api/sessions/:id` — leak remediation, any live/exchange credential is revocable — + `GET /api/tokens` (names + lifecycle, never values); UI at `#/audit`: poll-when-visible event log with payload drill-down and dead-letter chips, sessions panel with arm/confirm revoke, tokens panel; `subscriber_count` on `GET /api/boards`); restore-to-version from the version switcher (arm/confirm, the 201 body lands the view on the new version deterministically, ended boards hide the affordance); docs complete — [docs/api.md](api.md) (26 REST routes + 13 MCP tools + 29 error codes, every claim code-verified), [docs/anchors.md](anchors.md), [docs/feedback-grammar.md](feedback-grammar.md), [docs/deployment.md](deployment.md) + Dockerfile (loopback-only publish form: `-p 127.0.0.1:7800:7800` or `--network host`, never bare `-p`; not build-verified — no docker in the dev env); hardening pass: all body reads enforce their caps DURING the stream (chunked/no-content-length bodies can no longer buffer past the cap — one shared `readCappedBody` under the JSON/MCP/asset/import readers); host CSP + nosniff + no-cache now stamped on `/api` + `/mcp` responses too (were statics/assets only); sessions expire 30 days after exchange (D19, enforced at auth time, migration v6 backfills); dead `sse` subscriber kind removed from the domain (D19 — presence stays cursor/webhook-only per D13); full smoke: `make smoke` (`scripts/smoke.ts`) — 15 asserted steps on a temp data dir + scratch ports: two agents + one human through create → publish → subscribe → anchored comment → cursor consumption → signed webhook deliveries (in order, HMAC verified) → reply → resolve → audit-trail assertion; 652 tests green. Preceded by a holistic review + consolidation wave (net −1,650 lines): store event-mirror discipline fixed (db-first everywhere, endBoard atomic), route/auth/MCP/store duplication consolidated, web test God-file split, `board status` CLI + shared table + `runDaemon`

- **M8** Agent-managed session instances (D20): `board up [file]` — background ephemeral daemon (OS-tmp data dir, kernel-assigned port, loopback + Host-allowlist pinned), agent token mint-before-spawn, optional first publish + one-time human exchange link; `board down` — end boards → export zip keepsakes → SIGTERM/SIGKILL → purge temp data + credential env file (dead-instance-safe, pid-identity verified, `--keep-data` / `--no-export`); `board instances` — registry view at `<BOARD_DATA_DIR>/instances/` + stale prune; `BOARD_INSTANCE` env / `--instance` across CLI commands; `make up/down/instances` wrappers; skill session loop; smoke extension — **status: complete 2026-09-16**: shipped per D20 — registry at `<BOARD_DATA_DIR>/instances/<id>/` (`instance.json` + mode-0600 credential `env` + `daemon.log` + `boards/` zip keepsakes, re-importable via `make import`); pid identity (`/proc` cmdline + environ `BOARD_DATA_DIR`) gates every teardown signal and every credential send (a foreign pid is refused with no workaround hint); credential precedence `--token` > `BOARD_TOKEN` > instance env file; `export --instance` works on closed instances (zips from the kept data dir); `up` self-heals stale registry entries (keepsakes first). Hardened by an adversarial audit (tests mutation-proven non-vacuous): structural OS-tmp-dir guard + id shape-check on every teardown/prune (a corrupt registry entry can redirect neither a signal nor a purge), child env scrubbed of all `BOARD_*` keys (a sourced prior-session token cannot reach the daemon's environ), boot-window SIGINT/SIGTERM cleanup with a `booting`-entry backstop for SIGKILLed boots, pre-signal identity re-verify (fail-closed on unreadable environ), loopback-only registry urls before any credential send, `down --instance`. Verification: 678-test suite green, smoke extended to 19 asserted steps (16–19 drive the session loop through the real CLI), live acceptance run.
- **M8.1** `board up --resume[=latest|all|<instance-id>]` — session-board continuity: reimport a prior session's keepsake zips into the fresh instance through the same import request `board import` builds (M6 quarantine semantics unchanged, always-new board ids — a resume is a fresh copy, so `--resume=<id>` is repeatable with fresh ids each time); bare flag ≡ `latest` (greatest `closedAt`, dir-mtime fallback); discovery scans the registry for `boards/*.zip` — the zips on disk are the truth, drifted `instance.json` stamps are ignored; a file argument publishes first (the primary), then resume imports, both before the summary; a failing keepsake is a per-board notice (`up` still exits 0 — a bad keepsake must not break a new session), an empty discovery is a one-line notice; `make up FLAGS="--resume=latest"` (no Makefile change — `FLAGS` rides the existing target) — **status: complete 2026-09-16** (owner green-light on the dogfood board; deployment doc "Resuming a prior session", resume test contracts 17–23).

**Post-plan (2026-09-22):** [decisions.md](decisions.md) D23 — post-plan operational doctrine, not new scope: agent-managed board-server lifecycle inside a single-container agent box (D1=A, scoping D21's human-management rule to the user's host machine), collaboration boards as days-long session instances with the recipe living in the Board skill (D2), the ratified persistent-`BOARD_DATA_DIR` convention (D3), published-port reachability with the Docker Desktop caveat (D5), and boards-are-vehicles-never-homes as a standing constraint (D6). Connector explicit targeting (D4) is ruled with a redirect — discovery tool + explicit connect by code/token + ask-when-ambiguous — **implemented**: `board_servers` discovery + `board_connect` explicit pin (loopback-guarded, validate-before-pin) + strict `BOARD_INSTANCE` in the connector, amending D22's resolution order (explicit beats auto; auto remains the zero-config single-agent default). See [deployment.md](deployment.md) ("Single-container agent box") and the Board skill.

**Verification per milestone**: `bun test` (unit: storage/anchors/serializer/auth; integration: REST + MCP via SDK client) + manual UI checklist. Final acceptance = the two-agent + human smoke run.

## Phase 2 backlog (explicitly deferred)

Word-level round diffs (easel-grade) · version-diff toggle between board versions (dogfooded ask; cheap interim: two tabs + the version switcher) · anchors surviving edits beyond quote re-match · comment edit + delete (dogfooded ask: edit own comments with `edited_at` + a `comment.edited` event; author soft-delete with `comment.deleted`, event log stays append-only) · native MCP `subscriptions/listen` push + Claude channels · CRDT co-editing (Yjs) · live agent-telemetry board regions (opencode/claude SSE as board content) · ngrok remote mode · vendored lib expansion (htmx, alpine, d3) · **Board roster surfacing (@-autocomplete + presence)** — a per-board principals aggregate (subscribers ∪ comment authors ∪ version creators — the data already exists: D15 subscriber presence rows + event actors), `@`-autocomplete in the web comment composer, and a small "who's here" presence panel. Rationale: the @mention convention ([feedback-grammar.md](feedback-grammar.md)) makes handles typeable; the roster makes them discoverable; the UI work is the only missing piece. Deferred until the UI need is real (D23 discussion, 2026-09-22).

*(The v1.1 in-iframe anchoring bridge and markdown applet-block items were dropped by D18 — host render makes both moot: agent HTML already runs in the app page with native anchoring.)*

## Out of scope

Cloud hosting, accounts, sharing portals · chat pane in the board (terminal stays chat) · code-review/PR viewers (plannotator's niche) · Electron/desktop packaging · kanban/task management · server-side execution of agent code · multi-human user management

## Risks / open items

- ~~Mermaid + plotly inside `sandbox="allow-scripts"` iframes~~ — retired by D18 (no iframes); chart.js verified in-browser during the M4 spike; other libs follow the same vendored-pin pattern
- Concurrent multi-agent writes: SQLite WAL + busy-retry; the daemon is the single writer (all writes go through the API — agents never write files directly)
- `{path}` file-copy ingest: magic-byte image verification + mime allowlist + size cap prevent repurposing it to read arbitrary host files
- Docker-agent networking: loopback unreachable from containers by default — deployment doc covers `--network=host`, `host.docker.internal` + bind list, and volume-mounted events tailing
- Codex/pi install paths written but unverifiable on this machine until installed
- Name/branding: `board` is a placeholder
