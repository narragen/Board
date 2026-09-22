# Decision log

ADR-style, oldest first. Entries are append-only: superseding a decision adds a new entry that references the old one; entries are never edited after acceptance.

## D1 — Build from scratch, not a fork — 2026-09-15

- **Context:** Evaluated plannotator, open-canvas, OpenDesign, open-artifacts as bases ([research.md](research.md)).
- **Decision:** Minimal greenfield build; steal patterns, not codebases.
- **Consequences:** No upstream baggage; we own the whole surface. We implement the annotation UX ourselves (the hardest part) and must keep scope honest.

## D2 — TypeScript + Bun, raw `Bun.serve`, no web framework — 2026-09-15

- **Context:** All reference implementations are TS; Bun is already on the machine; two small routers don't need a framework.
- **Decision:** Bun runtime, strict TS, flat router tables, `bun:sqlite` (WAL) storage, biome + `tsc --noEmit`, `bun test`.
- **Consequences:** Single-language codebase and possible single-binary distribution; validation/middleware are hand-rolled and tested.

## D3 — Async-only agent feedback — 2026-09-15

- **Context:** Agents could block on human review (plannotator's gate model) or continue asynchronously.
- **Decision (user):** Async only. Agents poll per-agent cursors, tail `events.jsonl`, or receive signed webhooks. No blocking wait tool exists.
- **Consequences:** Long-lived boards work; no `wait_for_comments`; agents must build a consumption habit — taught by the skill's polling loop.

## D4 — Phased anchoring — 2026-09-15

- **Context:** Full in-HTML anchoring (the bridge overlay) is the single hardest component.
- **Decision (user):** v1 = sections + text highlights + table rows on markdown-derived boards (host-chrome rendering) and `data-ba` section markers on HTML boards; v1.1 = bridge overlay for in-iframe anchoring.
- **Consequences:** Core value lands early; text comments inside HTML boards wait for v1.1; the anchor schema is designed bridge-compatible from day one.

## D5 — One document model (HTML), two display modes — 2026-09-15

- **Context:** Pure HTML-only-everything-in-iframe would drop v1 text-highlight anchoring; two *stored* types would split the pipeline.
- **Decision (user question):** Every version is one HTML document; `format` is input convenience. Markdown renders at publish with auto-injected anchors and displays in the host chrome (script-free by construction); authored HTML displays in the sandboxed iframe.
- **Consequences:** One storage/serving path and one anchor model; display logic branches on provenance; markdown boards can't embed live widgets until the phase-2 applet idea.

## D6 — SQLite source of truth + self-contained board bundles — 2026-09-15

- **Context:** Needs: concurrent agent writes, portability, greppability, audit.
- **Decision (user input):** SQLite (WAL) for state; per-board bundle dirs (`versions/`, `assets/`, `events.jsonl`, `board.json`) mirrored on disk; export/import = zip of a bundle; global `events.jsonl` for machine-wide tailing.
- **Consequences:** Slight dual-write cost; boards zip/move/grep as units; agents integrate with zero client library by tailing jsonl.

## D7 — Two-origin sandboxing — 2026-09-15

- **Context:** Agent-authored HTML must never touch trusted chrome.
- **Decision:** Host `:7800` / board origin `:7801`; `sandbox="allow-scripts"` only; strict CSPs ([security.md](security.md)).
- **Consequences:** Defense in depth against malicious boards; board↔host communication must go through a nonce-handshaked postMessage bridge (v1.1).

## D8 — Vendored, pinned sandbox libraries — 2026-09-15

- **Context:** Boards need common libraries without runtime CDNs.
- **Decision (user):** mermaid, tailwind (play-cdn script), plotly, katex — vendored, exact pins, served from the board origin.
- **Consequences:** Boards render identically offline, forever; library upgrades are deliberate events.

## D9 — MCP Streamable HTTP + REST parity; events as substrate — 2026-09-15

- **Context:** Multiple agent harnesses (opencode, claude code, codex, pi) need one integration path; CLI agents aren't listening services.
- **Decision:** One daemon serves REST + MCP (Streamable HTTP, rev 2026-07-28) + SSE; append-only events with a global `seq` are the audit log and universal subscription mechanism; webhooks are opt-in push with HMAC + retry + dead-letter.
- **Consequences:** Every harness integrates the same way; push is best-effort, cursor polling is the reliable baseline.

## D10 — Makefile as the operational interface — 2026-09-15

- **Context:** Daemon lifecycle could be auto-spawned magic or explicit commands.
- **Decision (user):** `make serve/open/list/token/install/test/dev/export/import` wrapping a thin `board` CLI; no auto-spawn.
- **Consequences:** Predictable, greppable ops; systemd/tmux documented but optional.

## D11 — Patched happy-dom for DOMPurify correctness — 2026-09-15

- **Context:** Server-side markdown sanitization (invariant 6) runs DOMPurify against a happy-dom window. Under the pinned versions (happy-dom 20.x, dompurify 3.4.x) two happy-dom bugs silently break sanitization: the base `Node.prototype.nodeName` getter returns `""` (every element classifies as tag `""` and gets stripped, hoisting script content into text), and `NodeIterator` stops after the first mid-walk removal (everything following a removed node escapes sanitization).
- **Decision:** Ship two minimal, why-commented compatibility patches in `server/src/render.ts` — a receiver-correct spec `nodeName` getter and a removal-robust pre-order `createNodeIterator` replacement installed on the exact document DOMPurify caches from — guarded by the golden-document render test and adversarial mXSS-shaped probes.
- **Consequences:** Sanitization is actually correct under Bun today; the patches are coupled to DOMPurify's caching internals, so any `bun update` of dompurify/happy-dom must re-run the render suite (the probes fail loudly if the patches stop applying). Revisit when either library fixes the underlying bugs.

## D12 — Mermaid renders client-side in the host chrome — 2026-09-15

- **Context:** docs/plan.md's publish pipeline lists mermaid in the server-side chain (marked → DOMPurify → mermaid → katex), but mermaid's renderer needs real layout measurement (SVG text metrics) and fights headless DOMs — and markdown boards display in the trusted host chrome anyway.
- **Decision:** The daemon's publish pipeline (marked → DOMPurify → data-ba injection → katex → shiki) leaves mermaid fences as `<pre class="mermaid">` source blocks in the stored document; the web app renders them client-side (npm mermaid, `securityLevel: "strict"`), degrading to source text on render failure.
- **Consequences:** No headless-mermaid hack on top of D11's patches; stored documents stay render-free at publish; web mermaid stays strict-mode pinned. HTML-format boards (M4) will use the vendored board-origin mermaid inside the sandbox instead.

## D13 — SSE auth via query param; client-held cursors — 2026-09-15

- **Context:** EventSource cannot set Authorization headers, and docs/plan.md's per-agent cursors were worded as a server-acked backlog ("resume returns exactly the unacknowledged").
- **Decision:** `GET /api/stream` accepts the agent/session token via the Authorization header (preferred) or `?token=` (the EventSource fallback — why-commented in the route; tokens never logged). Comment cursors stay CLIENT-held: `?since=` is exclusive on the comment's stamped creation-event seq — at-least-once, restart-safe; agent-token polls refresh a `subscribers` presence row (kind `cursor`) rather than acking.
- **Consequences:** Browser SSE works without cookies; presence (M5) can show "listening" agents derived from real cursor reads. A server-acked backlog remains a phase-2 option if agent crash-recovery proves to need it.

## D14 — Agent-managed daemon lifecycle — phase 2 — 2026-09-15

- **Context:** D10 made the Makefile the operational interface with no auto-spawn magic. The seamless workflow — an agent mid-task spins up boardd when it needs a human decision, shares a session link, and owns the daemon lifecycle — is the natural endgame for the dogfood loop.
- **Decision (user, 2026-09-15):** Defer to phase 2. For the MVP the human keeps the server running; the `board_status` tool and the skill detect a down daemon and instruct recovery (`make serve`). Full agent lifecycle management (spawn via tmux/nohup, link sharing, shutdown) gets its own decision later, with explicit safety boundaries.
- **Consequences:** M5-lite ships without lifecycle tools; the skill documents the manual path. The daemon-down case stays a first-class detectable state, not a mystery failure.

## D15 — One agent-facing consumption path: comments only — 2026-09-15

- **Context:** docs/plan.md exposed both `board_get_comments` (raw JSON, cursor-driven) and `board_get_feedback` (the rendered feedback grammar) as MCP tools — two overlapping ways to consume the same data.
- **Decision (user, 2026-09-15):** The MCP surface ships exactly one consumption path: `board_get_comments` with the `since` cursor — agents interpret the JSON themselves. The feedback grammar stays at the REST layer (`GET /boards/:id/feedback`) for humans, scripts, and reports.
- **Consequences:** The v1 MCP tool list is 10 tools; the serializer remains maintained and tested (it powers the REST endpoint and future digest tooling). Tool minimalism per the user's one-way preference.

## D16 — MCP over stateless JSON-mode Streamable HTTP — 2026-09-15

- **Context:** the MCP endpoint (`POST /mcp`) needed a transport on Bun — `Bun.serve` is web-standard while the SDK's classic `StreamableHTTPServerTransport` speaks Node `req`/`res`.
- **Decision:** use the SDK's `WebStandardStreamableHTTPServerTransport` (v1.30+) in stateless JSON mode — `sessionIdGenerator: undefined`, `enableJsonResponse: true`, a fresh `McpServer` + transport per POST. No sessions, no GET SSE stream on `/mcp` (non-POST → 405); agents receive feedback by polling comments (D15), so the daemon never holds a long-lived MCP connection.
- **Consequences:** one request = one JSON response; MCP requests get the same hardening as `/api` (Host allowlist, cross-site rejection, JSON-only bodies, 8 MB cap) and agent-only auth (human session tokens rejected). Had the web-standard transport not existed, the fallback was a hand-rolled Transport over the SDK protocol layer.

## D17 — Token names are permanent; `--force` mints suffixed — 2026-09-15

- **Context:** `board install --force` re-mints an agent's token, but `tokens.name` is the PRIMARY KEY — a revoked row holds its name forever.
- **Decision:** `--force` revokes the old token, then mints under the first free suffix (`board-<agent>`, `board-<agent>-2`, …). Revocation kills the old credential immediately; the suffix is the visible trace of the re-mint.
- **Consequences:** token names are not stable identifiers across re-mints — `token list` shows the suffix history. The alternative (deleting rows) would erase the audit trail of a token's lifecycle.

## D18 — Full host-render: agent HTML runs in the app origin — 2026-09-15

- **Context:** M4 built the two-origin sandbox end to end (origin server `:7801`, `sandbox="allow-scripts"` iframe embed, fragment aiming, a section picker for comment creation). After one dogfood round the owner rejected the trade: the picker was clunky, in-frame text anchoring would need a bridge, and the wall costs interactivity. Owner position: "I would prefer this be a highly useful, interactive, engaging tool and accept the risks of arbitrary HTML + JS running."
- **Decision (owner, 2026-09-15):** every board renders in the **host chrome**. Agent HTML (`format: html`) mounts into the app's DOM with scripts running — no iframe, no second origin. Markdown boards keep the DOMPurify pipeline; html-format boards are exempt from sanitization by this decision.
- **Accepted risks (named, eyes open):** board script shares the app's origin — it can read the session token from localStorage, act on the API as the human, and paint arbitrary UI over the app. Rationale: locally published boards come from the user's own agents, which already hold machine-level access (arbitrary bash) — the board is not the weakest link. **Foreign content (M6 import, remote/ngrok modes) must be re-examined before those paths ship.**
- **Guards that remain:** the host CSP — `connect-src 'self'` never opens (the network-exfiltration kill-switch), `form-action 'self'` (boards cannot form-navigate the app away), `frame-ancestors 'none'`, `script-src 'self' 'unsafe-inline'` (the accepted cost); loopback-only binding; the single-local-human model.
- **Consequences:** the board-origin server (`:7801`), `/b/:id/:n`, the origin `/libs` route, `board-bootstrap-1.js`, and `BOARD_ORIGIN_PORT` were removed (net −525 lines); `/libs/*` is served by the host; html publishes store an id-injected derived document (auto `data-ba` on unlabeled top-level blocks and table rows — full hover/selection anchoring on every board, no picker); previously stored versions are not retro-injected; the v1.1 postMessage bridge and markdown applet-block phase-2 items are obsolete and dropped.
- **Retrospective:** the sandbox was built, dogfooded for exactly one round, and removed the same day — the feedback loop doing what it exists to do.

## D19 — The `sse` presence kind is removed; sessions expire — 2026-09-16

- **Context (M7 hardening audit):** the plan's subscribers schema carries `kind` (`sse` | `cursor` | `webhook`), but nothing ever wrote an `sse` row — the docs wave flagged the kind as dead. Wiring it up for real has an architectural mismatch: presence rows are board-scoped (`subscribers` is keyed by `board_id` and listed per board) while `/api/stream` is a global channel with no board to stamp, and a truthful "listening right now" row needs connect/disconnect bookkeeping plus a crash-recovery sweep (lingering rows after a daemon restart would lie) — more machinery than the observation is worth when cursor polls already say "this agent is alive and reading."
- **Decision:** remove `sse` from the domain `SubscriberKind` and correct the docs that overstated SSE presence (architecture.md "Agents consume" / webhook delivery); D13's model — presence from cursor polls, SSE as best-effort delivery only — is unchanged and stays the truth. The v1 migration's CHECK constraint keeps the literal (migrations are immutable history); nothing writes it.
- **Same audit, same number (session lifetime):** live sessions had `expires_at` NULL — immortal credentials in localStorage, with no claim in security.md promising either way. Decision: sessions now expire **30 days** after exchange (`SESSION_TTL_MS`, stamped at exchange, enforced at auth time by the existing `verifySessionToken` check; migration v6 backfills pre-TTL rows). Revocation stays the leak remediation; expiry is the forgot-to-revoke backstop. Recovery is `board open`.
- **Consequences:** `GET /api/sessions` now always shows a real `expires_at` for live sessions; a 30-day-old tab re-runs `board open` once. No behavioral change to presence: it was already cursor/webhook-only in fact.

## D20 — Agent-managed session instances (`board up` / `board down`) — 2026-09-16

- **Context:** D14 deferred full agent lifecycle management to "its own decision later, with explicit safety boundaries." The friction it left is real: an agent mid-task that wants a human decision must detect a down daemon and stop to ask the human to run `make serve` (the skill's documented recovery path). The owner asked for the agent to own the whole loop: spin up, publish, share a link, iterate, close.
- **Decision (owner, 2026-09-16):** the `board` CLI grows session-instance lifecycle commands. `board up [file]` spawns a **background ephemeral daemon** — OS-tmp data dir, kernel-assigned port (`BOARD_PORT=0`), loopback bind and Host-allowlist pinned regardless of inherited env — mints one agent token before spawn, optionally publishes a first board and prints a one-time human exchange link. `board down` ends open boards, exports each as a zip keepsake, stops the process, and purges the temp data dir and credential env file. A registry at `<BOARD_DATA_DIR>/instances/<id>/` (`instance.json` — never tokens — plus `daemon.log`, `env`, `boards/`) is the discovery substrate for `board instances`.
- **Safety boundaries (explicit, per D14's promise):**
  - The **shared daemon and persistent `~/.board` data stay human-managed** — D10's no-auto-spawn rationale is untouched for persistent state; only throwaway instances are agent-owned. Session data dirs are always OS-tmp, never under `~/.board`.
  - Loopback bind + Host-header allowlist are pinned on spawn: an inherited `BOARD_HOST=0.0.0.0` or widened `BOARD_BIND` cannot widen a session instance.
  - Auth unchanged: bearer agent token (hashed in the instance db, plaintext printed once by `up`); human access only via the one-time exchange link.
  - **Credential env file:** `up` writes `<instances>/<id>/env` (mode 0600: `BOARD_INSTANCE`, `BOARD_PORT`, `BOARD_TOKEN`) so agent shells can `source` it; it is deleted on `down`/prune. This is a session-credential *delivery* artifact (the human's localStorage bearer is the analogue), not a token store — invariant 7 (hashed at rest) still governs every db. Named risk, owner-accepted: a plaintext credential briefly at rest in the user's own data dir, ephemeral lifetime, never logged or committed.
  - **Teardown signals only verified pids:** `/proc/<pid>/cmdline` match (plus an environ `BOARD_DATA_DIR` match when readable) before any signal — a recycled pid is never killed. A dead instance still yields keepsake zips from its on-disk bundles, then cleans up.
  - MCP wiring is static (it points at the shared daemon's fixed port), so the session loop rides REST/CLI with the instance token; the skill teaches it. No new REST routes.
- **Consequences:** `make up/down/instances` wrappers follow (D10 pattern); the skill gains the session loop (up → source env → REST publish/poll → down); `board up` self-heals by pruning stale registry entries; `down` keeps `boards/*.zip`, `instance.json`, and `daemon.log` as the audit keepsake (re-importable via `make import`). In-flight webhook deliveries may be dropped at teardown — cursor polling (D15) stays the reliable consumption path for sessions.

## D21 — The shared daemon is optional; setup is one command — 2026-09-17

- **Context:** M8/D20 gave agents task-scoped instances they own — but setup and the docs still treated the shared `:7800` daemon as a required always-on service: every guide ended at `make serve`, and a fresh user had to babysit a foreground process before a single board existed. The owner asked for seamlessness: clone, one setup command, open an agent session, get a board.
- **Decision (owner, 2026-09-17):** setup no longer starts, requires, or mentions-as-mandatory the shared daemon. `scripts/setup.sh` (also `make setup`) is the one-command bootstrap — prerequisites check (bun), `make deps`, `make web`, `make install FLAGS=--force` (wiring + exactly one live token per agent on re-runs) — and the acceptance is an agent session spawning a session board (`make up`) with **no daemon running**. The shared daemon is reframed as the **optional persistent library**: started on demand (`make serve` or the systemd unit) to browse old/cross-task boards and to serve the wired MCP tools.
- **Consequences:** README/deployment reframe (daemon = optional library, never a setup prerequisite); the skill's daemon-down guidance flips — default to a session instance, ask the human to start the shared daemon only when the task needs the persistent library; no security boundary changes (loopback, auth, D20 teardown, everything unchanged); `make install` still wires MCP at `:7800` so the tools light up whenever the daemon IS up.

## D22 — MCP wiring ships a local stdio connector (`board mcp`) — 2026-09-17

- **Context:** D21's closing consequence — "`make install` still wires MCP at `:7800` so the tools light up whenever the daemon IS up" — was false in practice. The installer wired opencode as a `remote` MCP entry pointing at `http://127.0.0.1:7800/mcp`, but post-D21 the shared daemon is optional and usually down, and opencode never retries a failed remote MCP: the entry sat permanently "failed" in the default daemon-down state, and the wired tools could not light up against a running session instance (D20) either. Owner direction (2026-09-17): MCP should be available whenever an agent actually has a board server up — agent-spun session instances included — with no human `make serve` requirement.
- **Decision (owner, 2026-09-17):** the shipped MCP wiring is a **local stdio connector** — `board mcp`, also runnable as `node cli/src/mcp-connector.ts` (agent harness PATHs have node, not reliably bun, so the connector's import graph is node-runnable under type-stripping). It answers `initialize`/`ping` locally, lists the 13 tools offline from the single-source manifest (`server/src/mcp-tools.ts`), and re-resolves a real backend **per request**: the shared daemon when healthy with a `BOARD_MCP_TOKEN` env present, else the newest healthy session instance from the D20 registry (`<BOARD_DATA_DIR>/instances/` — loopback-only structural guard, credential from the 0600 env file), else an actionable `isError` tool result pointing at `make up` / `make serve`. **No auto-spawn ever** — the connector never starts a daemon (D10/D20 untouched); it only reads env/registry and proxies HTTP to loopback backends.
- **Consequences:** amends D20's "MCP wiring is static … the session loop rides REST/CLI" — session instances are now reachable through MCP via the connector, though REST/CLI remain canonical for task-critical multi-instance work (the skill still teaches the env-file loop). D21's consequence is now actually true: the tools always list, and calls work whenever any board server is up. Documented ambiguity: with multiple concurrent session instances the connector routes newest-first (greatest `createdAt`) — a task's MCP-routed boards land on the newest instance's registry, and that instance's keepsake zips, human link, and `board down` are the ones that own them (a `board down` by the other task ends them); the connector now emits a one-line stderr diagnostic per proxied call naming the resolved backend (`board connector: backend <url> (shared)` / `(instance <id>)`) so a wrong-instance route is visible in the harness's MCP log instead of failing silently. The shared token now rides the agent config's `environment` (plaintext env var) instead of an Authorization header — the same exposure class as D17's plaintext-in-agent-config, accepted for the same reason. The installer wires opencode (local stdio entry) and claude (`claude mcp add` stdio form) to the connector; codex/pi print command-form TOML snippets. The `/mcp` endpoint itself is unchanged (D16).

## D23 — Collaboration boards: lifecycle, durability, targeting — 2026-09-22

- **Context:** post-M8 dogfooding changed the deployment assumption: the agent now lives alone in a bridge-networked container (`agentbox`), so the human's browser cannot reach the container's `127.0.0.1`, an environment reset deleted the daemon's whole data dir mid-week, and D22's shared-then-newest connector rule becomes a routing race the moment two agents run boards concurrently — exactly the emerging second use shape (several agents + the human exchanging on one longer-lived board). Full analysis and an appended decision record: the D23 brief at the dogfood board (nDAf0mn0ob, v5).
- **Decision (owner, 2026-09-22 — chat + on-board, all threads resolved):**
  - **D1 — ruled A: the agent manages the board server's full lifecycle; the human only browses.** Interpretation: D21's "the shared daemon is human-managed" rule applies to a daemon on the *user's host machine* — a standing service outliving agent sandboxes. Inside the agent's own container the agent owns the lifecycle: it starts the fixed-port server at recovery, self-heals it across sessions; the server dies with the box, data persists on a mount. Recorded consequence: the in-box `:7800` server is agent-started with `BOARD_HOST=0.0.0.0` **at serve time only** — clients stay pinned to `127.0.0.1`, because a box-wide `BOARD_HOST=0.0.0.0` makes CLI/MCP clients send `Host: 0.0.0.0:7800`, which the Host-header allowlist (the DNS-rebinding defense) rejects with 421.
  - **D2 — ratified with a containment constraint:** a collaboration board is a session instance (D20) whose task runs for days, not minutes — no forked machinery, no new daemon type. And: board-domain operational knowledge (the collaboration recipe, board-lifecycle runbook knowledge) lives *in the Board skill* — skill + repo docs + the `board` CLI/MCP connector are one portable unit, so Board wires into a new agent/harness as a single copy. Host-specific facts (container runtime quirks) stay in host-side handoffs, which point at the skill.
  - **D3 — ratified (on-board 2026-09-22; pre-agreed in chat, de-facto executed on this box first):** collaboration instances run `BOARD_DATA_DIR` on a persistent volume + milestone zip keepsakes, so a days-long board's exchange record survives environment resets and stays resurrectable via import.
  - **D4 — ruled with a redirect (on-board 2026-09-22):** explicit targeting approved, and the owner redirected the shape — agents get **a discovery tool** (list the local servers actually up — shared daemon + live instances — and the boards on each), **explicit connect** to an existing server/board with a manager-minted code/token, and **ask-the-human when new-board-vs-connect-existing is ambiguous — never silently pick** ("let's not try to be too clever, let's just be explicit"). `BOARD_INSTANCE` env remains the scripted/no-dialog path; D22's zero-config single-agent default is untouched — the redirect governs multi-agent collaboration, replacing silent newest-healthy routing there. Not implemented in this change (docs/skill only); it is the next PR after the D22 connector merges.
  - **D5 — executed, agreed on-board with a mechanism correction:** the brief recommended `--network host`, but this host's engine is Docker Desktop (WSL2 backend), where host networking binds inside the DD VM and never reaches Windows localhost — inert. The executed form is the documented published-port equivalent ([deployment.md](deployment.md) "Docker"): container env `BOARD_DATA_DIR=/home/node/board` (persistent mount), daemon bind widened at serve only, port published as `--publish=127.0.0.1:7800:7800` — agentbox wrapper syntax `agentbox run --docker-arg "--publish=127.0.0.1:7800:7800"`, single token, no inner spaces: the spaced form fails with `docker: invalid IP address` because docker's parser glues a leading space onto the IP. Same guarantees as the documented form: loopback-only exposure on the host, durable state, the human browses via the host's localhost forward. Also recorded: session instances are structurally loopback + kernel-random port (D20 boundary, enforced in `cli/src/instances.ts` spawn env), so an agent-owned *instance* cannot serve the published fixed port today — a deliberate code change, candidate follow-through alongside D4.
  - **D6 — accepted, strengthened:** boards are vehicles, never homes — no sync, no cloud, no persistence roadmap beyond zip export. Strengthening: the constraint goes into the Board skill itself, instructing agents explicitly that durable items (decisions made, plans approved, takeaways) are saved off-board (repo/docs) before a review cycle closes.
- **Consequences:** [deployment.md](deployment.md) gains the single-container section (the executed D5 shape, referencing the existing two-forms section — invariant 1 stands: loopback-only on the host, nothing widened); the Board skill gains the collaboration recipe (D2), the vehicles-never-homes instruction (D6), and the agent-managed in-box server runbook (D1=A) as its portable board-domain knowledge; [plan.md](plan.md) notes D23 as post-plan doctrine. All six rulings are in — D4 ships no code in this change (docs/skill only); its redirected implementation (discovery + explicit connect + ask-when-ambiguous) is the follow-through PR, with the option-A live demo after it.
