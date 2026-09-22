# board

A local-first **shared board** for humans and AI coding agents.

A localhost daemon hosts rich, interactive boards — plans, decision briefs, technical explainers, dashboards, progress reports. A board is either a task-scoped session an agent spins up for the job and tears down after (the default loop), or a persistent library on a daemon you keep running for boards that outlive tasks. Agents publish over MCP or REST; you comment and annotate in the browser, anchored to specific text, sections, table rows, and images; everyone stays in sync through an append-only event log.

## Why

Terminal agents are powerful, but the interface is a single scrolling transcript:

- **Decisions get buried.** While you're reading one thing, subagent output pushes it off-screen; the question that needed your answer is lost in the scroll.
- **Context evaporates.** Discussing item 4 of a 10-item table means scrolling back to the table; plans and findings vanish with the session.
- **Text-only limits.** The best explanations are visual — workflows as diagrams, options as tables, data as charts — and a TUI can't host them.

`board` gives that work a persistent, richer home: boards outlive sessions, feedback is anchored to what it's about, and multiple agents (opencode, claude code, codex, …) share the same surface as you — with attribution for who said what.

## The loop

```
 agents ──publish (MCP / REST)──▶ boardd ──host render (D18)──▶ you (browser)
    ▲                                                            │
    └── events / cursor polls / webhooks ◀── anchored comments ──┘
```

Boards render markdown (mermaid + katex) and agent-authored HTML+CSS+JS (chart.js preloaded and pinned, more vendored libs on the way) directly in the app — full host-render at the owner's decision (D18). Your comments anchor to text highlights, section headers, and table rows on **every** board; agents read them as structured, anchored feedback — never blocking, always attributable.

## Status

**M1–M8 complete — the system is shipped.** Agents publish boards over REST or MCP (13 tools, stateless Streamable HTTP on `:7800/mcp` — reached through the D22 local stdio connector, so the wired tools list always and work whenever a board server is up, shared daemon or session instance); every board — markdown and agent HTML — renders in the host chrome with full anchoring and, for agent HTML, running scripts (D18); you comment with threads, resolve, and live SSE; agents consume feedback via the comments cursor or HMAC-signed webhooks; assets ingest through verification (magic bytes + mime allowlist) and boards round-trip through export/import. M7 added the audit view (`#/audit` — the append-only event log with filters and dead-letters, session inventory with revoke, token inventory), restore-to-version from the version switcher, a hardening pass (stream-enforced body caps, host headers everywhere, 30-day session TTL), the full reference docs, and `make smoke` — the scripted two-agents+human acceptance loop. M8 added agent-managed session instances (D20): `board up`/`down`/`instances` run a task-scoped loopback daemon an agent owns end to end — the shared daemon stays human-managed. `make install` wires the MCP server into local agents and auto-mints tokens. The approved v1 plan lives in [docs/plan.md](docs/plan.md) (milestones M1–M8, all shipped).

## Documentation

| Document | Contents |
|---|---|
| [docs/plan.md](docs/plan.md) | Approved v1 plan: scope, data model, API/MCP surface, milestones |
| [docs/architecture.md](docs/architecture.md) | System design: process model, board bundles, request flows, events |
| [docs/security.md](docs/security.md) | Threat model, render trust model (D18), CSP, hard invariants |
| [docs/stack.md](docs/stack.md) | Technology choices and rationale |
| [docs/research.md](docs/research.md) | Survey of similar tools and what we borrow from each |
| [docs/decisions.md](docs/decisions.md) | Decision log (ADR-style) |
| [docs/style-guide.md](docs/style-guide.md) | Code style and conventions |
| [docs/api.md](docs/api.md) | The API inventory: REST routes, MCP tools, error codes |
| [docs/anchors.md](docs/anchors.md) | Anchor schema: `data-ba` ids, anchor variants, image overlays |
| [docs/feedback-grammar.md](docs/feedback-grammar.md) | Agent-side feedback loop: cursors, threads, webhooks, presence |
| [docs/deployment.md](docs/deployment.md) | Install, run, session instances (D20), systemd, data + backups, Docker (loopback rules) |

Agent instructions: [AGENTS.md](AGENTS.md).

## Planned layout

```
server/   the daemon — REST API, MCP endpoint, SSE, SQLite storage (:7800)
web/      host app (React + Vite): board list, board view, comment sidebar, audit view
cli/      `board` CLI — make targets wrap it
skills/   agent skill + board templates
docs/     this documentation
```

## Setup (new device)

One command from zero to "my agent opened a board." Linux is the supported platform — macOS is untested (session-instance teardown reads `/proc`, and the systemd unit, Docker form, and UI auto-open are Linux-shaped).

Prerequisites:

- Linux; optionally `xdg-open` (auto-opens the UI — the URL prints without it too).
- git, and [Bun](https://bun.sh) 1.4.x: `curl -fsSL https://bun.sh/install | bash` (no version pin in package.json — keep a current 1.4.x). Setup checks for bun and stops with the install one-liner if it is missing; it never installs a toolchain for you.
- For the wiring step, at least one harness: opencode and/or claude code (the `claude` CLI on PATH).

Then:

```
git clone git@github.com:ZachariahRosenberg/Board.git && cd Board
./scripts/setup.sh    # same as `make setup`
```

`setup.sh` does the whole bootstrap (D21): checks bun, builds dependencies (`make deps`), builds the SPA (`make web` — a fresh clone has no `web/dist`; without it the UI 404s, `web_not_built`), and wires your agents (`make install FLAGS=--force` — the board MCP server + skill into opencode / claude code, one live token per agent, plaintext printed once and stored hashed; save it now). **It never starts a server** — see the acceptance below. Re-runs are safe and rotate agent tokens (the previous ones are revoked, D17).

What the wiring step leans on: a down daemon during `make install` is a warning, not a failure — since D22 the wiring works regardless (agents spawn the local stdio connector, which lists the board tools offline and explains how to start a server in each tool call); claude code without its CLI on PATH gets manual instructions printed instead of automated wiring, and codex/pi always get a TOML snippet to paste.

**Acceptance — this is the point of the guide.** Restart your opencode/claude session (MCP config loads at startup; a running session keeps the old config), then say: *"spin up a board"* (or "put this on a board"). The agent starts a session board — `make up` (D20), a throwaway loopback daemon it owns end to end — publishes, and hands you a link. **No daemon required**; that is the point of the setup. A board opening with a link in your terminal or chat: setup is done. Want more confidence first? `make smoke` — the self-verifying 20-step end-to-end loop (two agents + a human, plus the MCP connector acceptance) on a temp daemon and scratch ports, never `~/.board`.

### Optional: the shared daemon (persistent library)

Nothing above starts or requires the shared daemon. Start it when you want a **persistent library** — boards that outlive tasks, browsable and reusable across them. The wired `board_*` MCP tools do **not** depend on it (D22): the local connector lists them always and works against whichever board server is up — a session instance or this daemon. To run the library:

```
make serve    # foreground daemon on 127.0.0.1:7800
make open     # mint a one-time exchange token and open the UI — if the board list loads, the stack works
```

For always-on, replace the foreground `make serve` with the systemd user unit + linger from [docs/deployment.md](docs/deployment.md). Session boards keep themselves as zip keepsakes when they end (`board down`), importable into the library with `make import`.

## Configuration

The knobs that matter on a new device; [docs/deployment.md](docs/deployment.md) is the full reference.

- **Data** lives in `~/.board` — the SQLite db, event logs, board bundles, and the session-instance registry (`instances/`). Relocate with `BOARD_DATA_DIR`. It is user data; agents never write there directly — all writes go through the daemon's API.
- **The shared daemon** (the optional persistent library) listens on `127.0.0.1:7800` (`BOARD_PORT` changes the port). The loopback bind is invariant 1, not a default — never expose the daemon beyond the host. `BOARD_HOST`/`BOARD_BIND` are the explicit, documented opt-outs for Docker agents; the publish-form / Host-allowlist rules in [docs/deployment.md](docs/deployment.md) are what hold the security line there.
- **Credentials**: tokens are stored hashed and their plaintext is printed once — it cannot be shown again. `make token add [name]` mints (no name → a generated color-animal handle, e.g. `red-armadillo` — the handle agents are mentioned by), `make token list` inventories, `make token revoke <name>` kills. Names are permanent (D17): `--force` (via `FLAGS=--force`) revokes the old token and re-mints under a suffixed name (`board-<agent>`, `board-<agent>-2`, …). Browser sessions expire after 30 days (D19) — `make open` again.
- **Session instances** (D20) are the default agent loop (D21): the registry at `~/.board/instances/<id>/` keeps `instance.json`, `daemon.log`, and a mode-0600 `env` file (`BOARD_INSTANCE`/`BOARD_PORT`/`BOARD_TOKEN` — the one sanctioned plaintext credential, purged at `board down`); teardown keeps zip keepsakes under `boards/`. Driven with `make up` / `make down` / `make instances`.

Full reference — the env-var table, systemd unit, tmux, Docker loopback rules, backups: [docs/deployment.md](docs/deployment.md).

## Day-to-day

```
make serve                 # the shared daemon (optional persistent library) on 127.0.0.1:7800
make web                   # rebuild the SPA after UI changes
make list                  # boards with status, version, unresolved counts
make export ID=<id>        # self-contained zip bundle of a board
make import FILE=<id>.zip  # recreate a board from a bundle (D18 quarantine re-runs)
make up plan.md            # agent-run session board (D20): throwaway daemon + one-time human link
make down ID=s-xxxx        # end a session board (boards kept as zip keepsakes)
make instances             # list session boards (--all closed, --prune stale)
make smoke                 # self-verifying end-to-end loop check (temp daemon, scratch ports)
```

Then, as an agent (or curl):

```
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Hello","format":"markdown"}' http://127.0.0.1:7800/api/boards
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"format":"markdown","content":"# Hi\n\nfirst board","expected_version":0}' \
  http://127.0.0.1:7800/api/boards/<id>/publish
```

Reference for agents and operators: [docs/api.md](docs/api.md) (every route, tool, error code), [docs/feedback-grammar.md](docs/feedback-grammar.md) (the consumption loop), [docs/anchors.md](docs/anchors.md), [docs/deployment.md](docs/deployment.md).

## Principles

1. **Local-first.** Single human, multiple named agents, one machine. No cloud, no accounts.
2. **Boards are bundles.** Every board is self-contained on disk — versions, assets, and its own event channel — zippable, greppable, portable.
3. **Interactive by default.** Agent HTML runs in the app's own origin (D18, owner decision) under a CSP that never opens network egress (`connect-src 'self'`) or form navigation. Security headers are never loosened for convenience.
4. **Async feedback.** Agents never block on humans; they poll per-agent cursors, tail the event log, or receive signed webhooks.
5. **One writer.** All state changes flow through the daemon's API; agents never write files directly.
