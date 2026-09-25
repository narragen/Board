# Deployment

Installing, running, and supervising the daemon — on the host, under systemd, and in Docker — plus the agent-managed session instances (D20) and the single-container agent box (D23). The daemon is a **local-first, loopback-only** service for one human and their agents; nothing in this document changes that (invariant 1, loopback bind — [security.md](security.md)). Since D21 the shared daemon is the **optional persistent library**: setup is one command and never requires it, session instances are the default agent loop, and "running" the daemon here means starting it on demand — or permanently, if you want the library always available. Operations live in the Makefile (D10); this doc is the reference behind `make --help`.

## Install

One command (D21 — the daemon is never started or required):

```
./scripts/setup.sh    # or: make setup
```

The bootstrap, end to end: a prerequisites check (bun on PATH — it prints the install one-liner and stops if missing; it never installs a toolchain for you), `make deps`, `make web` (a fresh clone has no `web/dist` — the UI 404s, `web_not_built`, without it), and `make install FLAGS=--force`. Re-runs are safe and **rotate agent tokens** — `--force` is what keeps exactly one live token per agent (the old credential is revoked, the fresh plaintext lands under the first free suffix, D17); a plain re-run would stack zombie tokens.

The steps `setup.sh` runs, for reference or piecemeal use:

```
make deps        # bun install (workspaces: server, cli, web)
make web         # build the SPA the daemon serves from web/dist (repeat after UI changes)
make install     # wire the board MCP server into local agents + mint their tokens
```

`make install` (→ `bun run cli/src/main.ts install`, flags via `make install FLAGS="--agents … --force"`):

- Probes `GET /api/health` first (a down daemon is a warning, not a failure — and since D22 wiring works regardless: the local connector lists the board tools offline, and its tool calls explain how to start a server when one is needed).
- Mints one agent token per target agent, named `board-<agent>`. The plaintext is **printed once** — it is stored SHA-256 and cannot be shown again (invariant 7, tokens stored hashed). Lost it? Re-mint.
- Wires **opencode**: comment-preserving merge of a `mcp.servers.board` entry into the existing `~/.config/opencode/opencode.{jsonc,json}`, plus the skills copied to `~/.config/opencode/skills/` (`board/` and `interview/` — D25). Since D22 the entry is a **local stdio command** — opencode spawns the connector, which resolves a real board server per request — not a remote URL. The shape is opencode v2's native one (D24):

  ```jsonc
  "mcp": { "servers": {
    "board": {
      "type": "local",
      "command": ["node", "<repo>/cli/src/mcp-connector.ts"],
      "disabled": false,
      "timeout": { "catalog": 60000, "execution": 60000 },
      "environment": { "BOARD_MCP_TOKEN": "<token>" }
    }
  } }
  ```

  Three details are load-bearing, all measured against opencode v2.0.16 (D24), not inferred:
  - **`timeout` must be the `{catalog, execution}` object.** A scalar makes v2 drop the whole server entry *silently* — the board tools would simply not appear, with no error anywhere.
  - **`disabled: false`, not `enabled: true`.** v1's `enabled` key is stripped on load, so writing it configures nothing.
  - **A legacy `mcp.board` entry is deleted** in the same edit. v2 merges both shapes and the native one wins a name collision, so leaving it behind is dead config that misleads the next reader.

  The target file is the one that already exists (`.jsonc` preferred when both do) — v2's own `opencode mcp add` writes `opencode.json`, and board no longer creates a second config file beside it.

  The repo root in the command is absolute, derived from the installer's own module location — not your shell's cwd — and bare `node` is deliberate: agent harness PATHs have node, not reliably bun.
- Wires **claude code**: stdio form via the CLI — `claude mcp add --scope user board --env BOARD_MCP_TOKEN=<token> -- node <repo>/cli/src/mcp-connector.ts` — plus both skills at `~/.claude/skills/` (`board/` and `interview/`).
- **codex / pi**: prints a command-form TOML snippet to paste (no automated wiring) and copies both skills to `~/.agents/skills/` (`board/` and `interview/`):

  ```toml
  [mcp_servers.board]
  command = "node"
  args = ["<repo>/cli/src/mcp-connector.ts"]
  env = { "BOARD_MCP_TOKEN" = "<board-<agent>-token>" }
  ```

- **The connector (D22)** — what all four wirings point at: a stdio MCP server (`board mcp` / `node cli/src/mcp-connector.ts`) that answers `initialize`/`ping` locally, lists the 15 tools from the shared manifest (13 proxied + the two D23-D4 connector-local discovery/connect tools), and resolves a real backend per request — the five-branch precedence in [architecture.md](architecture.md#connector-backend-resolution) "Connector backend resolution" (D22, amended by D23 D4), never cached. It never auto-spawns a daemon, so the wired `board_*` tools work against **any** running board server — session instances included.
- `--force` re-mints a taken token name — names are permanent (D17): the old token is revoked and the fresh one lands under the first free suffix (`board-<agent>`, `board-<agent>-2`, …).

Tokens by hand (any agent, or scripts): `make token add [name]` (`board token add [name] [--force]` — omit the name for a generated color-animal handle like `red-armadillo`, the handle agents are mentioned by, D23), `board token list`, `board token revoke <name>`. Minting is **CLI-only by design** — no API route ever creates or echoes a token.

## Run

The shared daemon on `127.0.0.1:7800` is the optional persistent library (D21): nothing auto-spawns it (D10), nothing requires it — agents run session instances ([below](#session-instances-agent-managed)) — and you start it when you want boards that outlive tasks, browsable and reusable across them, or the wired `board_*` MCP tools proxied to it (the D22 connector prefers it while it is healthy with its token).

| Command | What it does |
|---|---|
| `make serve` | foreground daemon: `bun run server/src/main.ts` — listens on `127.0.0.1:7800` |
| `make dev` | daemon (`bun --watch`) + vite dev server on `127.0.0.1:5173` (proxying `/api`, `/assets`, `/libs`); Ctrl-C takes both down |
| `bun run server/src/main.ts` | the daemon directly — `make serve` is exactly this |

- The daemon serves the **built** SPA from `web/dist`; without it, pages answer `404 web_not_built` (`make web`) while the API stays live. `make dev` bypasses the build with vite's dev server.
- One process, one port: the SPA, `/api/*` REST, `/mcp` (Streamable HTTP), `/api/stream` (SSE), `/assets/<id>`, and `/libs/*` vendored libraries ([architecture.md](architecture.md)).

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `BOARD_DATA_DIR` | `~/.board` | data directory (`~` expanded; relative paths resolve against cwd) |
| `BOARD_PORT` | `7800` | listen port (0–65535) |
| `BOARD_HOST` | `127.0.0.1` | **the** bind address. Loopback is invariant 1 (loopback bind); changing it is the explicit, documented opt-out (see Docker below) |
| `BOARD_BIND` | `127.0.0.1` | comma list of **additional Host-header names to accept** — it does NOT add bind addresses. Use it so clients whose `Host` header is not loopback (e.g. `host.docker.internal`) pass the DNS-rebinding allowlist |
| `BOARD_SSE_HEARTBEAT_MS` | `25000` | SSE heartbeat interval (a test knob; leave alone in production) |

These are the **daemon's** variables. Two CLI-level variables are deliberately absent — they configure the `board` CLI, never the daemon: `BOARD_INSTANCE` (target a session instance instead of the shared daemon, [below](#session-instances-agent-managed)) and `BOARD_TOKEN` (the REST credential for `list`/`status`/`export`/`import`).

## The data directory

```
~/.board/                     BOARD_DATA_DIR (overridable)
  board.db                    SQLite (WAL): boards, versions, comments, events, tokens, subscribers, sessions
  board.db-wal/-shm           WAL sidecar files (part of the db — back them up together)
  events.jsonl                global append-only event log
  boards/<id>/                self-contained board bundle
    board.json                metadata snapshot
    versions/NNN.html         immutable documents (+ NNN.md source for markdown input)
    assets/<id>.<ext>         images
    events.jsonl              per-board event channel
```

SQLite is the queryable source of truth; the bundle mirrors exist so a board is one portable, greppable unit. Agents never write here — **all writes flow through the daemon's API** (invariant 3, writes go through the daemon); the CLI's token/session commands are the human's sanctioned local exception.

**Backup story.** Two layers, use both:

- **Per board (portable):** `make export ID=<id>` — a self-contained zip (manifest, version sources, comments, assets, the board's events as an audit snapshot). `make import FILE=<id>.zip` recreates it — under a **new board id**, through the import quarantine ([security.md](security.md)). Export/import is the save/load-old-boards story, and works on ended boards.
- **Whole state (everything at once):** stop the daemon, copy the entire `BOARD_DATA_DIR` (db **with** its WAL sidecars, event logs, bundles), restart. A live copy of a WAL-mode SQLite file can be inconsistent — don't; a per-db `sqlite3 board.db ".backup '<dest>'"` is the in-place alternative for the db itself (bundles/logs still want the dir copy).

## Session instances (agent-managed)

D20 gives agents a task-scoped loop they own end to end: `board up` spawns a **throwaway loopback daemon** (an "instance"), the agent drives it over REST/CLI, `board down` tears it down with keepsakes. This is the one place an agent manages a daemon lifecycle — and since D21 it is the **default agent loop** (the shared daemon is the optional library). The shared `:7800` daemon and `~/.board` stay human-managed. Multiple instances may run concurrently; nothing about the shared daemon changes.

| Command | What it does |
|---|---|
| `board up [file] [--title T] [--format markdown\|html] [--tags a,b] [--agent NAME] [--resume[=latest\|all\|<instance-id>]] [--open]` | spawn a session instance; a file is published as v1 and a one-time human link printed (`--open` also xdg-opens it); `--resume` reimports a prior session's keepsake boards ([below](#resuming-a-prior-session-up---resume)) |
| `board down [<id>] [--instance <id>] [--keep-data] [--no-export]` | tear down: end open boards, keep zip keepsakes, stop the daemon, purge temp data + env file |
| `board instances [--all] [--prune]` | registry view — live by default, `--all` adds closed, `--prune` cleans stale entries |

Make wrappers (D10 pattern): `make up [FILE=<md>] [TITLE="…"] [FLAGS="…"]` (or positional `make up plan.md`), `make down [ID=s-xxxx] [FLAGS="…"]`, `make instances [FLAGS=--all|--prune]`. There are deliberately no per-flag vars (`TAGS=`, `AGENT=`, `OPEN=`) — they would collide with ambient environment variables; extra flags ride `FLAGS=`.

### What `up` prints and writes

- **Data dir:** always an OS-temp directory (`board-instance-*` under the system tmp), never under `~/.board`. **Port:** kernel-assigned (`BOARD_PORT=0`), so instances never collide with `:7800` or each other. **Bind + Host allowlist:** pinned to loopback over whatever `BOARD_HOST`/`BOARD_BIND` the invoking shell inherited (D20 boundary; invariant 1, loopback bind). **Child env:** scrubbed — every inherited `BOARD_*` key is stripped before the pins are applied, so a sourced previous-session env file cannot leak its live `BOARD_TOKEN` into the daemon's process environment.
- One agent token is minted **before** the daemon spawns (named by `--agent`, default `session`) and printed once — `instance.json` and `daemon.log` never see token material.
- A registry entry at `<BOARD_DATA_DIR>/instances/<id>/`:

```
~/.board/instances/s-<id>/   registry dir (the daemon's data dir is elsewhere, in OS temp)
  instance.json              id, pid, port, url, dataDir, agentTokenName, createdAt
                             (+ closedAt, boards at teardown) — never token plaintext
  env                        mode 0600: export BOARD_INSTANCE=<id> BOARD_PORT=<port>
                             BOARD_TOKEN=<token> — sourceable; purged at down
  daemon.log                 both daemon streams, for post-mortem
  boards/                    keepsake zips, written at teardown
```

- With a file argument, `up` creates and publishes the board over REST and prints a one-time human exchange link (`http://127.0.0.1:<port>/?token=<ex>#/boards/<id>`) — the same session-exchange model as `board open`. When `web/dist` is missing it warns (the link would 404 the UI until `make web`; the API half still works).
- `up` self-heals the registry: stale (dead-pid) entries are pruned first, keepsakes included; aged `boot-orphan` entries (an `up` killed mid-boot) are reaped the same way, young `booting` ones are left alone (another shell may still be starting one); corrupt entries — a `dataDir` outside the OS-temp `board-instance-*` shape — are reported, never acted on.

The printed output:

```
$ board up plan.md
instance s-AbCdEfGhIj listening on http://127.0.0.1:43211
agent token (print once — it is not recoverable): <token>
credentials env file (agent shells: source it): /home/you/.board/instances/s-AbCdEfGhIj/env
human link: http://127.0.0.1:43211/?token=<ex>#/boards/<board_id>
tear down with: board down s-AbCdEfGhIj
```

### The env-file workflow

Source the env file in the shell that owns the task, then drive the instance over REST:

```sh
source /home/you/.board/instances/s-AbCdEfGhIj/env
curl -s -H "authorization: Bearer $BOARD_TOKEN" -H 'content-type: application/json' \
  -d '{"format":"markdown","content":"…revised…","expected_version":1}' \
  "http://127.0.0.1:${BOARD_PORT}/api/boards/<board_id>/publish"
curl -s -H "authorization: Bearer $BOARD_TOKEN" \
  "http://127.0.0.1:${BOARD_PORT}/api/boards/<board_id>/comments?since=0"
```

The env file is the session-credential *delivery* artifact (D20) — mode 0600, the analogue of the human's localStorage bearer, never logged or committed, deleted by `down`/prune. Invariant 7 is untouched: every db stores only hashes.

### `down` semantics

- **Target resolution:** `--instance <id>` flag > id argument > `$BOARD_INSTANCE` > error listing the live ids.
- **Pid identity before any signal:** `/proc/<pid>/cmdline` must match the server entry and the readable environ must carry the instance's `BOARD_DATA_DIR` — re-verified immediately before the signal itself (the check reruns after the REST export phase, shrinking the pid-recycle race to microseconds), and an unreadable environ fails closed. A pid that is alive but is not this daemon is refused outright: never signalled, and never sent credentials.
- **Structural guard:** the entry's `dataDir` must be an OS-temp `board-instance-*` dir — a corrupt or crafted `instance.json` can falsify a pid, but not filesystem shape, so `down` refuses to signal or purge anything outside it (exit 1, nothing touched). Registry ids are shape-checked (`s-<10 alphanumerics>`) before any path use.
- **Alive:** open boards are ended over REST (already-ended 409s tolerated), each board is exported to `boards/<board_id>.zip`, then SIGTERM with an ≤8 s liveness poll, then SIGKILL. **Dead:** the same zips are built straight from the on-disk bundles (a dead single writer's WAL replays safely).
- The temp data dir is purged unless `--keep-data`; the env file is deleted **always** — the credential dies with the session even when the data is kept; `closedAt` + the kept board ids are stamped on `instance.json`. `down` on an already-closed instance is a no-op.
- **Interrupted boots:** SIGINT/SIGTERM during `up`'s boot window clean up everything (no daemon, no dirs, exit 130/143). A SIGKILLed `up` leaves a `booting` registry entry — recover with `board down <id>` (the entry already carries the pid + dataDir teardown needs).

### Closed and stale instances

- `board instances` derives liveness at read time from pid identity — never a stored status (statuses: `live`, `stale`, `booting` / `boot-orphan` — a boot entry older than the boot grace window, reapable with `down` or `--prune` — and `closed`). A stale entry is reported with a `--prune` hint.
- `list`, `open`, `export`, `import`, `status`, and `token add|list|revoke` accept `--instance <id>` (or `BOARD_INSTANCE`) and target that instance's daemon/db; REST against a closed/stale instance fails with a pointer to closed-instance export; `open` needs the live daemon (nothing serves the human link otherwise). A registry url whose host is not loopback is refused before any credential is sent — the same no-workaround-hint refusal as a foreign pid.
- `board export --instance <id> <board_id>` works on a **closed** instance: it zips the kept data dir's bundle to `./<board_id>.zip` — the same convention as a live export. If the data dir was purged, the error points at the `boards/` keepsake zips.
- Credential precedence for instance-targeted REST: `--token` > `BOARD_TOKEN` > the instance env file.

### Keepsakes

After `down`, the registry dir keeps `instance.json` (the audit record), `daemon.log`, and `boards/*.zip` — `make import`-compatible bundles, and the substrate `board up --resume` rehydrates ([below](#resuming-a-prior-session-up---resume)). In-flight webhook deliveries may be dropped at teardown; cursor polling (D15) is the reliable consumption path for sessions.

### Resuming a prior session (`up --resume`)

The keepsake zips are the session-continuity story (D20; owner green-light 2026-09-16 on the dogfood board): `board up --resume` reimports a prior session's boards into the fresh instance — "continue where I left off" without hand-running `make import` per zip.

- **Flag forms:** `--resume` (bare) ≡ `--resume=latest` — the most recent closed instance that has ≥1 keepsake zip. `--resume=all` — every prior instance's zips. `--resume=<instance-id>` — only that instance's zips. Via make: `make up FLAGS="--resume=latest"` — there is no dedicated make variable; `FLAGS` rides the existing `up` target exactly as `down`'s flags do. (Use the `=` form; bare `--resume` means latest anywhere among the flags.)
- **Discovery:** the registry is scanned for `instances/<id>/boards/*.zip` — **the zips on disk are the truth**; a drifted `boards` stamp in `instance.json` is ignored. "Most recent" = the greatest `closedAt` in `instance.json`, falling back to the registry dir's mtime when the stamp is absent. The instance being created is skipped, and live instances have no zips by construction (keepsakes are written at teardown).
- **Mechanics:** one `POST /api/boards/import` per zip against the NEW instance's daemon, authenticated with the freshly minted agent token — the same request `board import` builds, with import semantics unchanged (the M6 import quarantine re-runs).
- **New-id rule:** import always mints a NEW board id ([security.md](security.md) "Import quarantine"), so a resume is a fresh **copy**, never a moved board. Resumed ids never match the originals — do not expect id stability across resumes — and because the zips persist after `down`, `--resume=<id>` works repeatedly: each resume produces fresh copies with fresh ids.
- **Ordering:** with a file argument, the file board is published FIRST (it is the primary), then the resume imports; both finish before `up` prints its summary.
- **Output:** one line per resumed board — `resumed N board(s) from <instance-id>: <new-id> — "<title>"` (N counts the boards resumed from that instance) — plus a hint line per board, `hint: board open --instance <up-instance-id> <board-id>`, which is how the agent mints the human link for a resumed board.
- **Failure tolerance:** a zip that fails import (e.g. a 422 quarantine rejection on a corrupt keepsake) prints a notice per failure and the remaining zips still import; `up` still exits 0 — a bad keepsake must not break the new session it is resurrected into. With nothing discoverable, `up` prints `no previous session boards to resume` and continues normally (a `--resume=<unknown-id>` behaves the same, naming the id); only a malformed id value (`--resume=…` that is neither `latest`, `all`, nor `s-<10 alphanumerics>`) is a usage error before anything spawns.

**Boundaries (D20).** Loopback bind + Host allowlist are pinned at spawn and cannot be widened by inherited env (the child env is scrubbed of every `BOARD_*` key); instance data is always OS-temp, and teardown purges only dirs of that shape — signals go only to pid-verified processes, re-checked at signal time; the 0600 env file is the one sanctioned ephemeral credential-delivery artifact. The shared daemon and persistent `~/.board` remain human-managed.

## Supervised running (systemd, user unit)

The always-on **opt-in** (D21): for people who want the persistent library permanently available without a foreground process. `~/.config/systemd/user/board.service`:

```ini
[Unit]
Description=board daemon — loopback shared boards
After=network.target

[Service]
WorkingDirectory=%h/geek/board
ExecStart=%h/.bun/bin/bun %h/geek/board/server/src/main.ts
Environment=BOARD_DATA_DIR=%h/.board
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

```
systemctl --user daemon-reload
systemctl --user enable --now board
loginctl enable-linger $USER   # keep it running after logout (the point of this opt-in: the library is always there)
```

No `BOARD_HOST` override — the default loopback bind is the invariant doing its work. A tmux `make serve` is the informal alternative. This daemon has no auto-spawn magic (D10) — the shared daemon and the persistent data dir stay human-managed, and per D21 a down daemon does not block agents: they default to a session instance and ask you to start the library only when a task needs it (the skill's guidance).

## Docker

The image builds the SPA, runs the daemon as non-root, and keeps all state in a volume. The Dockerfile is multi-stage (deps → web build → prod deps → runtime), bases on `oven/bun`, and bakes **no token** — credentials are minted inside the running container (below).

```
docker build -t board .
```

### The loopback tension — read before you run

Invariant 1 binds `127.0.0.1` only. In a container, `127.0.0.1` is the **container's** loopback, so two supported run forms exist and nothing else:

- **Published port** — `docker run -e BOARD_HOST=0.0.0.0 -p 127.0.0.1:7800:7800 board`. Inside the container the daemon binds all interfaces (`BOARD_HOST=0.0.0.0` — necessary, or the docker proxy cannot reach it), but the **publish form is what holds the security line**: `-p 127.0.0.1:7800:7800` maps host loopback to container loopback-facing port, so only the host's own users reach the daemon. The Host-header allowlist and every other hardening layer still apply to each request.
- **`--network host`** — `docker run --network host board` (Linux). No network namespace: the container's `127.0.0.1` **is** the host's loopback, the default `BOARD_HOST=127.0.0.1` is correct as-is, and invariant 1 (loopback bind) holds literally.

**Never `-p 7800:7800`.** It publishes on every host interface and exposes the daemon to the network — the one misconfiguration this doc exists to prevent. The daemon is never to be exposed beyond the host; there is no remote mode (ngrok etc. are unshipped and would be re-examined before shipping, [security.md](security.md)).

Agents in *other* containers reaching the daemon over the docker network pass through the Host-header allowlist only if you add their hostname: `-e BOARD_BIND=host.docker.internal` (plus `extra_hosts: ["host.docker.internal:host-gateway"]` on their side). Alternatively, volume-mount the data dir into the agent container and tail `boards/<id>/events.jsonl` — no network at all.

### Data

`ENV BOARD_DATA_DIR=/data` and `VOLUME /data` are baked in; keep state on a volume or bind mount:

```
docker run -e BOARD_HOST=0.0.0.0 -p 127.0.0.1:7800:7800 -v board-data:/data board
```

Backups are unchanged: `make export` per board (against the published port), or stop the container and copy the volume.

### Tokens (minting inside the container)

No credential is baked into the image. Mint inside the running container — the exec inherits `BOARD_DATA_DIR=/data` and the `bun` user's write access:

```
docker exec board bun cli/src/main.ts token add [name]          # print-once plaintext; no name → generated handle
docker exec board bun cli/src/main.ts token list
docker exec board bun cli/src/main.ts token revoke <name>
```

(the `make token add [name]`-equivalent; names are permanent — `--force` re-mints under a suffixed name, D17). Point host-side agent configs at the published port with the minted token — `make install` itself is a host-side flow (it writes per-agent configs under the *executing* user's home, so run it on the host, not via exec).

### Health

The image's `HEALTHCHECK` polls `GET /api/health` (the daemon's one unauthenticated route, `{ok: true}`) every 30 s via `bun -e`; `docker inspect` / `docker ps` report it. The same endpoint is what `make install` probes and what agents should treat as the daemon-liveness signal (D14).

## Single-container agent box (human outside the container)

The executed D23 shape: the agent lives alone in its own container and the human browses from the host. Per D23 D1=A, the agent manages a board server *inside its own box* — D21's human-management rule governs a daemon on the user's host machine, not the agent's container. This is the documented published-port form ([above](#the-loopback-tension--read-before-you-run)) applied to the agent box itself; the reasoning is identical and the security line does not move (invariant 1, loopback bind — loopback-only on the host):

- **State on a persistent mount** — container env `BOARD_DATA_DIR=/home/node/board`, so daemon state survives box re-creation (the D23 D3 convention, ratified). Via the agentbox wrapper the mount rides the same passthrough as the published port: `agentbox run --docker-arg "--volume=board-data:/home/node/board"` — single token, no inner spaces, for the reason measured on `--publish` below. **The daemon now checks this at startup** and prints a warning to stderr when its data dir is on the container's own writable layer rather than a mount: a box that skipped the mount used to run perfectly and lose every board when it was re-created. The check is container-only (it never fires on a host), skips data dirs under the system temp dir, and distinguishes a mount from the root filesystem by comparing devices — see `ephemeralDataDirWarning` in `server/src/config.ts`.
- **Bind widened at serve time only** — the daemon starts with `BOARD_HOST=0.0.0.0` (the docker proxy cannot reach a loopback-bound listener), while every *client* — CLI, MCP connector, curl — stays pinned to `127.0.0.1`. Why the split is not optional: a box-wide `BOARD_HOST=0.0.0.0` makes clients send `Host: 0.0.0.0:7800`, and the Host-header allowlist (the DNS-rebinding defense) rejects that with 421.
- **Publish with the loopback prefix** — via the agentbox wrapper: `agentbox run --docker-arg "--publish=127.0.0.1:7800:7800"`. Single token, no inner spaces — the spaced form fails with `docker: invalid IP address` because docker's parser glues a leading space onto the IP.
- **The human browses the host's localhost forward** — `http://127.0.0.1:7800` on the host reaches the container daemon through the published loopback port; the one-time `?token=` exchange (`board open`) applies unchanged.

**Docker Desktop caveat (WSL2 backend):** `--network host` is *inert* there — the bind lands inside the Docker Desktop VM and never reaches Windows localhost. The published-port form is the working one on such hosts (on plain Linux, host networking remains as documented above).

Boundary today: only the fixed-port server is browsable this way. Session instances are structurally loopback + kernel-random port (D20 boundary, enforced in `cli/src/instances.ts` spawn env), so an agent-owned *instance* cannot serve the published fixed port — enabling that is a deliberate code change, open as D23 D4 follow-through.
