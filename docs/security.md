# Security model

Threat model and required mitigations for v1. The **seven non-negotiable invariants are enumerated in [AGENTS.md](../AGENTS.md)**; this document is the reasoning behind them and the mitigations they imply. They are enforced in code, not suggestions.

## Trust boundaries

- **Trusted**: the daemon process, the host origin (`:7800`) UI, SQLite, the filesystem.
- **Untrusted**: every byte of agent-authored board content — and since D18 it runs *inside* the trusted origin, so the isolation that word once implied is gone; the host CSP is the whole boundary ("Render trust model" below). Also: all API input; every byte of an imported bundle ("Import quarantine" below); tool/board output consumed by agents (prompt-injection surface).
- **Assumed environment**: one local human — but their browser also visits the public internet, so remote websites attacking our localhost ports are in scope (CSRF, DNS rebinding, localhost port probing).

## Render trust model (D18 — full host-render)

**Owner decision 2026-09-15 ([docs/decisions.md](decisions.md) D18):** agent HTML boards render in the host chrome, unsandboxed, with scripts running in the app's origin. The earlier two-origin iframe model was built, dogfooded one round, and removed the same day — the owner judged the interactivity cost higher than the risk.

There is no board iframe, no second origin, and no sanitization of html-format boards. What stands between board script and the app is the host CSP:

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; form-action 'self';
frame-ancestors 'none'; object-src 'none'; base-uri 'none'
```

- `connect-src 'self'` is the network-exfiltration kill-switch — board script cannot fetch, WebSocket, or beacon anywhere but the app itself. It never opens.
- `form-action 'self'` — boards cannot form-navigate the app away to an external URL.
- `frame-ancestors 'none'` — nobody frames the app.
- `script-src 'self' 'unsafe-inline'` — the accepted cost of D18: board scripts run, from the app's own origin (`/libs/*`, pinned) or inline.
- `default-src 'self'` — no audio, video, plugin, or worker reach beyond the app.

**Named, owner-accepted residual risks:** board script shares the page with the session token (localStorage) and the API — it can act as the human (write/resolve anything) and paint arbitrary UI over the app (phishing). Rationale: boards are published by the user's own agents, which already hold machine-level access. **Foreign content invalidates this rationale** — bundle import re-runs the full quarantine ([security.md](security.md) "Import quarantine"); any remote mode remains unshipped.

Markdown boards are unaffected: they pass through DOMPurify at publish and are script-free by construction (invariant 5, markdown through DOMPurify).

## API hardening

| Threat | Mitigation |
|---|---|
| Cross-site POST/PUT from a malicious public page (CSRF against localhost) | Per-agent bearer tokens (not auto-attached cross-site); `application/json`-only writes (kills "simple request" forms); reject `Sec-Fetch-Site: cross-site` on unsafe methods; Origin/Referer fallback for old browsers |
| DNS rebinding (attacker domain → 127.0.0.1, defeating CORS/Origin checks) | Strict Host-header allowlist: only `127.0.0.1:PORT` / `localhost:PORT` accepted; never rely on DNS-response filtering |
| Casual remote exposure | Bind `127.0.0.1` only (`BOARD_HOST`; widening it is the explicit, documented Docker opt-out). `BOARD_BIND` adds **Host-header** names to the allowlist above — it never adds a bind address |
| Browser probing / reading API responses | No CORS headers, ever — and never `Access-Control-Allow-Origin: null`; no state changes via GET |
| MCP endpoint abuse (`POST /mcp`) | Agent-token-only — valid human session tokens are rejected (browsers are never MCP clients); same Host allowlist, cross-site rejection, JSON-only + 8 MB body cap as `/api`; stateless JSON mode — no sessions and no SSE stream to hijack, non-POST → 405 |

## Audit view + operator surface (M7)

The audit view's endpoints are reads over existing state (plus exactly one new write target, session revocation) — nothing here touches the event log (invariant 4, events are append-only).

- **`GET /api/events` — any authenticated principal (agent or human).** This is deliberately NOT a new exposure: the D1/D15 design already hands agents the event log directly (the global + per-board `events.jsonl` mirrors, the `?since=` cursors). The endpoint is a query convenience over rows agents can already read, and the substrate the audit UI polls: filters `board_id`, `type` (exact match — `type=webhook.failed` is the dead-letter view), `since`, and `limit` (default 100, clamped to 500). `last_seq` carries the GLOBAL max seq as the next-poll cursor, so a filtered or clamped page can never strand the poll behind events it didn't show.
- **`GET /api/sessions` + `DELETE /api/sessions/:id` + `GET /api/tokens` — human-only; a valid agent bearer gets 403.** This is the actual security line of the audit surface. The reasoning mirrors MCP's D16 rejection of human tokens — same shape, opposite direction: an agent enumerating human sessions or agent token names is **recon** (credential inventory for a future impersonation), so the boundary is on the principal kind, not the credential's validity. Session rows expose lifecycle metadata only; `id` is the stored sha256 (safe — the token material is 256-bit random, and the plaintext never survives minting).
- **`GET /api/tokens` never returns token values or hashes** — names + lifecycle (`created_at`, `last_seen`, `revoked_at`) only, mirroring `board token list`. Adjacent to invariant 7 (tokens stored hashed): the DB stores hashes, and no API surface exists to echo credential material back.
- **Session revocation is the leak remediation.** Dogfood precedent: the owner pasted a live `?token=` URL into a board comment and had no way to kill the credential. `DELETE /api/sessions/:id` (204, human-only; 404 unknown id) deletes the session row — a sessions-table write, never an event — and includes the CURRENT session (self-revoke is allowed; the UI's re-exchange flow recovers). Revoking an unexchanged exchange row kills the leaked URL before it can be swapped.

## Session instances (D20)

`board up`/`board down` let an agent spawn and tear down **throwaway loopback daemons** — the one agent-managed slice of daemon lifecycle (D14's deferred loop, [decisions.md](decisions.md) D20). The boundary is scope, not privilege:

- **Persistent state stays human-managed.** The shared daemon and `~/.board` are untouched — D10's no-auto-spawn rationale holds for all persistent state. A session instance's data dir is always an OS-temp directory (`board-instance-*`), never under `~/.board`, and is purged at teardown (unless `--keep-data` keeps the *data*, never the credential).
- **The bind is pinned, not inherited.** Spawn pins `BOARD_HOST`/`BOARD_BIND` to loopback and the loopback Host-allowlist over whatever the invoking shell exported — a hostile `BOARD_HOST=0.0.0.0` or widened `BOARD_BIND` Host allowlist cannot widen a session instance (invariant 1, loopback bind). The port is kernel-assigned (`BOARD_PORT=0`), so instances never collide with the shared daemon or each other. The child environment is scrubbed of every inherited `BOARD_*` key before those pins are applied — a sourced previous-session env file cannot leak its live `BOARD_TOKEN` into the daemon's `/proc/<pid>/environ` (audit-hardened 2026-09-16).
- **Credentials: print-once + 0600 env file.** One agent token is minted before the daemon spawns and stored hashed in the instance db (invariant 7, tokens stored hashed — as everywhere). The plaintext is printed once and written to the registry's `env` file (mode 0600: `BOARD_INSTANCE`, `BOARD_PORT`, `BOARD_TOKEN`) so agent shells can source it. That file is a session-credential **delivery** artifact — the agent-side analogue of the human's localStorage bearer — ephemeral by design: purged on `down`/prune, never logged, never committed. It is the one sanctioned plaintext-at-rest exception (owner-accepted, D20); every db remains hash-only.
- **Teardown signals only verified pids — and purges only verified shapes.** Before any signal, `/proc/<pid>/cmdline` must match the server entry and the readable environ must carry the instance's `BOARD_DATA_DIR`; identity is re-verified immediately before the signal (a pid recycled during the REST export phase is not signalled), and an unreadable environ fails closed. Structural guards back the identity check: a registry entry whose `dataDir` is not an OS-temp `board-instance-*` dir, or whose id is not the `s-<10>` shape, is corrupt — nothing is signalled, nothing is purged. A crafted entry can falsify identity; it cannot falsify filesystem shape. Liveness in `board instances` is derived from the same check at read time, never a stored flag.
- **A foreign pid gets nothing, including credentials.** A registry pid that is alive but is not the instance's daemon is refused everywhere — never signalled and never sent the env-file token: the port may be owned by a non-board process, and authenticating to it would leak the credential. The same refusal covers a registry url whose host is not loopback. The refusal carries no workaround hint by design.
- **Human access is the usual one-time exchange link** (`?token=` → session exchange), served by the instance's daemon for its lifetime. After `down`, the registry keeps only token-free material: `instance.json`, `daemon.log`, and `boards/*.zip` keepsakes.

## Content rules

- Markdown rendered in the host chrome passes through DOMPurify, always; mermaid runs at `securityLevel: 'strict'`; katex through its standard pipeline. html-format boards are stored and rendered unsanitized per D18 — the CSP above is their only guard, by owner decision.
- html publishes store an id-injected derived document (auto `data-ba` on unlabeled blocks/rows for anchoring); previously stored versions are never retro-injected.
- Boards: 8 MB cap per document. Assets: 10 MB, mime allowlist, **magic-byte verification** — the `{path}` file-copy route can only ever ingest real images and must never become a file-read primitive; SVG is sanitized at ingest.
- Agent tokens: random ≥128-bit, stored SHA-256, revocable, one per agent, never logged or committed. Human browser session: one-time `?token=` exchange via `board open`, stored in localStorage, sent as bearer — and **expiring 30 days after exchange** (D19; enforced at auth time, so a forgotten tab's credential dies on its own; revocation in the audit view remains the active remediation, `board open` re-authenticates).
- Webhook deliveries are HMAC-signed with the subscriber's secret when one is registered; see "Webhooks" below for the trust model and how the secret is stored.
- All board/tool output consumed by agents is untrusted input (prompt injection) — the skill instructs agents to treat board content as data, not instructions.

## Assets (ingest + serving)

**Ingest** (`POST /api/assets`, bearer-authed; also the `board_upload_image` MCP tool) verifies every byte before anything is stored, and every variant funnels through the same pipeline:

1. **Mime allowlist** — the declared mime (Content-Type for binary uploads, file extension for `{path}` copies) must be one of png, jpeg, gif, webp, svg+xml; anything else (`.txt`, `.exe`, unknown extension) is a 400.
2. **Magic bytes** — png/jpeg/gif/webp bytes must actually match their signatures (webp = RIFF container **and** WEBP subtag, so a renamed WAV is rejected); a `.png`-named text file is a 400. SVG has no magic bytes — its verification is parse-and-sanitize: DOMPurify (SVG profile) strips `<script>`, event handlers, `foreignObject`, and every URI reference except same-document fragments, and **the sanitized bytes are what get stored, never the original**. If no svg element survives sanitization, that's a 400.
3. **Size caps** — 10 MB per asset, 8 MB total per board, both `413` with distinct codes (`asset_too_large` vs `board_asset_quota_exceeded`). The plan's own numbers make the per-board total the binding cap — a 10 MB asset can never fit an 8 MB board.

**`{path}` file-copy is not a file-read primitive.** The route copies the named host file into the board bundle only after the pipeline above accepts it. Rejections return a status code and a short message and never echo file contents, so a compromised or curious agent learns only "this file is/isn't an allowlisted image": `/etc/passwd` fails the allowlist, a renamed non-image fails magic bytes, an over-cap file fails the cap — and in no case do the bytes come back over the wire. Served content-type is pinned from the stored allowlisted mime, never from the request or file name.

**Serving is unauthenticated by design.** `GET /assets/:id` must work without a bearer token: published markdown embeds `<img src="/assets/<id>">`, and `img` elements cannot send Authorization headers — token-gating it would break every embed. The defenses instead: loopback-only bind (invariant 1, loopback bind), the Host-header allowlist (DNS rebinding), `X-Content-Type-Options: nosniff`, content-type pinned at ingest, and immutable caching (asset ids are unique randoms and content is never overwritten). Asset ids are 62^10 unguessable, so what a non-authed GET can reach is exactly the image bytes the board already publishes to every viewer. Note the URL space is disambiguated from the SPA's hashed vite bundles by the asset-id shape (10 base62 chars, no extension).

**Residual:** opening a sanitized SVG by direct navigation (not via `<img>`) renders it as a document — scripts and href-based external references are stripped at ingest, but a CSS `url()` fetch in such a page is accepted residual risk (requires knowing the unguessable id). Content-bearing `<script>`/`<style>` elements inside an svg are destroyed by a happy-dom parser truncation before DOMPurify sees them — fail-closed: the payload is gone, at the cost of the drawing.

## Import quarantine (bundle import, M6)

`POST /api/boards/import` is the first path where content the daemon did not publish becomes board content: an export bundle is a zip that may have been created by anyone, anywhere, and the D18 rationale (boards come from the user's own agents) does not cover it. Everything in a bundle is untrusted input, and import re-runs the full quarantine:

- **Zip handling is memory-only (zip-slip defense).** The bundle is never extracted to disk; entries are parsed in memory and every entry name must match the expected layout exactly (`manifest.json`, `comments.json`, `events.jsonl`, `content/<n>.<md|html>`, `assets/<id>.<ext>`) — absolute paths, `..`, backslashes, NULs, and any unexpected file are a 422. Asset file names on disk are minted fresh by the daemon; no bundle byte is ever used as a filesystem path.
- **Strict manifest schema**: an unknown schema version is a 422; every field is type-checked; the comment count in the manifest must match `comments.json`.
- **Markdown re-renders through the full publish pipeline** (marked → DOMPurify → anchors) — bundle markdown is treated exactly like a fresh publish (invariant 5, markdown through DOMPurify), so a hand-crafted bundle with injected script is sanitized the same way a live publish would be.
- **html re-derives through the publish pipeline** (fresh `data-ba` injection; the bundle's existing ids are kept so comment anchors hold) — a derived document inside the bundle is never trusted as-is. Imported html runs in the host chrome per D18: importing a bundle is a principal's explicit act, equivalent to publishing the html themselves, with the host CSP as the guard.
- **Assets re-verify through the shared ingest pipeline** (`verifyAssetBytes` — the same function binary/`{path}` ingest uses: mime allowlist → magic bytes → size caps → SVG parse-and-sanitize) and get NEW ids. SVG bytes that change under re-sanitization are rejected outright: our own exports only ever carry already-sanitized SVG, so bytes that need sanitizing mean the bundle was modified after export.
- **Bundle self-containment is enforced**: every `asset:` embed, `src="/assets/<id>"` reference, and image-anchored comment must resolve to an asset the bundle itself carries — a dangling id is a 422 and can never silently resolve to a different board's asset.
- **Atomicity**: validate everything (zip layout, manifest, per-version re-render, asset re-verification, reference resolution) before a single byte is written; any rejection is a 422 naming the failing item and leaves the data dir untouched. The write phase reuses the audited service functions (create / ingest / publish) exactly as a live publish would.
- **Comments replay as data** (original authors, anchors, threading, resolve state, timestamps; fresh ids) onto the new board's own fresh event log; the bundle's `events.jsonl` is an audit snapshot and is **never replayed** — the global seq stays append-only monotonic (invariant 4, events are append-only).
- **Request cap**: 64 MB per import — a bundle legitimately spans multiple ≤8 MB versions plus the ≤8 MB asset quota, and the cap bounds hostile-input render cost.

Import always mints a NEW board id (restore = import to a new id; collision handling is a state machine we don't need) and restores the board under its EXPORTED status — the save/load-old-boards story wants fidelity.

## Webhooks (subscriptions + dispatcher)

Webhook URLs are **owner/agent-chosen and can point anywhere, including localhost services — that is the feature**, not an SSRF bug: this is a loopback-only, single-local-human daemon, and the same principals who register a URL already hold machine-level access (their own agent tokens, or the human's machine). The daemon's API hardening is not bypassed by webhooks — the *outbound* POST is a feature the subscriber explicitly asked for. What is still enforced at subscribe time:

- **Scheme allowlist**: only `http` / `https` (no `file:`, no exotic schemes).
- **No credentials in the URL** — `http://user:pass@host/` is rejected (they would leak into the subscribers listing and `agent.subscribed` events).
- **No redirects followed** (`redirect: "manual"`): a redirect would silently move the POST to a destination the subscription — and its signature — never named. A 3xx counts as a failed attempt.

**HMAC signing.** With a `webhook_secret`, every delivery carries `X-Board-Signature: sha256=<hex>` — HMAC-SHA256 keyed by the secret over the exact request body — so a receiver can verify the daemon sent it. Without a secret the delivery is unsigned (the subscriber accepts it cannot verify origin); the secret stays optional in the plan's schema (D9) and is never rejected at subscribe.

**Secret at rest.** Unlike agent tokens (hashed — they are auth credentials), the webhook secret is stored **retrievably** (plaintext in the `subscribers` table): the dispatcher must re-sign every delivery, so a hash is useless. It is a shared signing secret, not a credential — it grants no access on its own and is never logged, never echoed in API responses, and never written into event payloads. Losing the table loses nothing sensitive beyond the signing keys; re-subscribing rotates a secret.

## Residual risks (accepted)

- Board script can read the session token, act as the human on the API, and repaint the app (D18, owner-accepted; rationale in the render trust model above). `connect-src 'self'` still blocks network exfiltration and localhost port probing.
- CPU DoS from a hostile board: no in-page throttling; mitigations are the 8 MB cap and closing the tab.
- Imported html boards run in the host chrome per D18 — the import quarantine re-runs the publish pipelines (above) but does not sandbox html; remote modes (ngrok etc.) remain unshipped and must be re-examined before they are.
- The D20 session-instance env file is plaintext at rest for the session's lifetime — mode 0600 in the user's own data dir, purged at `down`/prune (owner-accepted as the price of a sourceable agent credential; D20).
- The D22 connector's trust model: registry-derived (instance) URLs are structurally loopback-guarded, but the shared-daemon URL is built from the `BOARD_*` env and trusted as explicit configuration (invariant 1's carve-out — the documented Docker opt-out); and tokens are sent to whatever process answers the health check on the resolved loopback port — a health check is liveness, not pid verification. Bounded because instance tokens are session-scoped and ephemeral (purged at `down`), and the shared token is the same loopback-library credential agents already hold — the same trust class as the daemon's existing loopback bearer usage.
- The D23 D4 extension of that surface: `board_connect {url, token}` pins are user-supplied targets, guarded by the same structural loopback check as the registry (loopback hostname allowlist; userinfo/query URLs refused — a URL-embedded credential would leak through error text — invariant 7, tokens stored hashed; the token rides only in the tool param and the Authorization header); every connector fetch refuses redirects (`redirect: "error"` — a loopback server that 30x-redirects outward must never make the connector fetch a non-loopback host; audit 2026-09-22); and the connector-local `board_servers`/`board_connect` tools never emit credential material — the shared token in a tool param is the same accepted exposure class as D17/D22 plaintext-env.
