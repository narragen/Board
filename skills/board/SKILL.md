---
name: board
description: Publish plans and results to the shared board for async human review, then consume the anchored feedback that comes back. Use when the user asks to publish or put something "on the board", wants human review of a plan or result, mentions board feedback or the board daemon, or when board_* MCP tools are available.
---

# board — async human review

## What boards are

- Shared review artifacts hosted by a board daemon — a task-scoped session instance you spawn yourself (the default, D21) or the shared daemon on `127.0.0.1:7800` (the persistent library; both covered below): you publish markdown, the human reads it in a browser and annotates it with anchored comments, you consume the feedback and respond.
- The loop is asynchronous. Publish and move on — **never block waiting on the human**. Check for feedback between task steps, not constantly.
- Boards are append-only and versioned. Every publish is a new immutable version; history is never rewritten (only `board_restore` rolls a board back).

## When to board

Board when all three hold — otherwise stay in chat:

- A **human decision or approval point** exists (sign-off, tradeoff pick, go/no-go).
- **Async review is the right cadence**: the human reacts when they react, and the work never blocks on them (D3 — no blocking wait exists).
- There is an **artifact worth anchoring comments onto**: a plan, results digest, research brief, audit findings, design options.

Do NOT board quick factual questions, code review that belongs in diff/PR tooling, or anything needing live back-and-forth — the terminal stays chat.

## The loop

1. **Create**: `board_create` (title, format, tags) — a new board starts at v0, empty.
2. **Publish**: `board_publish` (board id, content, `expected_version`) — see conflicts below.
3. **Tell the human**: say the board is ready and how to open it — `board open <id>` from the CLI, or `make open <id>` in the repo. Do not open a browser yourself.
4. **Poll**: run the capped poller (below) between task steps.
5. **Reply**: for each new comment, `board_reply` (comment id, body) in that comment's thread — answer questions, say what you changed.
6. **Resolve**: `board_resolve` (comment id) ONLY when the thread is actually addressed. Never resolve to make noise go away — an unresolved comment is the human's signal that work remains.
7. **End**: when the work is done and threads are settled, `board_end` (board id) closes the loop.

## Vehicles, never homes

A board is the review vehicle, never the archive (D6 — no sync, no cloud, no persistence beyond zip export). **Before a review cycle closes, save the durable outcomes off-board into the repo/docs**: decisions made → the decision log, approved plans → the plan doc, takeaways → wherever the project keeps truth. If ending the board would destroy the only copy of a decision, the loop is not finished — the board is where a decision gets *made*, not where it *lives*.

## Shared daemon or session instance?

Pick by lifetime, not preference — the session instance is the default (D21):

- **Session instance** (D20) — **the default**: a **task-scoped loopback daemon you own end to end**: `board up` spawns it (OS-temp data dir, random port, one agent token), `board down` tears it down with zip keepsakes. No shared server needed — a task gets its own human review loop that should not outlive it.
- **Shared daemon** (`127.0.0.1:7800`) — the **optional persistent library** (D21) for **cross-task boards** that outlive a session: browsing or reusing old boards. The human owns its lifecycle; you never start or stop it. The MCP wiring is the local connector (D22): the `board_*` tools are always listed, and a call lands on this daemon while it runs (it is preferred when healthy with the wired token); a session is still driven via the CLI and REST.

## Collaborating on a shared board

Several agents can share one board. Attribution is the token name — every comment, reply, and resolve is stamped with the bearer token's name.

- **Per-agent tokens**: each agent mints its own — `make token add <name>` on the shared daemon, `board token add <name> --instance <id>` on a session instance — so its entries read as that agent.
- **Per-agent cursors**: the `since` cursor is client-held state (D15); each agent persists its own per board. Sharing one cursor means missing each other's threads.
- **Push**: `board_subscribe` (webhook_url, webhook_secret?) delivers signed events to an agent that can receive one, instead of polling.
- **Presence**: every agent-token cursor poll refreshes a `cursor` subscriber row; `GET /api/boards/:id/subscribers` lists who is reading.

On a **session instance** the `up`-printed env file carries one token: sourcing it in every agent's shell means shared credentials and one shared name on every entry; minting per-agent tokens (`board token add <name> --instance <id>`) keeps attribution distinct. Pick deliberately.

## The session loop

```sh
board up plan.md    # spawn + publish v1; prints the agent token (once),
                    # a credentials env file, and a one-time human link
```

1. **Give the human the printed link** (`http://127.0.0.1:<port>/?token=…#/boards/<board_id>`) — it is one-time; they comment in the browser as usual.
2. **Source the env file** the output names: `source <path>` — sets `BOARD_INSTANCE`, `BOARD_PORT`, `BOARD_TOKEN` for your shell.
3. **Iterate over REST** with those credentials — publish versions and poll the comments cursor exactly like the MCP loop (the consumption rule and poller below apply unchanged):

```sh
curl -s -H "authorization: Bearer $BOARD_TOKEN" -H 'content-type: application/json' \
  -d '{"format":"markdown","content":"…revised…","expected_version":1}' \
  "http://127.0.0.1:${BOARD_PORT}/api/boards/<board_id>/publish"
curl -s -H "authorization: Bearer $BOARD_TOKEN" \
  "http://127.0.0.1:${BOARD_PORT}/api/boards/<board_id>/comments?since=0"
```

4. **Tear down**: `board down` (resolves `$BOARD_INSTANCE`; an explicit id works too). It ends open boards, keeps each board as a zip under the instance registry, stops the daemon, and purges the temp data dir and the env file — token included. Keepsake zips re-import with `make import`; a dead instance still yields its keepsakes. Several instances can run concurrently — `board instances` lists them.

Keep sessions task-scoped: when the review is done, `board down` — do not leave daemons behind.

## Collaboration boards (a session that runs for days)

A collaboration board is a session instance whose task runs for days, not minutes (D23 D2) — the same machinery on a longer leash, nothing new to spawn. On top of the session loop:

- **Per-agent tokens for attribution** — each agent mints its own (`board token add <name> --instance <id>`) so every comment, reply, and resolve reads as its author.
- **Per-agent comment cursors** — the `since` cursor is client-held (D15); each consumer persists its own per board. Sharing one cursor means missing each other's threads.
- **Presence via polls, push as the alternative** — every cursor poll refreshes the agent's `subscriber` row (`GET /api/boards/:id/subscribers` lists who is reading); `board_subscribe` replaces polling for an agent that can receive a webhook.
- **Durability (D3 — ratified 2026-09-22)** — spawn with `BOARD_DATA_DIR` on a persistent volume: the instance registry and its keepsake zips then survive environment resets (the daemon's own data dir stays OS-temp per D20). Export milestone keepsakes mid-flight (`board export --instance <id> <board_id>`), not only at `down`; recovery is import from the keepsakes (`make import`, or `board up --resume=latest`).
- **MANDATORY — takeaways land at \<repo path\>** (D6): every collaboration loop carries an explicit line naming where its durable outcomes go, and writes them there before the cycle closes. The board stays served only as long as the exchange needs it; the record lives off-board.

## Tool reference

| Tool | Does | Key inputs |
|---|---|---|
| `board_create` | opens a new board (v0, empty) | title, format, tags |
| `board_publish` | pushes content as a new immutable version | board_id, content, expected_version |
| `board_list` | lists boards with unresolved-comment counts | — |
| `board_get` | board + current version metadata | board_id |
| `board_get_comments` | **the** feedback path: comments + `last_seq` cursor | board_id, since |
| `board_reply` | answers in a comment's thread | comment_id, body |
| `board_resolve` | marks a thread addressed | comment_id |
| `board_restore` | rolls the board back to a prior version | board_id, version |
| `board_end` | closes the board's review loop | board_id |
| `board_status` | daemon liveness + counts | — |
| `board_subscribe` | registers a webhook for signed event push | board_id, webhook_url, webhook_secret? |
| `board_upload_image` | copies a local image into a board, verified + sanitized | board_id, path (absolute, on the daemon host) |
| `board_export` | exports a board as a self-contained zip bundle, base64-encoded | board_id |

## Images

To put a screenshot or diagram on a board, call `board_upload_image` with the image's **absolute path on this host** (the daemon copies and verifies it — png, jpeg, gif, webp, or svg, 10 MB per image / 8 MB per board). The result carries `asset_id` plus ready-to-paste embed snippets:

- markdown boards: `![image](asset:<id>)` — write this in your next `board_publish`
- html boards: `<img src="/assets/<id>">` — reference the URL directly

Never invent asset ids or reference `/assets/<id>` URLs you did not get from the tool — unknown ids render as broken images.

### Annotating an image (overlay schema)

Comments can anchor to an image and carry an **overlay** — arrows and positioned text labels the web UI draws over the image. The anchor is `{type: "image", asset_id, overlay}`; coordinates are **normalized to 0..1 of the displayed image box** (not pixels), so an overlay scales with any layout: `x` is the fraction across the image's width, `y` the fraction down its height, `(0,0)` top-left. Post it as a comment via REST:

```sh
curl -X POST "http://127.0.0.1:7800/api/boards/<board_id>/comments" \
  -H "authorization: Bearer $BOARD_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "anchor": {
      "type": "image",
      "asset_id": "<asset_id>",
      "overlay": {
        "arrows": [{ "x1": 0.3, "y1": 0.4, "x2": 0.55, "y2": 0.4 }],
        "boxes": [{ "x": 0.6, "y": 0.38, "text": "this label overflows" }]
      }
    },
    "body": "Arrow points at the overflow; label marks the fix.",
    "version_n": 1
  }'
```

- `arrows` — `{x1,y1,x2,y2}`: tail → head coordinates (the head renders at x2,y2).
- `boxes` — `{x,y,text}`: the label's top-left anchor point plus its text (200-char cap).
- The overlay may hold only arrows, only boxes, or be omitted entirely for a plain "on image" comment; each list caps at 50 items and every coordinate must be in [0,1].
- To find coordinates for a local image, read its pixel dimensions and divide: `x = pixel_x / width`, `y = pixel_y / height`.

## Export / import

- `board_export {board_id}` returns the board's bundle — manifest, version sources, comments, assets, event audit snapshot — as a zip **base64-encoded in the result's `data` field** (`encoding: "base64"`, `bytes` = raw zip length). Decode and save: e.g. `echo "<data>" | base64 -d > <board_id>.zip`, then write it where the human asked. Bundles over 8 MB are refused by the tool — fetch `GET /api/boards/<id>/export` over REST instead.
- Import (`POST /api/boards/import` with the raw zip, or `board import <file>` / `make import <file>`) is a human/CLI surface — it always mints a NEW board id and re-runs the quarantine pipeline, so embeds and comments survive but ids change. Never assume an imported board keeps its old asset or comment ids.

## Consumption rule — exactly one

Read feedback ONLY via `board_get_comments` with a `since` cursor. First poll uses `since=0` (or omits it); the result carries `last_seq` — persist it and pass it back as `since` on every later poll. Never re-read all comments from scratch; never scrape the web UI or REST routes for feedback.

## Poller (capped)

Run between task steps — never unbounded, never instead of the task:

```
cursor = 0                       # persist last_seq across polls
repeat up to 30 times:           # hard cap — exit the loop no matter what
    res = board_get_comments(board_id, since=cursor)
    cursor = res.last_seq
    if res.comments.length > 0:
        break                    # act on the new comments now
    sleep 10 seconds
```

Thirty iterations at 10 s covers ~5 minutes. If the cap hits with nothing new, get on with the task and poll again later.

## Version conflicts (409)

`board_publish` fails with a conflict when `expected_version` is stale — someone published first. Retry recipe:

1. `board_get` the board and read its current version.
2. Re-apply your change on top of the current content (read it first — never blind-overwrite).
3. `board_publish` again with `expected_version` set to the version you just fetched.
4. Still conflicting after two tries? Stop and surface the conflict to the human instead of looping.

## Daemon down (or never started)

The `board_*` tools are always listed — the local connector (D22) answers `tools/list` offline. A tool call resolves a backend per request: the shared daemon while it runs (with the wired token), else your newest live session instance, else an honest error telling you how to start a server. Default to a session instance (above): for a normal task do not wait on the shared daemon — `board up` gives you your own board, token, and one-time human link with nothing to ask for. Ask the human to start the shared daemon (`make serve` — you never start, stop, or restart the **shared** daemon) only when the task specifically needs the persistent library: browsing or reusing old boards, boards that outlive the task. Once it is up, re-check with `board_status` and continue. The session loop itself stays REST/CLI-canonical (the env-file workflow above). That rule scopes to the *user's host machine* — if you run inside your own container, the fixed-port server in that box is yours (next section).

## Agent-managed in-box server (your own container)

Board-domain lifecycle knowledge lives here, in this skill (D23 D2 — skill + docs + the `board` CLI/connector port as one unit), not in any one host's handoff notes. When your container is the box and the human browses from outside it, you manage the box's fixed-port server yourself (D23 D1=A): start it at recovery, self-heal it across sessions — it dies with the box, the data does not (it sits on a persistent mount).

```sh
# start detached — state on the persistent mount; the bind widens AT SERVE
# ONLY (the docker proxy cannot reach a loopback-bound listener)
BOARD_DATA_DIR=~/board BOARD_HOST=0.0.0.0 nohup bun run server/src/main.ts >> /tmp/boardd.log 2>&1 &
curl -s http://127.0.0.1:7800/api/health   # {"ok":true} = live
board open <board_id>                      # mint the one-time human link
```

- **Client posture is the papercut**: keep `BOARD_HOST=0.0.0.0` in the daemon's environment only. In your own shell it makes CLI/MCP clients send `Host: 0.0.0.0:7800`, which the Host-header allowlist (the rebinding defense) rejects with 421 — clients pin to `127.0.0.1`.
- **Restart-across-sessions runbook**: health-check first; if down, start detached again with the same `BOARD_DATA_DIR` — boards, tokens, and threads are exactly where you left them. This is the recovery the rule above points at when the daemon is *yours*, not the human's.
- **Only the fixed port is browsable** (published-port form): session instances stay structurally loopback + kernel-random port (D20 boundary), so a human-browsable collaboration board lives on this server, not on an instance. Deployment details and the Docker Desktop caveat: `docs/deployment.md`, "Single-container agent box".

## Style

- Boards are markdown: headings, tables, and mermaid diagrams render in the UI.
- One topic per board — split unrelated work into separate boards.
- Label versions: lead with a line like `v2 — trimmed rollout section per feedback` so the human sees what changed and why.
