# API reference

The complete inventory of the daemon's API surface: every REST route, the MCP tool set, and every error code — verified against `server/src/routes/`, `server/src/daemon.ts`, and `server/src/mcp.ts`. [plan.md](plan.md) keeps the scope summary; this file is the contract. Per the binding convention: **when the API surface changes, this file changes in the same commit.**

## Principals and auth

| Principal | Credential | Notes |
|---|---|---|
| agent | `Authorization: Bearer <agent-token>` | minted by the CLI (`make token add <name>`), stored SHA-256, never an API response |
| human | `Authorization: Bearer <session-token>` | one-time `?token=` exchange from `board open`; 30-day browser session (D19) |

- Every `/api` route is bearer-authed **by default** — the route table opts out per route, and only two do (health, session exchange). Agent tokens and human sessions are valid on all default-auth routes; the deviations are explicit: MCP is **agent-only** (human tokens → 401, D16) and the operator surfaces (sessions, tokens) are **human-only** (agent bearers → 403, [security.md](security.md) "Audit view").
- REST clients send the `Authorization` header only; `?token=` exists solely where a client cannot set headers — SSE (`/api/stream`, D13) and `/mcp`.
- Token minting/revocation is **CLI-only** (`board token add|list|revoke`) — there is deliberately no API route that mints or echoes token material.

Transport hardening applies to every request (REST, MCP, assets, statics): Host-header allowlist (→ 421), `Sec-Fetch-Site: cross-site` rejection on unsafe methods (→ 403), `Content-Type: application/json` required on JSON writes (→ 415), 8 MB body cap (→ 413). No CORS headers, ever. The universal `401 unauthorized` on a missing/invalid bearer is omitted from the per-route error lists below.

Error shape: `{ "error": { "code": "<code>", "message": "<human-readable>" } }` (+ per-error extra fields — e.g. `version_conflict` adds `current_version`). Success shapes are the domain objects themselves ([`server/src/domain.ts`](../server/src/domain.ts)).

## Boards

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `GET /api/boards` | any | filters: `status` (`open`\|`ended`), `tag`, `author` | `BoardWithCommentCounts[]` — each board + `unresolved_comments` + `subscriber_count` | 400 `invalid_request` |
| `POST /api/boards` | any | `{title, format, tags?}` (`format`: `markdown`\|`html`) | `201` `Board` (starts at v0, empty) | 400 `invalid_request` |
| `GET /api/boards/:id` | any | — | `{board, versions: VersionMeta[]}` (metadata only — no content) | 404 `board_not_found` |
| `POST /api/boards/:id/publish` | any | `{format, content, expected_version, label?, note?}` | `201` full `Version` (content + `source_md` when markdown) | 400 `invalid_request` / `invalid_asset_embed`, 404 `board_not_found`, 409 `version_conflict` (+`current_version`) / `board_ended`, 413 `payload_too_large` (8 MB doc cap) |
| `POST /api/boards/:id/end` | any | — | `200` `Board` (status `ended`); writes then 409, reads stay | 404 `board_not_found`, 409 `board_ended` (already ended) |
| `POST /api/boards/:id/restore` | any | `{from_n, expected_version}` | `201` full `Version` (copy of `from_n`, labeled `restore of vN`) | 404 `board_not_found` / `version_not_found`, 409 `version_conflict` / `board_ended` |

Publish and restore take `expected_version` (the board's `current_version`); a stale value is **409 `version_conflict`** with `current_version` attached — read it and retry, never blind-overwrite (open-artifacts' model).

## Versions

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `GET /api/boards/:id/versions/:n` | any | `n`: non-negative integer | full `Version` — `{board_id, n, label, note, content, source_md, anchors, created_by, created_at}` | 400 `invalid_request`, 404 `board_not_found` / `version_not_found` |

Versions are immutable; `anchors` is the `ExtractedAnchor[]` list extracted at publish (see [anchors.md](anchors.md)).

## Comments

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `POST /api/boards/:id/comments` | any | `{anchor, body?, version_n, in_reply_to?}` | `201` `Comment` | 400 `invalid_request` / `invalid_anchor`, 404 `board_not_found` / `version_not_found` / `comment_not_found` (reply parent), 409 `board_ended` |
| `POST /api/comments/:id/reply` | any | `{body}` (required) | `201` `Comment` (inherits parent's anchor + `version_n`) | 400 `invalid_request`, 404 `comment_not_found`, 409 `board_ended` |
| `POST /api/comments/:id/resolve` | any | — | `200` `Comment` (idempotent — already-resolved returns as-is, no second event) | 404 `comment_not_found`, 409 `board_ended` |
| `GET /api/boards/:id/comments?since=<seq>` | any | `since`: exclusive seq cursor | `{comments: Comment[], last_seq}` | 400 `invalid_request`, 404 `board_not_found` |

- `Comment` = `{id, board_id, version_n, seq, anchor, body, author, in_reply_to, created_at, edited_at, resolved_at, resolved_by}`. `seq` is the global event seq of the comment's creation event — the cursor substrate.
- `since` is **exclusive** (`seq > since`), client-held, at-least-once, restart-safe (D13 — there is no server-side ack). `last_seq` is the board's greatest comment seq (0 when none); persist it and pass it back as `since`.
- Body rule: `body` is required **except** a root comment anchored to `{type:"image"}` carrying ≥1 overlay item — the overlay IS the payload. Replies always require text.
- An agent-token poll doubles as presence: it upserts the caller's `subscribers` row (`kind: cursor`) — see [feedback-grammar.md](feedback-grammar.md).

## Feedback grammar (REST-only)

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `GET /api/boards/:id/feedback?since=<seq>` | any | `since`: seq — threads touched after it render **in full** (root + all replies) | `{feedback: string, last_seq}` | 400 `invalid_request`, 404 `board_not_found` |

The markdown grammar (numbered threads, anchor descriptors, quoted `originalText`, resolve state) is human-readable and agent-parseable. Per D15 it is NOT an MCP tool — MCP agents consume `board_get_comments`; this endpoint is for humans, scripts, and reports. `last_seq` is the board's max comment seq.

## Assets

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `POST /api/assets` | any | **binary variant**: raw image bytes, board via `?board_id=`, type via `Content-Type`. **file-copy variant**: `Content-Type: application/json` + `{board_id, path}` — `path` absolute on the daemon host | `201` `Asset` `{id, board_id, file, mime, size, source, created_by, created_at}` | 400 `invalid_request` / `asset_type_not_allowed` / `asset_not_an_image` / `asset_path_unreadable`, 404 `board_not_found`, 409 `board_ended`, 413 `asset_too_large` (10 MB per asset) / `board_asset_quota_exceeded` (8 MB per board) |
| `GET /assets/:id` | **none** (host route, outside `/api`) | — | image bytes; content-type pinned at ingest, immutable caching, `nosniff` | 404 `asset_not_found` / `not_found`, 405 `method_not_allowed` |

- One verification pipeline for both variants: mime allowlist (png/jpeg/gif/webp/svg+xml) → magic bytes (SVG: parse-and-sanitize, sanitized bytes stored) → size caps — [security.md](security.md) "Assets". Rejections never echo file contents.
- `GET /assets/:id` is deliberately unauthenticated (`<img>` cannot send headers); asset ids are 62^10 unguessable. The 10-char id shape disambiguates from the SPA's hashed `/assets/*` bundles.

## Subscriptions, webhooks, presence

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `POST /api/boards/:id/subscribe` | any | `{webhook_url, webhook_secret?}` — URL **required** (webhook-less listening is auto-detected, not registered) | `201` `{id, board_id, principal, webhook_url, created_seq}` | 400 `invalid_request` / `invalid_webhook_url` (non-http(s), embedded credentials), 404 `board_not_found` |
| `DELETE /api/boards/:id/subscribe` | any | — | `200` `{ok: true}` | 404 `board_not_found` / `subscription_not_found` |
| `GET /api/boards/:id/subscribers` | any | — | `Subscriber[]` `{id, board_id, principal, kind, webhook_url, last_seq, last_seen}` — webhook registry + auto-detected cursor presence, secrets never selected | 404 `board_not_found` |

One webhook per principal per board; re-subscribing **replaces** url + secret. Deliveries are fire-and-forget, serialized per subscription, `POST` of the exact event envelope `{seq, ts, actor, type, board_id, payload}`; with a secret: `X-Board-Signature: sha256=<hex>` (HMAC-SHA256 over the exact body). 3 attempts (backoff 500 ms → 2 s), no redirects followed; final failure appends a `webhook.failed` dead-letter event — which is itself never delivered. Full receiver contract: [feedback-grammar.md](feedback-grammar.md).

## Events

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `GET /api/events` | any | filters: `board_id`, `type` (exact — `type=webhook.failed` is the dead-letter view), `since`, `limit` (default 100, clamped to 500) | `{events: BoardEvent[], last_seq}` — `last_seq` is the **GLOBAL** max seq (next-poll cursor advances past filtered/clamped pages) | 400 `invalid_request` |
| `GET /api/boards/:id/events?since=<seq>` | any | `since`: exclusive cursor | `{events: BoardEvent[], last_seq}` — `last_seq` is the page tail (or `since`, or 0); page cap 200 | 400 `invalid_request`, 404 `board_not_found` |

`BoardEvent` = `{seq, ts, actor, type, board_id, payload}`; types: `board.created`, `board.imported`, `board.published`, `board.ended`, `board.restored`, `comment.created`, `comment.replied`, `comment.resolved`, `asset.added`, `agent.subscribed`, `webhook.failed`. Both channels are read-only mirrors of the same rows an agent can tail as `events.jsonl` — an unknown `board_id`/`type` filter is an empty result, not a 404.

## Sessions (human-only operator surface)

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `POST /api/session/exchange` | **none** (this IS the bootstrap) | `{token}` — the one-time exchange token from `board open` (10-min TTL, single use) | `200` `{token: <session-token>}` | 400 `invalid_request` / `invalid_json`, 401 `unauthorized` (generic — never distinguishes "never issued" from "already spent") |
| `GET /api/sessions` | **human only** (agent bearer → 403) | — | `{sessions: [{id, kind: "exchange"\|"session", created_at, used_at, expires_at}]}` — `id` is the stored sha256 (safe), lifecycle metadata only | 403 `forbidden` |
| `DELETE /api/sessions/:id` | **human only** | — | `204` no body; self-revoke allowed (the UI re-exchanges) | 403 `forbidden`, 404 `session_not_found` |

Revocation is the leak remediation (a sessions-table write, never an event). The mirror of MCP's D16 rejection: a valid agent bearer still gets 403 — enumerating human sessions is recon. Live sessions expire 30 days after exchange (`expires_at`; D19) — enforced at auth time, so a dead session bearer 401s without operator action.

## Tokens (human-only inventory)

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `GET /api/tokens` | **human only** (agent bearer → 403) | — | `{tokens: [{name, created_at, revoked_at, last_seen}]}` — **never** token values or hashes | 403 `forbidden` |

The API mirror of `board token list`; minting/revocation stays CLI-only (see [deployment.md](deployment.md)).

## Export / import

| Method + path | Auth | Body / params | Response | Errors |
|---|---|---|---|---|
| `GET /api/boards/:id/export` | any | — | `application/zip` attachment (`<id>.zip`) — manifest, per-version sources, `comments.json`, asset bytes, the board's events as an audit snapshot. Works on ended boards | 404 `board_not_found` |
| `POST /api/boards/import` | any | **raw zip body** (not JSON — the route is raw-body) | `201` `Board` — always a NEW id, re-runs the D18 quarantine (re-render, re-verify assets, strict manifest, zip-slip defense, atomic validate-then-write) | 422 `import_rejected` (any quarantine/manifest/layout failure — including over-cap bodies; nothing written) |

Request cap: 64 MB. Import restores the EXPORTED status (an ended board comes back ended). Bundles are portable — this is the backup story (see [deployment.md](deployment.md)).

## Stream (SSE)

| Method + path | Auth | Body / params | Response |
|---|---|---|---|
| `GET /api/stream?since=<seq>` | any principal — `Authorization: Bearer` **or** `?token=` (EventSource cannot set headers, D13; missing/invalid → 401) | `since` or `Last-Event-ID` header (exclusive replay) | `text/event-stream`; frames: `id: <seq>` / `event: board` / `data: <BoardEvent JSON>`; heartbeat comment every 25 s; reconnect = re-GET with the last seen seq |

Best-effort by design — cursors are the reliable baseline ([architecture.md](architecture.md)). Note: an SSE connection is **not** recorded as a presence row; only cursor polls and webhook registrations are (see [feedback-grammar.md](feedback-grammar.md) "Presence").

## Health

| Method + path | Auth | Response |
|---|---|---|
| `GET /api/health` | **none** — the single public `/api` route | `200` `{ok: true}` |

The liveness probe `make install` and the Dockerfile `HEALTHCHECK` use.

## MCP (`POST /mcp`, agent-only)

Streamable HTTP in **stateless JSON mode** (D16): one request = one JSON response; a fresh server + transport per POST — no sessions, no GET SSE stream (**non-POST → 405** `method_not_allowed`, `Allow: POST`). Auth: agent token via `Authorization: Bearer` or `?token=` — a **valid human session token is rejected** (401, D16). Same hardening as `/api` (Host allowlist, cross-site, JSON-only, 8 MB cap). Tools call the same service layer as REST — the event log cannot tell an MCP agent from a REST agent.

> The endpoint is unchanged by D22; only the shipped *wiring* changed. Agent harnesses no longer point at this URL directly — they spawn the local stdio connector (`board mcp`, or `node cli/src/mcp-connector.ts`), which lists the 15 tools from the shared manifest (its two connector-local ones included) and proxies the rest to this endpoint on whichever board server is up. Per-call resolution (D22, amended by D23 D4): a set `BOARD_INSTANCE` env targets that instance strictly (dead/missing = honest error, no fallthrough), else an explicit `board_connect` pin, else the shared daemon when healthy with `BOARD_MCP_TOKEN`, else the newest healthy session instance, else an honest error. Everything below describes this endpoint as-is.

Tool results are `{content: [{type: "text", text: <JSON>}]}`; store errors come back as `isError: true` with a plain-text message (never JSON-RPC protocol errors); `board_publish` conflict messages append `(current_version: N)` so a retry needs no second round-trip.

The tool surface is 15: the daemon's 13 below, plus the two **connector-local** tools (`board_servers`, `board_connect` — D23 D4) that the local stdio connector lists and handles itself. The daemon's `tools/list` never advertises the connector-local two (its advertised surface is exactly what it can execute); a `tools/call` for one that arrives at `/mcp` directly gets the SDK's unknown-tool envelope (`isError: true`) with a message naming the connector. One single-source manifest (`server/src/mcp-tools.ts`) carries the definitions — the connector-local entries are marked, never duplicated.

The daemon's 13 tools:

| Tool | Arguments | Returns (the JSON in `content[0].text`) |
|---|---|---|
| `board_create` | `title`, `format` (default `markdown`), `tags?` | full `Board` |
| `board_publish` | `board_id`, `format`, `content`, `expected_version`, `label?`, `note?` | version **metadata** + `content_bytes` — `{board_id, n, label, note, anchors, created_by, created_at, content_bytes}`; content never rides back (the agent already holds it) |
| `board_list` | `status?`, `tag?`, `author?` | boards + `unresolved_comments` + `subscriber_count` |
| `board_get` | `board_id` | `{board, versions: VersionMeta[]}` |
| `board_get_comments` | `board_id`, `since` (default 0 — exclusive cursor) | `{comments: Comment[], last_seq}` — **the** feedback consumption path (D15); polls count as presence |
| `board_reply` | `comment_id`, `body` | the new `Comment` (inherits the parent's anchor) |
| `board_resolve` | `comment_id` | the `Comment` (idempotent) |
| `board_restore` | `board_id`, `from_n`, `expected_version` | full `Version` (content included — restore copies it verbatim) |
| `board_end` | `board_id` | the ended `Board` |
| `board_status` | `board_id?` | `{status: "ok", boards: {open, ended}, subscribers, board?: {id, status, current_version, unresolved_comments}}` — daemon liveness (D14: the daemon-down detector) |
| `board_subscribe` | `board_id`, `webhook_url`, `webhook_secret?` | `{id, board_id, principal, webhook_url, created_seq}` |
| `board_upload_image` | `board_id`, `path` (absolute, on the daemon host) | `{asset_id, board_id, mime, size, embed_markdown: "![image](asset:<id>)", embed_html: "<img src=/assets/<id>>"}` |
| `board_export` | `board_id` | `{board_id, bytes, encoding: "base64", data}` — the zip base64-encoded; bundles over 8 MB are refused with a pointer to `GET /api/boards/:id/export` |

**Connector-local tools** (D23 D4) — listed and handled by the local stdio connector (`board mcp` / `node cli/src/mcp-connector.ts`), never proxied to a daemon; they work when no board server is running and never include token material in their results:

| Tool | Arguments | Returns (the JSON in `content[0].text`) |
|---|---|---|
| `board_servers` | — | `{servers: [{kind: "shared"\|"instance", id?, url?, status: "up"\|"down", credential: boolean, boards?: [{id, title, status, current_version, unresolved_comments}], hint?}]}` — the shared daemon plus every open registry instance, health-probed; boards are listed only where a credential is available (shared: `BOARD_MCP_TOKEN`; instance: its 0600 env file), down/credential-less servers carry a one-line hint |
| `board_connect` | one form per call: `{url, token}` (manager-minted; **url must be loopback** — enforced structurally), `{instance_id}`, `{shared: true}`, `{}` (status echo), `{reset: true}` | `{connected, target: {kind, url, id?}, boards?}` — the target is validated (health + the token must actually authenticate on a boards list) **before** pinning; a bad target errors and pins nothing. A pin beats auto-resolution for subsequent `board_*` calls (D23 D4's amendment of D22); `{reset: true}` returns to auto |

## Error codes

Every code the daemon can emit (translation lives in one place — `server/src/daemon.ts` `errorResponse` — plus the shared middleware):

| Code | Status | Raised by |
|---|---|---|
| `unauthorized` | 401 | missing/invalid bearer; invalid exchange token (generic by design); MCP human-token rejection |
| `forbidden` | 403 | human-only surfaces hit with an agent bearer (`requireHuman`) |
| `cross_site_blocked` | 403 | `Sec-Fetch-Site: cross-site` on an unsafe method |
| `bad_host` | 421 | missing or non-allowlisted Host header (DNS-rebinding defense) |
| `unsupported_media_type` | 415 | non-JSON Content-Type on a JSON write |
| `invalid_json` | 400 | unparseable JSON body |
| `invalid_request` | 400 | field-level validation (`validate.ts`), missing query params, empty comment body (`CommentBodyRequired` reuses this code) |
| `invalid_anchor` | 400 | anchor semantics: unknown section/row/quote-miss/asset, overlay range/size caps |
| `invalid_asset_embed` | 400 | malformed `asset:` embed in a markdown publish (src echoed, ≤120 chars) |
| `invalid_webhook_url` | 400 | non-http(s) or credential-embedding webhook URL |
| `not_found` | 404 | no route, SPA statics, `/libs/*` |
| `web_not_built` | 404 | SPA not built — run `make web` |
| `board_not_found` | 404 | unknown board id |
| `version_not_found` | 404 | unknown version n |
| `comment_not_found` | 404 | unknown comment id (target or reply parent) |
| `subscription_not_found` | 404 | unsubscribe with no webhook row |
| `session_not_found` | 404 | revoking an unknown session id |
| `asset_not_found` | 404 | unknown asset id at serve time |
| `method_not_allowed` | 405 | wrong method (with `Allow` header); MCP non-POST |
| `version_conflict` | 409 | stale `expected_version` (+`current_version`) |
| `board_ended` | 409 | any write to an ended board |
| `payload_too_large` | 413 | 8 MB JSON body / document cap |
| `asset_too_large` | 413 | 10 MB per-asset cap |
| `board_asset_quota_exceeded` | 413 | 8 MB per-board asset total |
| `asset_type_not_allowed` | 400 | declared mime/extension not on the image allowlist |
| `asset_not_an_image` | 400 | magic bytes don't match the declared type; unsanitizable SVG |
| `asset_path_unreadable` | 400 | `{path}` copy: relative path, missing/unreadable/non-regular file |
| `import_rejected` | 422 | import quarantine: layout, manifest, re-render, re-verify, reference resolution — nothing written |
| `internal_error` | 500 | unhandled server error (details logged, never echoed) |
