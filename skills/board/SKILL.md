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

## Running inside a container

When your agent runs **inside a container** (e.g. `agentbox`, Docker), `make install`
may fail to wire the shared daemon's token into the MCP connector because the
agent config file (`opencode.jsonc`) is on a **read-only filesystem** inside the
container. The symptom: **your browser hits the shared daemon** (port 7800, old
boards) but **MCP tools hit the session instance** (newest, tunnel boards) — a
split-brain routing problem.

**Diagnose:** run `board_servers` — the shared daemon shows `credential: false` with
the hint `no BOARD_MCP_TOKEN credential wired`.

**Fix options:**

1. **Quick (env var):** `export BOARD_MCP_TOKEN=<board-opencode-token>` before starting
   the agent — the connector reads this and routes to the shared daemon.
2. **Proper:** run `make install` on the **host machine** (not inside the container),
   then mount the host's opencode config into the container.
3. **Persistent:** set `BOARD_MCP_TOKEN` as a Docker env var so every agent spawn
   gets the shared daemon wired.

**Key rule:** inside a container with a fixed-port server, manage the server lifecycle
(your own container — the skill's "Agent-managed in-box server" section covers this),
but wire the connector token on the **host** where the config is writable.

## Collaborating on a shared board

Several agents can share one board. Attribution is the token name — every comment, reply, and resolve is stamped with the bearer token's name.

- **Per-agent tokens**: each agent mints its own — `make token add <name>` on the shared daemon, `board token add <name> --instance <id>` on a session instance (omit the name for a generated handle like `red-armadillo`) — so its entries read as that agent.
- **Per-agent cursors**: the `since` cursor is client-held state (D15); each agent persists its own per board. Sharing one cursor means missing each other's threads.
- **Push**: `board_subscribe` (webhook_url, webhook_secret?) delivers signed events to an agent that can receive one, instead of polling.
- **Presence**: every agent-token cursor poll refreshes a `cursor` subscriber row; `GET /api/boards/:id/subscribers` lists who is reading.
- **Addressing a specific agent**: put `@<handle>` in the comment body (prefix or inline) — that directs the comment's attention at one agent, **not privately**: every cursor sees every comment. The roster of mentionable handles is the subscribers list (presence upserts on every poll) union comment authors and version creators — the token principal is the handle (`docs/feedback-grammar.md` "@mentions" is the contract).

On a **session instance** the `up`-printed env file carries one token: sourcing it in every agent's shell means shared credentials and one shared name on every entry; minting per-agent tokens (`board token add <name> --instance <id>`) keeps attribution distinct. Pick deliberately.

**New board, or the existing one? Ask when ambiguous.** When a task could either join a board that already exists (a collaboration board, the shared library) or warrants its own new board, **ask the human — never silently pick** (D23 D4: "let's not try to be too clever, let's just be explicit"). Default to asking when the task mentions a board you did not start, a team, or an ongoing review.

**Inviting a contributor / joining as one (D23 D4):** the manager mints the contributor's credential — `board token add <agent-name>` on the board's server (`--instance <id>` for a session instance; omit the name to get a generated handle) — and hands over **three strings** out of band: the **url**, the **token**, and the **handle**: *"you are @\<name\> — poll the cursor and filter comment bodies for your handle; that's how you're addressed."* If the contributor asked for a specific name during invite negotiation, mint that one. The contributor then connects explicitly, never by guessing:

1. `board_servers` — discover the local servers that are actually up (shared daemon + session instances) and the boards on each. Connector-local; works even when nothing is up; never shows tokens.
2. `board_connect {url, token}` — pin that server for all subsequent `board_*` calls (`{instance_id: "<id>"}` pins a registry instance, `{shared: true}` the shared daemon, `{}` echoes the current target, `{reset: true}` unpins). The target is validated (health + token) before pinning; the url must be loopback.
3. Work the loop as usual — the attribution, cursor, and presence rules above apply. The per-request stderr diagnostic names the resolved backend and marks a pinned target `(connected)`, so a wrong-target route is visible in the harness's MCP log.

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

- **Tokens, cursors, addressing, and presence** work exactly as in *Collaborating on a shared board* above — nothing new here. One addition: over a long run, comment threads are also a record of who has acted.
- **Durability (D3 — ratified 2026-09-22)** — spawn with `BOARD_DATA_DIR` on a persistent volume: the instance registry and its keepsake zips then survive environment resets (the daemon's own data dir stays OS-temp per D20). Export milestone keepsakes mid-flight (`board export --instance <id> <board_id>`), not only at `down`; recovery is import from the keepsakes (`make import`, or `board up --resume=latest`).
- **MANDATORY — takeaways land at \<repo path\>** (D6): every collaboration loop carries an explicit line naming where its durable outcomes go, and writes them there before the cycle closes. Keep the board served only as long as the exchange needs it.

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
| `board_servers` | **connector-local**: lists the local servers that are up + their boards (works with nothing running) | — |
| `board_connect` | **connector-local**: pins an explicit server for subsequent `board_*` calls | `{url, token}` \| `{instance_id}` \| `{shared: true}` \| `{}` \| `{reset: true}` |

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

The `board_*` tools are always listed — the local connector (D22) answers `tools/list` itself. A tool call resolves a backend per request (D22, amended by D23 D4): a set `BOARD_INSTANCE` env targets that instance strictly, then an explicit `board_connect` pin, then the shared daemon while it runs (with the wired token), then your newest live session instance, else an honest error telling you how to start a server. Not sure what IS up? `board_servers` lists the local servers and their boards — start there. Default to a session instance (above): for a normal task do not wait on the shared daemon — `board up` gives you your own board, token, and one-time human link with nothing to ask for. Ask the human to start the shared daemon (`make serve` — you never start, stop, or restart the **shared** daemon) only when the task specifically needs the persistent library: browsing or reusing old boards, boards that outlive the task. Once it is up, re-check with `board_status` and continue. The session loop itself stays REST/CLI-canonical (the env-file workflow above). That rule scopes to the *user's host machine* — if you run inside your own container, the fixed-port server in that box is yours (next section).

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

## Write it for a human who just switched gears

The person reading your board has been doing something else. They do not remember the ticket, the incident, or the words you have been living in for the last hour. Write for them, not for the version of yourself that just did the work.

- **Plain language before internal language.** Say what the thing is in terms of what the product does, then introduce your terms. Define anything they cannot be assumed to know in-line, the first time it carries weight.
- **No agent jargon.** "The frontier is empty so I'm exiting the loop" means nothing to them. "Nothing left to decide — here's what we agreed" does.
- **Number anything sequential** — what a request touches, where a failure lands, what you plan to do — and mark the step that matters.
- **Separate measured from estimated**, every time, and never assert a date, count, or version you have not checked. One invented number discredits the real ones beside it.
- **One topic per board.** Split unrelated work into separate boards.
- **Label every version.** Lead with a line like `v2 — trimmed the rollout section per your comment` so the human sees what changed and why without diffing.

## Reach for a picture

Prose is the worst format for most of what goes on a board. If following your paragraph means building a picture in their head, draw the picture instead. What renders where, measured:

| You want | Board format | How |
|---|---|---|
| A diagram — before/after, who-owns-what, where a value flows | either | markdown: a ```` ```mermaid ```` fence. html: write `<pre class="mermaid">…</pre>` yourself. Rendered client-side, `securityLevel: "strict"`; a bad diagram degrades to its source instead of breaking the page |
| A table of options against criteria | either | GFM table; rows are individually comment-anchorable |
| Math | **markdown** | `$x^2$` inline, `$$…$$` display — katex at publish time |
| Syntax-highlighted code or pseudocode | **markdown** | a fenced block with a language tag |
| A live chart — measured over time or category | **html** | `<script src="/libs/chart-4.4.9.umd.min.js"></script>`, vendored and pinned. Put it in `<head>`: externals are awaited in document order before your inline code runs. Then call `boardChartTheme()` — see below |
| Questions the human clicks answers into | **html** | the `interview` skill — `skills/interview/SKILL.md` |
| A screenshot or an image you generated | either | `board_upload_image`, then the snippet it hands back |

**Charts: call `boardChartTheme()` first.** Chart.js draws in its own grey-on-white palette, which has nothing to do with Board's theme and is close to unreadable on the dark one. One call fixes it:

```js
const palette = boardChartTheme();   // also sets Chart.defaults from Board's tokens
new Chart(canvas, {
  type: "bar",
  data: { labels, datasets: [{ label: "after", data, backgroundColor: palette[0] }] },
  options: { maintainAspectRatio: false },   // then give the canvas a parent with a height
});
```

It throws if Chart.js has not loaded yet, which is the failure you want — the alternative is a chart that renders wrong with no clue why. And if you set `maintainAspectRatio: false`, put the canvas in a container with an explicit height, or it grows without bound (dogfooded: a 41,849px tall chart).

Charts are not decoration. A number that matters across time or category is a chart; a paragraph describing that chart is a worse version of the same information. Put a `data-ba` id on a diagram or a section and it stays commentable — the human can anchor a comment to the picture itself.

## html boards: the app already styles them

An html board mounts into the **host document with no iframe** (D18), so it inherits the app's prose styling for free. For form chrome — questions, inputs, buttons, cards — wrap your board in `<div class="board-ui">` and it picks up the app's real theme tokens, dark mode included:

```html
<div class="board-ui">
  <h1>Rollout options</h1>
  <fieldset>
    <legend>Q1 · Which region first?</legend>
    <label><input type="radio" name="q1" value="A"> <b>A</b> us-east
      <span class="why">Largest blast radius, fastest signal.</span></label>
  </fieldset>
  <div class="bar"><button type="submit">Submit</button></div>
</div>
```

`fieldset`, `legend`, `label`, `input`, `textarea`, `select`, `button` are styled, plus `.why` (muted secondary line), `.rec` (a highlighted recommendation), `.settled` (what is already decided), `.note`, `.bar` (the action row), `.ok` / `.bad`. Selected options highlight themselves through `:has(:checked)` — no JavaScript, no aria bookkeeping. Full list in [docs/api.md](../../docs/api.md) under *Board rendering surface*.

### Want Tailwind? It is vendored (D26)

```html
<script src="/libs/tailwind-4.3.3.browser.js"></script>
```

Utility classes then work as you expect them to. **One rule, and it is the whole difference between a board that looks native and one that looks pasted in:** take every color from Board's own tokens, never from Tailwind's palette. Tailwind's defaults assume a white page; Board runs `color-scheme: light dark`, so `bg-white text-gray-900` is a white card on a near-black app for any reader in dark mode.

```html
<div class="rounded-lg border p-4 bg-[var(--bg-subtle)] text-[var(--fg)] border-[var(--border-subtle)]">
```

Layout, spacing, and type utilities are free of this — it is only color. `.board-ui` and Tailwind compose fine; use both.

Two measured caveats. Tailwind v4 emits its base and theme rules inside `@layer`, and unlayered CSS beats layered CSS — so Board's own styling wins and the app's chrome is untouched (verified: fonts, borders, and the content column are identical with and without it). But its generated `<style>` is injected into `<head>`, **not** into your board, so it survives navigation and stays live for every board opened afterwards in that browser session. Its `*, ::before, ::after { border: 0 solid }` reset then applies to boards that never asked for Tailwind. Nothing observed breaks, because Board sets its borders explicitly — but a board that relies on a browser default border may not look the same after someone visits a Tailwind board.

## Your board's script shares one global scope

Every board's inline script runs in the **same** global scope as every other board opened in that browser session. A top-level `const` or `let` therefore throws `already been declared` the second time — and a script that throws never runs, so **that board renders nothing at all**. Dogfooded exactly that way: two interview boards, the second one blank.

Wrap everything you write in an IIFE:

```html
<script>
(() => {
  const BOARD_ID = "…";   // safe — scoped to this function
  // …
})();
</script>
```

The shipped templates do this, and `skills/templates/templates.test.ts` compiles each one twice in a single context to keep them honest.

**If you do add your own CSS, scope every rule to your own wrapper id.** The board shares this document with the app, so a bare element or `:root` selector restyles the app itself, silently:

```html
<style>
  body { max-width: 760px }   /* WRONG — shrinks the whole board app */
  :root { --bg: #fff }        /* WRONG — overrides the host's own variables */
  #mine h1 { font-size: 2rem }  /* right — scoped to your wrapper */
</style>
```

That exact `body` rule once cut the host's content column from 1169px to 312px, and it reads as a Board layout bug rather than a board-content bug.

`skills/templates/interview-round.html` (interactive questions) and `skills/templates/dashboard.html` (charts and status) are the worked examples — start from one of them.

**Interactive boards** — a human clicking answers back to you — are the `interview` skill's job, not a thing to hand-roll: `skills/interview/SKILL.md` owns the question schema, and the one file that posts answers back.
