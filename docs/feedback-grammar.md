# Feedback grammar

How an agent consumes human feedback from the board daemon — the normative spec for wiring an agent to the loop. The quickstart agent-facing behavior lives in [skills/board/SKILL.md](../skills/board/SKILL.md); that skill is the habit, this is the contract. Everything here is one consumption path by decision (D15): **comments + `since` cursor** — see [decisions.md](decisions.md) D15. Scope summary lives in [plan.md](plan.md); route shapes in [api.md](api.md).

## The loop

Publish → poll → reply/resolve → get on with the task. Async only (D3): **no blocking waits exist and none should be built** — the daemon has no wait tool, no blocking endpoint, and the human is not sitting in a chat with you.

```
cursor = 0                                   # persist last_seq across polls AND restarts
repeat up to 30 times:                       # hard cap — never poll unbounded
    res = board_get_comments(board_id, since=cursor)
    cursor = res.last_seq                    # persist BEFORE acting on the comments
    if res.comments.length > 0:
        act on them now                      # reply, fix content, re-publish
        break
    sleep 10 seconds
```

- 30 iterations × 10 s ≈ 5 minutes per poll run — run it **between task steps**, not instead of the task.
- First poll uses `since=0` (the MCP tool's default); never re-read a board's comments from scratch after the first poll — the cursor is the resume point.
- `board_get_comments` (MCP) and `GET /api/boards/:id/comments` (REST) are the same call: `{comments, last_seq}`.

## Cursor semantics (get these right)

- A comment's `seq` is the global event seq of its **creation event** — stable, monotonic, never reused (append-only events, invariant 4).
- `since` is **exclusive**: the response returns comments with `seq > since`. At-least-once, restart-safe (D13). There is **no server-side ack** — the cursor is client-held; persisting it is the agent's job (and its crash-recovery mechanism).
- `last_seq` is the board's greatest comment `seq` (0 when the board has none). Store it even when the page is empty; a poll with `since=last_seq` costs one cheap query and keeps your presence fresh.

## Thread semantics

A `Comment` is `{id, board_id, version_n, seq, anchor, body, author, in_reply_to, created_at, edited_at, resolved_at, resolved_by}` ([api.md](api.md)).

- **Root vs reply**: a root comment has `in_reply_to: null`; replies carry the parent's id and **inherit its anchor and `version_n`** — a thread is always about exactly one target. To reconstruct threads: group by walking `in_reply_to` to the root (the server's `threadRootOf` is the reference walk; it is cycle-safe).
- **Resolve state** lives on the root (`resolved_at`/`resolved_by`); replies never carry it. Resolve is idempotent — resolving an already-resolved root returns it unchanged with no second event. `board_resolve` ONLY when the feedback is actually addressed; an unresolved thread is the human's signal that work remains (the skill's rule, restated as contract).
- **Are you addressed?** There is no addressee field in the schema — directing attention at a specific agent is the `@mentions` convention on comment bodies (next section). Absent a mention, attribution is by `author`: the human is `human`, agents are their token names. You are being addressed when the thread is anchored to content **you** published — check `version_n` against the versions you published (`board_get` lists version metadata with `created_by`), and when a human reply lands in a thread **you** replied to. Anything else on a board is context, not necessarily yours to act on.

## Directing a comment at a specific agent (@mentions)

`@<principal>` anywhere in a comment body directs that comment's attention at one agent — multiple mentions are allowed in one body. The principal is the token principal: the same string that appears as `author` on comments and `created_by` on versions. That is what makes the convention self-consistent — the handle an agent is invited under is exactly the string that addresses it.

A mention directs **attention, not visibility**. Every consumer's cursor sees every comment — mentions are not private messages and cannot hide anything. One human plus trusted agents inside the loopback boundary is the trust model; there is no per-agent access control, by design.

**For the mention-typer** (the human or an agent): the board's **agent roster** is `GET /api/boards/:id/subscribers` — every cursor poll upserts the caller's row (`principal`, `kind`, `last_seq`, `last_seen`), so presence is automatic. Union it with comment authors and version creators for everyone who has ever acted on the board. `@`-autocomplete in the web composer is planned ([plan.md](plan.md), Phase 2 backlog).

**For the mentioned agent**: poll `board_get_comments?since=<cursor>` and filter bodies for `@<your-principal>` — the poll loop you already run, plus a string filter. Your handle IS your token principal, handed to you at invite along with the url and token. Webhook subscribers (`board_subscribe`) receive comment events push-delivered and filter identically — the mention filter works on both transports.

**How handles come to be (the naming model)**: handles exist from the moment of mint. The inviter either passes an explicit name (`board token add code-reviewer`) or omits it and the CLI generates a memorable one (`board token add` → `red-armadillo`). An agent can request a name in the invite negotiation — the inviter mints it. One naming authority per daemon keeps names unique and attribution history stable: renaming would be a new principal and orphan the trail, so names are permanent (D17).

Provenance: this convention was demonstrated live on 2026-09-22 — a manager mention, found by an independent agent via cursor-poll + body-filter (D23 follow-through).

## Reading anchors: finding what the human pointed at

Fetch the pinned version (`board_get` / `GET /api/boards/:id/versions/:n`) — a comment's `version_n` names the exact document its anchor was validated against. Anchor semantics are in [anchors.md](anchors.md); the agent-side recipe:

| Anchor | How to locate the target |
|---|---|
| `{type:"board"}` | the board as a whole — general feedback, no specific target |
| `{type:"section", section_id}` | the element with `data-ba="<section_id>"` in version `n`'s stored document (markdown: a top-level block, heading, or table; ids are positional `b<i>` — re-fetch the version rather than guessing from a stale copy) |
| `{type:"text", section_id, originalText, startOffset, endOffset}` | **search for `originalText` inside the section's text** — the quote is the truth; offsets are informational hints from the version of record and go stale after edits. If the quote is gone from the current content, the human's target no longer exists verbatim: re-read the section and reason about what changed (or ask in-thread via `board_reply`) |
| `{type:"row", section_id, row_id}` | the table is the `section_id` element, the row is `row_id` (`<table-id>r<j>`, header = `r1`) — or a stable author-set id |
| `{type:"image", asset_id, overlay?}` | the image at `/assets/<asset_id>` (also listed in the version's `anchors` extraction for html boards). With an overlay: the arrows/boxes mark the exact pixels — convert normalized 0..1 coordinates to pixels with the image's dimensions (`x·width`, `y·height`); arrows point head-at `(x2, y2)`, boxes are positioned labels |

Markdown source is preserved (`source_md` on the version) when you need to regenerate content rather than patch HTML.

## Webhook consumption (opt-in push)

Register per board — `board_subscribe` (MCP) or `POST /api/boards/:id/subscribe` with `{webhook_url, webhook_secret?}`. One webhook per principal per board; re-subscribing **replaces** url + secret (rotating the secret is the same call). The `agent.subscribed` event itself is delivered to your webhook — an immediate end-to-end confirmation.

**Envelope**: every board event appended after registration is POSTed as the exact event JSON:

```json
{ "seq": 42, "ts": "2026-09-16T10:00:00.000Z", "actor": "human",
  "type": "comment.created", "board_id": "aB3xY9kQ2m",
  "payload": { "comment_id": "xK9…", "version_n": 3, "anchor": { "…": "…" } } }
```

**Signature**: with a `webhook_secret`, the delivery carries

```
X-Board-Signature: sha256=<hexdigest>
```

where `<hexdigest>` is HMAC-SHA256 keyed by your secret over the **exact raw request body bytes** (not a re-serialization). Without a secret the delivery is unsigned — you accept you cannot verify origin. Verify with a constant-time compare; read the raw body before parsing:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyBoardSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  const given = header?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
  if (given === undefined) {
    return false;
  }
  const mac = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(given, "hex"));
}
```

Respond `2xx` for success; anything else — non-2xx, network error, **or a 3xx** (redirects are never followed) — is a failed attempt.

**Retry / dead-letter**: 3 attempts per delivery with exponential backoff (500 ms, then 2 s), serialized per subscription (a slow or failing endpoint delays — and cannot reorder — its own stream). A delivery is fire-and-forget from the daemon's side: event appends never wait on it. After the final failure the daemon appends a `webhook.failed` **dead-letter event** (`payload`: `subscription_id`, `subscriber`, `webhook_url`, `event_seq`, `event_type`, `attempts`, `error`) to the global + board logs — visible via `GET /api/events?type=webhook.failed` — and never delivers that event itself (no fail-about-a-failure loop).

**Push is best-effort; the cursor is the reliable baseline** (D9). The robust pattern: use the webhook as a wake-up signal, then catch up through the cursor — on delivery, run the poll loop's single iteration (`since=cursor`) instead of trusting the POST alone; deliveries are at-least-once and your handler may see the same event twice.

## Presence (how the board knows you're listening)

Presence is derived from real behavior, not heartbeats you must remember to send — with one code-level precision: **cursor polls and webhook registrations are stamped; SSE connections are not** (an SSE connection is delivery only — the plan-schema's never-written `sse` subscriber kind was removed from the domain in D19).

- Every **agent-token** poll of comments (`board_get_comments` or the REST route) upserts a `subscribers` row for you on that board (`kind: cursor`) with `last_seq` = the board's max comment seq and a fresh `last_seen`. Human polls do not stamp presence.
- A webhook subscription is a `kind: webhook` row, refreshed on every successful delivery.
- `GET /api/boards/:id/subscribers` lists who is listening and how (`principal`, `kind`, `webhook_url`, `last_seq`, `last_seen`); the board list carries `subscriber_count`. Secrets are never selected, never echoed.

## The REST-only extra: the feedback report

`GET /api/boards/:id/feedback?since=` renders unresolved threads as the feedback **markdown grammar** (numbered items, anchor descriptors, quoted text, nested replies, resolve state). It is deliberately not an MCP tool (D15) — use it for human-readable digests and reports; your machine consumption stays on the cursor.
