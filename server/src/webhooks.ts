// Webhook subscriptions + dispatcher (M5 remainder, docs/plan.md "Subscriptions,
// callbacks & presence", D9): one webhook per principal per board, deliveries are
// HMAC-signed POSTs of the event envelope with 3 attempts + exponential backoff,
// and final failures append a `webhook.failed` dead-letter event.
import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { requireBoard, StoreError } from "./boards.ts";
import type { BoardEvent, Subscriber } from "./domain.ts";
import { errText } from "./err-text.ts";
import { appendEventDb, mirrorEventFiles } from "./events.ts";
import { shortId } from "./ids.ts";

export class InvalidWebhookUrl extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWebhookUrl";
  }
}

export class SubscriptionNotFound extends StoreError {
  constructor(boardId: string, principal: string) {
    super(`${principal} has no webhook subscription on board "${boardId}"`);
    this.name = "SubscriptionNotFound";
  }
}

// http/https only; embedded credentials rejected (they would leak through the
// subscribers listing and event payloads). Loopback-target URLs are allowed by
// design — the trust reasoning lives in docs/security.md ("Webhooks").
export function validateWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidWebhookUrl("webhook_url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidWebhookUrl("webhook_url must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidWebhookUrl("webhook_url must not embed credentials");
  }
  return raw;
}

export interface SubscribeInput {
  webhook_url: string;
  webhook_secret?: string;
  actor: string;
}

export interface WebhookSubscription {
  id: string;
  board_id: string;
  principal: string;
  webhook_url: string;
  created_seq: number;
}

// Register (or replace) the caller's webhook subscription. The subscription is
// stamped with the seq of its `agent.subscribed` event, and that event is
// delivered to the new webhook like any other board event — an immediate
// end-to-end confirmation ping. Secret handling per docs/security.md
// ("Webhooks"): stored retrievably (the dispatcher must re-sign on every
// delivery), never logged, never echoed in API responses or events.
export function subscribeWebhook(
  db: Database,
  dataDir: string,
  boardId: string,
  input: SubscribeInput,
): WebhookSubscription {
  requireBoard(db, boardId);
  validateWebhookUrl(input.webhook_url);
  const id = shortId();
  const write = db.transaction(() => {
    const ev = appendEventDb(db, {
      actor: input.actor,
      type: "agent.subscribed",
      boardId,
      payload: { kind: "webhook", webhook_url: input.webhook_url },
    });
    // One webhook per principal per board (PK board_id + agent + kind): a
    // re-subscribe REPLACES url + secret rather than stacking rows — the
    // newest registration is the live one and there is no unsubscribe-all
    // ambiguity to reason about.
    db.prepare(
      `INSERT INTO subscribers (board_id, agent, kind, webhook_url, secret, id, last_seq, last_seen)
       VALUES (?, ?, 'webhook', ?, ?, ?, ?, ?)
       ON CONFLICT (board_id, agent, kind) DO UPDATE SET
         webhook_url = excluded.webhook_url,
         secret = excluded.secret,
         id = excluded.id,
         last_seq = excluded.last_seq,
         last_seen = excluded.last_seen`,
    ).run(
      boardId,
      input.actor,
      input.webhook_url,
      input.webhook_secret ?? null,
      id,
      ev.seq,
      new Date().toISOString(),
    );
    return ev;
  });
  const ev = write();
  mirrorEventFiles(dataDir, ev);
  return {
    id,
    board_id: boardId,
    principal: input.actor,
    webhook_url: input.webhook_url,
    created_seq: ev.seq,
  };
}

export function unsubscribeWebhook(
  db: Database,
  boardId: string,
  actor: string,
): void {
  requireBoard(db, boardId);
  const res = db
    .prepare(
      "DELETE FROM subscribers WHERE board_id = ? AND agent = ? AND kind = 'webhook'",
    )
    .run(boardId, actor);
  if (res.changes === 0) {
    throw new SubscriptionNotFound(boardId, actor);
  }
}

// Merged presence view (docs/plan.md GET /boards/:id/subscribers): the webhook
// registry plus auto-detected cursor presence rows (D19 — the `sse` kind was
// never written; see domain.ts SubscriberKind). The secret column is
// deliberately never selected — it must not leave the signing path.
export function listSubscribers(db: Database, boardId: string): Subscriber[] {
  const rows = db
    .prepare(
      "SELECT id, board_id, agent, kind, webhook_url, last_seq, last_seen FROM subscribers WHERE board_id = ? ORDER BY last_seen DESC, agent ASC",
    )
    .all(boardId) as Array<{
    id: string | null;
    board_id: string;
    agent: string;
    kind: string;
    webhook_url: string | null;
    last_seq: number;
    last_seen: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    board_id: row.board_id,
    principal: row.agent,
    kind: row.kind as Subscriber["kind"],
    webhook_url: row.webhook_url,
    last_seq: row.last_seq,
    last_seen: row.last_seen,
  }));
}

// Live subscriber counts for the board list (docs/plan.md REST API "live
// subscriber count" — shipped with the M7 audit work): every registry row
// counts, webhook subscriptions and auto-detected cursor presence rows
// alike. One grouped query; boards with no rows default to 0 at the consumer.
export function countSubscribersByBoard(db: Database): Map<string, number> {
  const rows = db
    .prepare(
      "SELECT board_id, COUNT(*) AS c FROM subscribers GROUP BY board_id",
    )
    .all() as Array<{ board_id: string; c: number }>;
  return new Map(rows.map((row) => [row.board_id, row.c]));
}

// 3 delivery attempts total (1 + 2 retries); default backoff after failure 1
// is 500ms, after failure 2 is 2s (docs/plan.md; D9).
export const WEBHOOK_MAX_ATTEMPTS = 3;
export const WEBHOOK_BACKOFF_BASE_MS = 500;

export function defaultBackoffMs(failedAttempts: number): number {
  return WEBHOOK_BACKOFF_BASE_MS * 4 ** (failedAttempts - 1);
}

export interface DispatcherOptions {
  // failedAttempts (1-based) → ms to sleep before the next attempt;
  // injectable so tests don't sleep through real backoffs.
  backoffMs?: (failedAttempts: number) => number;
}

interface WebhookTarget {
  board_id: string;
  agent: string;
  id: string | null;
  webhook_url: string;
  secret: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fire-and-forget dispatcher with per-subscription serialization: an event
// append never waits on a webhook delivery, but deliveries to one subscriber
// are queued in order so a slow endpoint can't reorder its event stream.
// Returns the onEvent callback; dispose by dropping the returned unsubscribe.
export function startWebhookDispatcher(
  db: Database,
  dataDir: string,
  opts: DispatcherOptions = {},
): (ev: BoardEvent) => void {
  const backoffMs = opts.backoffMs ?? defaultBackoffMs;
  const inflight = new Map<string, Promise<void>>();

  async function deliver(target: WebhookTarget, ev: BoardEvent): Promise<void> {
    // The envelope is signed over the exact bytes on the wire.
    const body = JSON.stringify(ev);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    // Secret-less subscriptions get unsigned deliveries (D9 keeps the secret
    // optional in the plan's schema): there is nothing to verify origin with,
    // which the subscriber accepts by registering without one.
    if (target.secret !== null && target.secret.length > 0) {
      const mac = createHmac("sha256", target.secret)
        .update(body)
        .digest("hex");
      headers["X-Board-Signature"] = `sha256=${mac}`;
    }
    let lastError = "delivery failed";
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await sleep(backoffMs(attempt - 1));
      }
      try {
        // No redirects followed: a redirect would silently move the POST to a
        // destination the subscription (and its signature) never named — a 3xx
        // counts as failure instead (docs/security.md "Webhooks").
        const res = await fetch(target.webhook_url, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
        });
        if (res.ok) {
          db.prepare(
            "UPDATE subscribers SET last_seq = ?, last_seen = ? WHERE board_id = ? AND agent = ? AND kind = 'webhook'",
          ).run(
            ev.seq,
            new Date().toISOString(),
            target.board_id,
            target.agent,
          );
          return;
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = errText(err);
      }
    }
    // Dead-letter (docs/plan.md): an audit marker in the global + board event
    // log, attributed to the subscriber whose endpoint failed. Never delivered
    // onward — the dispatcher skips `webhook.failed`, which also breaks the
    // loop where delivering the dead-letter about a dead endpoint fails again.
    const write = db.transaction(() =>
      appendEventDb(db, {
        actor: target.agent,
        type: "webhook.failed",
        boardId: target.board_id,
        payload: {
          subscription_id: target.id,
          subscriber: target.agent,
          webhook_url: target.webhook_url,
          event_seq: ev.seq,
          event_type: ev.type,
          attempts: WEBHOOK_MAX_ATTEMPTS,
          error: lastError,
        },
      }),
    );
    mirrorEventFiles(dataDir, write());
  }

  function enqueue(target: WebhookTarget, ev: BoardEvent): void {
    const key = `${target.board_id}\u0000${target.agent}`;
    const next = (inflight.get(key) ?? Promise.resolve()).then(() =>
      deliver(target, ev),
    );
    // deliver() cannot reject; the catch is belt-and-braces so a programming
    // error degrades to a dropped delivery, never an unhandled rejection.
    const settled = next.catch(() => {});
    inflight.set(key, settled);
    void settled.then(() => {
      if (inflight.get(key) === settled) {
        inflight.delete(key);
      }
    });
  }

  return (ev: BoardEvent) => {
    if (ev.type === "webhook.failed" || ev.board_id === null) {
      return;
    }
    const targets = db
      .prepare(
        "SELECT board_id, agent, id, webhook_url, secret FROM subscribers WHERE board_id = ? AND kind = 'webhook'",
      )
      .all(ev.board_id) as WebhookTarget[];
    for (const target of targets) {
      if (target.webhook_url !== null) {
        enqueue(target, ev);
      }
    }
  };
}
