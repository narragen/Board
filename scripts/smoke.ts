// M7 final smoke + M8 session wave (docs/plan.md "Milestones"): one command,
// full loop, self-verifying. Steps 1–15 walk the feedback-grammar loop
// (docs/feedback-grammar.md) as three principals against a throwaway daemon;
// steps 16–21 drive the D20 session-instance loop the way an agent does —
// through the real CLI (`board up` → REST iterate → `board instances` →
// `board down`) with BOARD_DATA_DIR pointed at this smoke's temp registry —
// step 19 proves the D22 stdio connector (spawned as plain `node`, no bun
// on PATH) resolves the live session instance over MCP, and step 20 proves
// the D23 D4 discovery + explicit connect: a second agent's connector
// process runs `board_servers` (finds both servers, boards where a
// credential exists, no secrets) and `board_connect` (pins by instance id,
// then by {url, token} — the pinned publish lands on the pinned daemon, not
// the auto-resolution favorite).
// Temp data dir + scratch ports throughout (never the real ~/.board or :7800
// — AGENTS.md invariant); asserts every step; prints SMOKE PASS/FAIL, exits
// 0/1.
//
// Run: bun scripts/smoke.ts (or `make smoke`).

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type InstancePaths,
  instancePaths,
  readEnvToken,
  readInstanceEntry,
  spawnInstance,
  teardownInstance,
} from "../cli/src/instances.ts";
import { openDb } from "../server/src/db.ts";
import type {
  Board,
  BoardEvent,
  Comment,
  Version,
  VersionMeta,
} from "../server/src/domain.ts";
import { createExchangeToken } from "../server/src/sessions.ts";

// Receiver-side verification of the `X-Board-Signature` webhook header — the
// exact recipe from docs/feedback-grammar.md ("Webhook consumption"): HMAC-
// SHA256 keyed by the subscription secret over the EXACT raw body bytes,
// constant-time compare. Exported for scripts/smoke.test.ts.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-tolerant await: poll until the predicate holds or the deadline passes —
// no fixed sleeps, so the smoke is fast on a warm machine and never flakes on
// a slow one (deliveries are async by design; see awaitDelivery).
async function waitFor<T>(
  what: string,
  fn: () => T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(250);
  }
}

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) {
    throw new Error(message);
  }
}

interface Delivery {
  event: BoardEvent | null;
  raw: Buffer;
  sigOk: boolean;
}

// The simulated consumer's webhook endpoint: records every POST and verifies
// the signature over the raw bytes. Ephemeral port (Bun.serve port 0) — the
// same scratch-port pattern the daemon side uses.
function startReceiver(secret: string): {
  url: string;
  deliveries: Delivery[];
  stop(): void;
} {
  const deliveries: Delivery[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const raw = Buffer.from(await req.arrayBuffer());
      let event: BoardEvent | null = null;
      // A body that doesn't parse as the event envelope stays null: the
      // awaiter's predicate simply never matches it, and the failure surfaces
      // as the step's timeout instead of a receiver crash.
      try {
        event = JSON.parse(raw.toString()) as BoardEvent;
      } catch {
        // not the envelope — recorded, never crashes the receiver
      }
      deliveries.push({
        event,
        raw,
        sigOk: verifyBoardSignature(
          secret,
          raw,
          req.headers.get("x-board-signature") ?? undefined,
        ),
      });
      return new Response("ok");
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/webhook`,
    deliveries,
    stop: () => server.stop(true),
  };
}

// The daemon's stdout/stderr readiness seam (readListenLine + the stderr
// tail collector it fed) is GONE as of the wave-2 refactor: the daemon is
// spawned by cli/src/instances.ts's spawnInstance, whose waitForListenLine
// matches the SAME hoisted LISTEN_LINE pattern from server/src/main.ts, and
// both streams land in the registry's daemon.log for the FAIL path.

const V1_MD = [
  "# Release plan",
  "",
  "## Deployment checklist",
  "",
  "The rollout must wait for the migration to finish.",
  "",
  "- [ ] freeze deploys",
  "- [ ] run the smoke",
  "",
].join("\n");

const V2_MD = V1_MD.replace(
  "The rollout must wait for the migration to finish.",
  "The rollout overlaps the migration — ops signed off in the resolved thread.",
);

// The session wave's fixture (steps 16–19): a small markdown file, published
// as v1 by `board up` and iterated to v2 over REST.
const SESSION_MD = [
  "# Session review",
  "",
  "## Ship criteria",
  "",
  "The board loop needs a human sign-off before merge.",
  "",
].join("\n");

const SESSION_MD_V2 = SESSION_MD.replace(
  "needs a human sign-off",
  "got the human sign-off",
);

// Step 19's connector publish — v3 lands through the D22 stdio connector.
const SESSION_MD_V3 = SESSION_MD_V2.replace(
  "got the human sign-off",
  "got the human sign-off — v3 published through the D22 MCP connector",
);

// The D23 D4 step's pinned publish — v3 on the release-plan board, landing on
// the SMOKE daemon through the pinned beta connector while the session
// instance (the auto-resolution favorite) is still live.
const V3_MD = V2_MD.replace(
  "- [ ] run the smoke",
  "- [x] run the smoke — D23 D4 explicit connect verified",
);

// The `board up` output contract (the same lines cli/src/instances.test.ts
// parses): id/url/token/env/human-link, plus the board id from the link.
interface InstanceUp {
  id: string;
  url: string;
  token: string;
  envPath: string;
  human: string;
  boardId: string;
}

function parseInstanceUp(stdout: string): InstanceUp {
  const head =
    /instance (s-[0-9A-Za-z]{10}) listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(
      stdout,
    );
  const token =
    /^agent token \(print once — it is not recoverable\): (\S+)$/m.exec(
      stdout,
    )?.[1];
  const envPath =
    /^credentials env file \(agent shells: source it\): (.+)$/m.exec(
      stdout,
    )?.[1];
  const human = /^human link: (.+)$/m.exec(stdout)?.[1];
  const boardId = /#\/boards\/([0-9A-Za-z]{10})/.exec(human ?? "")?.[1];
  if (
    head === null ||
    token === undefined ||
    envPath === undefined ||
    human === undefined ||
    boardId === undefined
  ) {
    throw new Error(`could not parse board up output:\n${stdout}`);
  }
  return {
    id: head[1] ?? "",
    url: head[2] ?? "",
    token,
    envPath,
    human,
    boardId,
  };
}

function payloadId(ev: BoardEvent | null | undefined, key: string): string {
  const value = ev?.payload[key];
  return typeof value === "string" ? value : "";
}

// The D22 connector acceptance driver: spawn the REAL stdio connector the way
// agent harnesses do (plain `node`, no bun anywhere on the child's PATH — the
// wave-1 constraint that keeps the connector node-runnable), speak
// newline-delimited JSON-RPC, and tear it down at EOF. Every reply is
// deadline-bounded so a silent connector fails the step instead of hanging
// the smoke.
function startConnector(env: Record<string, string>) {
  const node = Bun.which("node");
  assert(
    node !== null,
    "node not found on PATH — the D22 connector wiring needs it",
  );
  const proc = Bun.spawn(
    [node, join(import.meta.dir, "..", "cli", "src", "mcp-connector.ts")],
    { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function nextLine(): Promise<string> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length > 0) {
          return line;
        }
        continue; // skip empty framing lines
      }
      if (Date.now() > deadline) {
        throw new Error("connector did not answer within 10s");
      }
      const chunk = (await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1_000)),
      ])) as Awaited<ReturnType<typeof reader.read>> | "timeout";
      if (chunk === "timeout") {
        continue;
      }
      if (chunk.done) {
        throw new Error("connector stdout closed before a reply");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return {
    // One JSON-RPC request → the parsed response line.
    async rpc(
      id: number,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
      proc.stdin.flush();
      return JSON.parse(await nextLine()) as Record<string, unknown>;
    },
    // Tear down: EOF on stdin is the connector's clean-shutdown path.
    async end(): Promise<number> {
      proc.stdin.end();
      return (await proc.exited) ?? -1;
    },
  };
}

// The opencode-shaped child env for connector spawns: node on PATH with bun
// stripped (the connector is node-runnable by design — D22), ambient BOARD_*
// credentials deleted, then the caller's BOARD_* overrides applied. Both
// connector-driving steps (D22's instance loop and D23 D4's discovery +
// connect) spawn through this so their env shapes stay identical.
function connectorChildEnv(
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const bunDir =
    Bun.which("bun") !== null ? dirname(Bun.which("bun") as string) : null;
  const pathNoBun = (process.env.PATH ?? "")
    .split(":")
    .filter((p) => p.length > 0 && (bunDir === null || p !== bunDir))
    .join(":");
  assert(
    pathNoBun.length > 0,
    "PATH without bun resolved empty — cannot spawn the connector",
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  env.PATH = pathNoBun;
  delete env.BOARD_MCP_TOKEN;
  delete env.BOARD_INSTANCE;
  delete env.BOARD_TOKEN;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  return env;
}

// A loopback port with nothing on it (grab-and-release) — the "shared daemon
// down" fixture for the D23 D4 step's connector env.
function closedPort(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port; // kernel-assigned; typed number | undefined
  server.stop(true);
  assert(typeof port === "number", "kernel did not assign a scratch port");
  return port;
}

async function run(): Promise<0 | 1> {
  const dataDir = mkdtempSync(join(tmpdir(), "board-smoke-"));
  console.log(`board smoke: temp data dir ${dataDir}`);

  // The subscriber picks its secret (docs/feedback-grammar.md); a fixed value
  // keeps runs reproducible and the receiver's verification honest.
  const secret = "smoke-webhook-secret";
  const receiver = startReceiver(secret);

  let baseUrl = "";
  let spawned: Awaited<ReturnType<typeof spawnInstance>> | undefined;
  let smokePaths: InstancePaths | undefined;
  // The CLI-spawned session instance (steps 16–19) — its id is all the
  // finally-block needs to find the registry entry and, if the smoke died
  // before `board down`, tear it down itself.
  let sessionId: string | undefined;
  let lastResponse: { status: number; body: string } | undefined;
  let stepNo = 0;
  let stepLabel = "";

  // The response is buffered once (status + exact body text): the same bytes
  // feed both the FAIL-path report and json<T>() — a body can be read once.
  async function api(
    method: "GET" | "POST" | "DELETE",
    path: string,
    token: string | undefined,
    body?: unknown,
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = { status: res.status, body: await res.text() };
    lastResponse = result;
    return result;
  }

  // Run the real CLI as a subprocess (the agent's-eye view for the session
  // wave): the operator's BOARD_INSTANCE/BOARD_TOKEN must not leak into the
  // smoke's targeting or credentials, and BOARD_DATA_DIR pins the registry to
  // this smoke's temp dir.
  async function cli(args: string[]): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }
    env.BOARD_DATA_DIR = dataDir;
    delete env.BOARD_INSTANCE;
    delete env.BOARD_TOKEN;
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "cli", "src", "main.ts"),
        ...args,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: code ?? -1, stdout, stderr };
  }

  function json<T>(res: { body: string }): T {
    return JSON.parse(res.body) as T;
  }

  function expectStatus(
    res: { status: number },
    status: number,
    what: string,
  ): void {
    if (res.status !== status) {
      throw new Error(
        `${what}: expected HTTP ${status}, got ${res.status} — ${lastResponse?.body.slice(0, 500) ?? "(no body)"}`,
      );
    }
  }

  // Each step runs, prints its `ok N` line, and hands its value to the next
  // step — a step that throws fails the smoke with its own number/label.
  async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    stepNo += 1;
    stepLabel = label;
    lastResponse = undefined;
    const value = await fn();
    console.log(`ok ${stepNo} ${label}`);
    return value;
  }

  // Deliveries are fire-and-forget with per-subscription serialization
  // (docs/feedback-grammar.md): the event is already committed when the
  // daemon turns to POST it, so the receiver polls its own buffer on a short
  // cadence with a deadline instead of the script guessing a fixed sleep.
  function awaitDelivery(
    what: string,
    pred: (d: Delivery) => boolean,
  ): Promise<Delivery> {
    return waitFor(what, () => receiver.deliveries.find(pred));
  }

  try {
    // The spawn refactor (wave 2): the hand-rolled mint + Bun.spawn +
    // readListenLine above is gone — spawnInstance is the ONE spawn path,
    // shared with `board up`. Same guarantees, one implementation: OS-temp
    // data dir, kernel-assigned port (scratch ports end to end), loopback
    // bind + Host allowlist pinned over inherited env, mint-before-spawn —
    // both agent tokens minted in the SAME pre-spawn db session (one
    // open/close window, no boot-time WAL race). [D20]
    spawned = await spawnInstance({
      registryDataDir: dataDir,
      agentTokenName: "smoke-alpha",
      extraAgentTokenNames: ["smoke-beta"],
    });
    smokePaths = instancePaths(dataDir, spawned.entry.id);
    baseUrl = spawned.entry.url;
    const alpha = spawned.token;
    const beta = spawned.extraTokens[0] ?? "";
    console.log(
      `board smoke: daemon ${baseUrl}, webhook receiver ${receiver.url}`,
    );

    // The exchange token cannot ride the pre-spawn db session (that session
    // lives inside spawnInstance and mints agent tokens only), and there is
    // no REST route for it by design (docs/api.md) — so it is minted
    // post-health, direct on the live daemon's temp db: the same sanctioned
    // local-db exception `board open --instance` rides (openDb's
    // busy_timeout covers the concurrent live writer). [D20 wave 2]
    const exDb = openDb(spawned.entry.dataDir);
    let exchange = "";
    try {
      exchange = createExchangeToken(exDb);
    } finally {
      exDb.close();
    }

    await step("daemon healthy", async () => {
      const res = await api("GET", "/api/health", undefined);
      expectStatus(res, 200, "health");
      assert((await json<{ ok: boolean }>(res)).ok === true, "health not ok");
    });

    const board = await step("board created (smoke-alpha)", async () => {
      const res = await api("POST", "/api/boards", alpha, {
        title: "M7 smoke — release plan",
        format: "markdown",
      });
      expectStatus(res, 201, "create board");
      const created = await json<Board>(res);
      assert(
        created.id.length > 0 &&
          created.current_version === 0 &&
          created.created_by === "smoke-alpha",
        `unexpected board shape: ${JSON.stringify(created)}`,
      );
      return created;
    });

    const { sectionId, quote } = await step(
      "v1 published (markdown)",
      async () => {
        const res = await api(
          "POST",
          `/api/boards/${board.id}/publish`,
          alpha,
          {
            format: "markdown",
            content: V1_MD,
            expected_version: 0,
            label: "initial draft",
          },
        );
        expectStatus(res, 201, "publish v1");
        const v1 = await json<Version>(res);
        assert(v1.n === 1, `expected version 1, got n=${v1.n}`);
        // The heading's extracted anchor is the comment target: render.ts
        // sets a heading's label to its textContent, and anchor validation
        // matches the quote against that same textContent — a quote that
        // cannot miss.
        const heading = v1.anchors.find(
          (a) => a.kind === "heading" && a.label === "Deployment checklist",
        );
        assert(
          heading !== undefined,
          `heading anchor missing from v1 anchors: ${JSON.stringify(v1.anchors)}`,
        );
        assert(
          typeof heading.label === "string" && heading.label.length > 0,
          "heading anchor should carry its text as label",
        );
        return { sectionId: heading.id, quote: heading.label };
      },
    );

    await step(
      "beta subscribed — agent.subscribed delivered and signed",
      async () => {
        const res = await api(
          "POST",
          `/api/boards/${board.id}/subscribe`,
          beta,
          { webhook_url: receiver.url, webhook_secret: secret },
        );
        expectStatus(res, 201, "beta subscribe");
        const sub = await json<{
          id: string;
          principal: string;
          created_seq: number;
        }>(res);
        assert(
          sub.principal === "smoke-beta",
          `subscription principal should be smoke-beta, got ${sub.principal}`,
        );
        // The subscription's own event is delivered to the new webhook — the
        // immediate end-to-end confirmation (docs/feedback-grammar.md).
        const delivery = await awaitDelivery(
          "agent.subscribed delivery",
          (d) => d.event?.type === "agent.subscribed",
        );
        assert(
          delivery.sigOk,
          "agent.subscribed delivery signature did not verify",
        );
        assert(
          delivery.event?.seq === sub.created_seq,
          `agent.subscribed seq mismatch: delivery ${delivery.event?.seq} vs created_seq ${sub.created_seq}`,
        );
      },
    );

    const humanToken = await step("human session exchanged", async () => {
      const res = await api("POST", "/api/session/exchange", undefined, {
        token: exchange,
      });
      expectStatus(res, 200, "session exchange");
      const session = await json<{ token: string }>(res);
      assert(
        session.token.length > 0 && session.token !== exchange,
        "exchange should mint a fresh session token",
      );
      return session.token;
    });

    const comment = await step(
      "human comment posted (text anchor)",
      async () => {
        const res = await api(
          "POST",
          `/api/boards/${board.id}/comments`,
          humanToken,
          {
            // Richest anchor the API accepts without a rendered DOM: the
            // server validates the quote against v1's stored section.
            anchor: {
              type: "text",
              section_id: sectionId,
              originalText: quote,
              startOffset: 0,
              endOffset: quote.length,
            },
            body: "Does the rollout really need to wait for the migration? Ops signed off on overlap.",
            version_n: 1,
          },
        );
        expectStatus(res, 201, "human comment");
        const created = await json<Comment>(res);
        assert(
          created.author === "human" &&
            created.in_reply_to === null &&
            created.seq > 0 &&
            created.resolved_at === null,
          `unexpected comment shape: ${JSON.stringify(created)}`,
        );
        assert(
          created.anchor.type === "text",
          "anchor should round-trip as text",
        );
        return created;
      },
    );

    const cursor = await step(
      "alpha consumed the comment via the cursor (since=0)",
      async () => {
        const res = await api(
          "GET",
          `/api/boards/${board.id}/comments?since=0`,
          alpha,
        );
        expectStatus(res, 200, "cursor poll");
        const page = await json<{ comments: Comment[]; last_seq: number }>(res);
        assert(
          page.comments.length === 1 && page.comments[0]?.id === comment.id,
          `first poll should see exactly the human comment: ${JSON.stringify(page.comments)}`,
        );
        assert(
          page.last_seq === comment.seq,
          `last_seq should be the comment's seq: ${page.last_seq} vs ${comment.seq}`,
        );
        return page.last_seq;
      },
    );

    await step("webhook: comment.created delivered and signed", async () => {
      const delivery = await awaitDelivery(
        "comment.created delivery",
        (d) => d.event?.type === "comment.created",
      );
      assert(
        delivery.sigOk,
        "comment.created delivery signature did not verify",
      );
      assert(
        payloadId(delivery.event, "comment_id") === comment.id,
        "comment.created delivery should name the human comment",
      );
    });

    const reply = await step(
      "alpha replied (addressed feedback → act)",
      async () => {
        const res = await api(
          "POST",
          `/api/comments/${comment.id}/reply`,
          alpha,
          {
            body: "Waiting on the migration — re-publishing with the ordering fixed.",
          },
        );
        expectStatus(res, 201, "alpha reply");
        const created = await json<Comment>(res);
        assert(
          created.in_reply_to === comment.id &&
            created.author === "smoke-alpha",
          `unexpected reply shape: ${JSON.stringify(created)}`,
        );
        assert(
          JSON.stringify(created.anchor) === JSON.stringify(comment.anchor) &&
            created.version_n === comment.version_n,
          "reply must inherit the parent's anchor + version_n (thread semantics)",
        );
        return created;
      },
    );

    await step("webhook: comment.replied delivered and signed", async () => {
      const delivery = await awaitDelivery(
        "comment.replied delivery",
        (d) => d.event?.type === "comment.replied",
      );
      assert(
        delivery.sigOk,
        "comment.replied delivery signature did not verify",
      );
      assert(
        payloadId(delivery.event, "parent_id") === comment.id,
        "comment.replied delivery should name the parent comment",
      );
    });

    await step("human resolved the thread", async () => {
      const res = await api(
        "POST",
        `/api/comments/${comment.id}/resolve`,
        humanToken,
        {},
      );
      expectStatus(res, 200, "resolve");
      const resolved = await json<Comment>(res);
      assert(
        resolved.resolved_at !== null && resolved.resolved_by === "human",
        `resolve should stamp resolved_at/resolved_by on the root: ${JSON.stringify(resolved)}`,
      );
    });

    await step(
      "alpha's next cursor poll consumed the reply + resolved state",
      async () => {
        // Cursor continuation: since is exclusive, so the reply (not yet
        // consumed) is exactly what comes back.
        const nextRes = await api(
          "GET",
          `/api/boards/${board.id}/comments?since=${cursor}`,
          alpha,
        );
        expectStatus(nextRes, 200, "next cursor poll");
        const nextPage = await json<{ comments: Comment[]; last_seq: number }>(
          nextRes,
        );
        assert(
          nextPage.comments.length === 1 &&
            nextPage.comments[0]?.id === reply.id,
          `next poll should consume exactly the reply: ${JSON.stringify(nextPage.comments)}`,
        );
        // Resolve mutates the ROOT row, whose seq is already behind alpha's
        // cursor — an exclusive poll can never re-surface it (docs/
        // feedback-grammar.md "Cursor semantics"), so the resolved state is
        // checked on a fresh since=0 read of the same cursor endpoint.
        const backRes = await api(
          "GET",
          `/api/boards/${board.id}/comments?since=0`,
          alpha,
        );
        expectStatus(backRes, 200, "catch-up poll");
        const back = await json<{ comments: Comment[]; last_seq: number }>(
          backRes,
        );
        assert(
          back.comments.length === 2,
          `catch-up poll should see the whole thread, got ${back.comments.length}`,
        );
        const backRoot = back.comments.find((c) => c.id === comment.id);
        const backReply = back.comments.find((c) => c.id === reply.id);
        assert(
          backRoot !== undefined &&
            backRoot.resolved_at !== null &&
            backRoot.resolved_by === "human",
          "resolved state should be visible on the root comment",
        );
        assert(
          backReply !== undefined &&
            backReply.in_reply_to === comment.id &&
            backReply.resolved_at === null,
          "replies never carry resolve state — it lives on the root",
        );
      },
    );

    await step("webhook: comment.resolved delivered and signed", async () => {
      const delivery = await awaitDelivery(
        "comment.resolved delivery",
        (d) => d.event?.type === "comment.resolved",
      );
      assert(
        delivery.sigOk,
        "comment.resolved delivery signature did not verify",
      );
      assert(
        payloadId(delivery.event, "comment_id") === comment.id,
        "comment.resolved delivery should name the resolved thread",
      );
      // Serialized per subscription (docs/feedback-grammar.md): arrival order
      // is event order, and every delivery must verify.
      const seen = receiver.deliveries.map(
        (d) => d.event?.type ?? "(unparseable)",
      );
      assert(
        JSON.stringify(seen) ===
          JSON.stringify([
            "agent.subscribed",
            "comment.created",
            "comment.replied",
            "comment.resolved",
          ]),
        `receiver should have seen the four events in order, got: ${seen.join(", ")}`,
      );
      assert(
        receiver.deliveries.every((d) => d.sigOk),
        "every webhook delivery must carry a valid signature",
      );
    });

    await step("audit trail: the whole chain in order", async () => {
      const res = await api("GET", `/api/events?board_id=${board.id}`, alpha);
      expectStatus(res, 200, "events");
      const log = await json<{ events: BoardEvent[]; last_seq: number }>(res);
      const types = log.events.map((e) => e.type);
      assert(
        JSON.stringify(types) ===
          JSON.stringify([
            "board.created",
            "board.published",
            "agent.subscribed",
            "comment.created",
            "comment.replied",
            "comment.resolved",
          ]),
        `audit chain out of order: ${types.join(" → ")}`,
      );
      const actors = log.events.map((e) => e.actor);
      assert(
        JSON.stringify(actors) ===
          JSON.stringify([
            "smoke-alpha",
            "smoke-alpha",
            "smoke-beta",
            "human",
            "smoke-alpha",
            "human",
          ]),
        `event actors unexpected: ${actors.join(", ")}`,
      );
      const deadRes = await api(
        "GET",
        "/api/events?type=webhook.failed",
        alpha,
      );
      const dead = await json<{ events: BoardEvent[] }>(deadRes);
      assert(
        dead.events.length === 0,
        "no webhook.failed dead-letters expected — every delivery verified",
      );
    });

    await step(
      "v2 published (loop versioned once more, API-level)",
      async () => {
        const res = await api(
          "POST",
          `/api/boards/${board.id}/publish`,
          alpha,
          {
            format: "markdown",
            content: V2_MD,
            expected_version: 1,
            label: "after human feedback",
            note: "addresses the resolved thread",
          },
        );
        expectStatus(res, 201, "publish v2");
        const v2 = await json<Version>(res);
        assert(v2.n === 2, `expected version 2, got n=${v2.n}`);
        const boardRes = await api("GET", `/api/boards/${board.id}`, alpha);
        expectStatus(boardRes, 200, "board get");
        const view = await json<{ board: Board; versions: VersionMeta[] }>(
          boardRes,
        );
        assert(
          view.board.current_version === 2 && view.versions.length === 2,
          `board should be at v2 with two versions: current=${view.board.current_version}, versions=${view.versions.length}`,
        );
      },
    );

    // --- M8 session wave (D20): the loop an agent actually runs, through the
    // real CLI as subprocesses with BOARD_DATA_DIR pointed at THIS smoke's
    // temp registry (never ~/.board) — up → REST iterate → instances → down.

    const session = await step(
      "session instance up — health, env-file token, human link",
      async () => {
        const md = join(dataDir, "session-review.md");
        await Bun.write(md, SESSION_MD);
        const res = await cli([
          "up",
          md,
          "--title",
          "M8 smoke — session review",
        ]);
        assert(res.code === 0, `board up failed (${res.code}):\n${res.stderr}`);
        const up = parseInstanceUp(res.stdout);
        sessionId = up.id;
        const paths = instancePaths(dataDir, up.id);
        assert(
          up.envPath === paths.env,
          `env file at unexpected path: ${up.envPath}`,
        );
        const health = await fetch(`${up.url}/api/health`);
        assert(health.status === 200, `instance health: HTTP ${health.status}`);
        // the env file is the credential delivery artifact (D20): its token
        // — read back through the wave-1 helper — reads the board at v1
        const envToken = readEnvToken(paths);
        assert(
          envToken !== null && envToken.length > 0,
          "env file carries no BOARD_TOKEN",
        );
        const vres = await fetch(`${up.url}/api/boards/${up.boardId}`, {
          headers: { authorization: `Bearer ${envToken ?? ""}` },
        });
        assert(
          vres.status === 200,
          `board read via env-file token: HTTP ${vres.status}`,
        );
        const view = (await vres.json()) as {
          board: { current_version: number; title: string };
        };
        assert(
          view.board.current_version === 1 &&
            view.board.title === "M8 smoke — session review",
          `unexpected v1 view: ${JSON.stringify(view.board)}`,
        );
        // the human link's exchange token swaps for a session that reads it
        const exch = /\?token=([A-Za-z0-9_-]{43})/.exec(up.human)?.[1] ?? "";
        const xres = await fetch(`${up.url}/api/session/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: exch }),
        });
        assert(xres.status === 200, `human link exchange: HTTP ${xres.status}`);
        const sess = (await xres.json()) as { token: string };
        const sres = await fetch(`${up.url}/api/boards/${up.boardId}`, {
          headers: { authorization: `Bearer ${sess.token}` },
        });
        assert(sres.status === 200, `session board read: HTTP ${sres.status}`);
        return { ...up, sessionToken: sess.token };
      },
    );

    await step(
      "session iteration: v2 via REST, human comment, agent cursor sees it",
      async () => {
        const agent = { authorization: `Bearer ${session.token}` };
        const pub = await fetch(
          `${session.url}/api/boards/${session.boardId}/publish`,
          {
            method: "POST",
            headers: { ...agent, "content-type": "application/json" },
            body: JSON.stringify({
              format: "markdown",
              content: SESSION_MD_V2,
              expected_version: 1,
            }),
          },
        );
        assert(pub.status === 201, `v2 publish: HTTP ${pub.status}`);
        // the human session comments on the v1 heading (same quote that
        // cannot miss: the anchor label IS the section text)
        const v1 = (await (
          await fetch(
            `${session.url}/api/boards/${session.boardId}/versions/1`,
            {
              headers: { authorization: `Bearer ${session.sessionToken}` },
            },
          )
        ).json()) as {
          anchors: Array<{ kind: string; id: string; label: string }>;
        };
        const heading = v1.anchors.find((a) => a.kind === "heading");
        assert(
          heading !== undefined,
          `no heading anchor on v1: ${JSON.stringify(v1.anchors)}`,
        );
        const quote = heading?.label ?? "";
        const cres = await fetch(
          `${session.url}/api/boards/${session.boardId}/comments`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${session.sessionToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              anchor: {
                type: "text",
                section_id: heading?.id,
                originalText: quote,
                startOffset: 0,
                endOffset: quote.length,
              },
              body: "sign-off recorded — ship it",
              version_n: 1,
            }),
          },
        );
        assert(cres.status === 201, `human comment: HTTP ${cres.status}`);
        const poll = (await (
          await fetch(
            `${session.url}/api/boards/${session.boardId}/comments?since=0`,
            { headers: agent },
          )
        ).json()) as { comments: Array<{ author: string }> };
        assert(
          poll.comments.length === 1 && poll.comments[0]?.author === "human",
          `agent cursor should see exactly the human comment: ${JSON.stringify(poll.comments)}`,
        );
      },
    );

    await step("board instances shows the live instance", async () => {
      const res = await cli(["instances"]);
      assert(
        res.code === 0,
        `board instances failed (${res.code}):\n${res.stderr}`,
      );
      assert(
        res.stdout.includes(session.id) && /\blive\b/.test(res.stdout),
        `instance ${session.id} not listed live:\n${res.stdout}`,
      );
    });

    await step(
      "connector: MCP over the session instance (node, no bun on PATH)",
      async () => {
        // The child env mirrors the real opencode spawn (D22): node available,
        // bun stripped from PATH (the connector is node-runnable by design),
        // BOARD_* pointing at this smoke's temp registry. No BOARD_MCP_TOKEN —
        // the smoke daemon has no wired shared credential here, so resolution
        // takes the D22 instance path: newest healthy session instance first.
        const conn = startConnector(
          connectorChildEnv({
            BOARD_DATA_DIR: dataDir,
            BOARD_HOST: "127.0.0.1",
            BOARD_PORT: String(new URL(baseUrl).port),
          }),
        );
        let exitCode = -1;
        try {
          const init = await conn.rpc(1, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "board-smoke", version: "0" },
          });
          const initResult = init.result as
            | { serverInfo?: { name?: string; version?: string } }
            | undefined;
          assert(
            init.id === 1 &&
              initResult?.serverInfo?.name === "board" &&
              typeof initResult.serverInfo.version === "string",
            `initialize handshake unexpected: ${JSON.stringify(init).slice(0, 300)}`,
          );
          const list = await conn.rpc(2, "tools/list");
          const tools = (
            list.result as { tools: Array<{ name: string }> } | undefined
          )?.tools;
          assert(
            list.id === 2 && tools !== undefined && tools.length === 15,
            `offline tools/list should carry the 15-tool manifest (13 + the two D23 D4 connector-local tools), got ${tools?.length ?? "none"}`,
          );
          assert(
            tools.some((t) => t.name === "board_publish"),
            `board_publish missing from the offline manifest: ${JSON.stringify(tools.map((t) => t.name))}`,
          );
          const call = await conn.rpc(3, "tools/call", {
            name: "board_publish",
            arguments: {
              board_id: session.boardId,
              format: "markdown",
              content: SESSION_MD_V3,
              expected_version: 2,
              label: "via the D22 connector",
            },
          });
          const result = call.result as
            | {
                isError?: boolean;
                content: Array<{ type: string; text: string }>;
              }
            | undefined;
          assert(
            call.id === 3 && result !== undefined,
            `no tools/call response: ${JSON.stringify(call).slice(0, 300)}`,
          );
          assert(
            result?.isError !== true,
            `board_publish via connector errored: ${result?.content[0]?.text ?? "(no content)"}`,
          );
          const published = JSON.parse(result.content[0].text) as {
            board_id: string;
            n: number;
          };
          assert(
            published.board_id === session.boardId && published.n === 3,
            `connector publish should be v3 on the session board, got: ${JSON.stringify(published)}`,
          );
          // It landed on the SESSION instance, not the smoke daemon: the board
          // id only exists there — read it back over that instance's REST.
          const envToken = readEnvToken(instancePaths(dataDir, session.id));
          assert(envToken !== null, "session env file lost its token mid-step");
          const vres = await fetch(
            `${session.url}/api/boards/${session.boardId}`,
            { headers: { authorization: `Bearer ${envToken ?? ""}` } },
          );
          assert(
            vres.status === 200,
            `board read back after connector publish: HTTP ${vres.status}`,
          );
          const view = (await vres.json()) as {
            board: { current_version: number };
          };
          assert(
            view.board.current_version === 3,
            `session board should be at v3 after the connector publish, got ${view.board.current_version}`,
          );
        } finally {
          // ALWAYS tear the connector down — EOF on stdin, clean exit expected.
          exitCode = await conn.end();
        }
        assert(
          exitCode === 0,
          `connector should exit 0 on stdin EOF, got ${exitCode}`,
        );
      },
    );

    await step(
      "discovery + explicit connect (D23 D4): beta finds the servers, pins, and the pin overrides auto-resolution",
      async () => {
        // The second agent's connector: shared = a CLOSED port (so
        // auto-resolution would fall through to the newest healthy instance —
        // making the pin-override proof below meaningful), no wired shared
        // credential, no BOARD_INSTANCE — the discovery shape.
        const conn = startConnector(
          connectorChildEnv({
            BOARD_DATA_DIR: dataDir,
            BOARD_HOST: "127.0.0.1",
            BOARD_PORT: String(closedPort()),
          }),
        );
        let exitCode = -1;
        try {
          const list = await conn.rpc(1, "tools/list");
          const tools = (
            list.result as { tools: Array<{ name: string }> } | undefined
          )?.tools;
          assert(
            list.id === 1 &&
              tools !== undefined &&
              tools.length === 15 &&
              tools.some((t) => t.name === "board_servers") &&
              tools.some((t) => t.name === "board_connect"),
            `beta tools/list should carry 15 tools incl. board_servers/board_connect, got ${tools?.length ?? "none"}`,
          );
          // Discovery works with the shared daemon down: the shared entry is
          // status-only with a hint; the live session instance lists its
          // boards (the board at v3 from step 19).
          const discover = await conn.rpc(2, "tools/call", {
            name: "board_servers",
            arguments: {},
          });
          const dResult = discover.result as
            | { isError?: boolean; content: Array<{ text: string }> }
            | undefined;
          assert(
            discover.id === 2 &&
              dResult !== undefined &&
              dResult.isError !== true,
            `board_servers errored: ${JSON.stringify(discover).slice(0, 300)}`,
          );
          const discovered = JSON.parse(dResult.content[0].text) as {
            servers: Array<{
              kind: string;
              id?: string;
              url?: string;
              status: string;
              credential: boolean;
              boards?: Array<{ id: string; current_version: number }>;
              hint?: string;
            }>;
          };
          const sharedEntry = discovered.servers.find(
            (srv) => srv.kind === "shared",
          );
          assert(
            sharedEntry?.status === "down" &&
              (sharedEntry.hint ?? "").includes("make serve"),
            `shared entry should be down with a hint, got: ${JSON.stringify(sharedEntry)}`,
          );
          const instanceEntry = discovered.servers.find(
            (srv) => srv.id === session.id,
          );
          assert(
            instanceEntry?.status === "up" &&
              instanceEntry.credential === true &&
              instanceEntry.boards?.some(
                (b) => b.id === session.boardId && b.current_version === 3,
              ) === true,
            `session instance should be up with the board at v3, got: ${JSON.stringify(instanceEntry)}`,
          );
          // No secrets, ever: none of the three credentials the smoke holds
          // appears in the discovery output (invariant 7).
          const envToken = readEnvToken(instancePaths(dataDir, session.id));
          assert(envToken !== null, "session env file lost its token mid-step");
          for (const secret of [alpha, beta, envToken]) {
            assert(
              !dResult.content[0].text.includes(secret),
              "board_servers output leaked credential material",
            );
          }
          // Pin the session instance by id; the pinned board_get proves
          // proxied calls follow the pin.
          const pin = await conn.rpc(3, "tools/call", {
            name: "board_connect",
            arguments: { instance_id: session.id },
          });
          const pinResult = pin.result as
            | { isError?: boolean; content: Array<{ text: string }> }
            | undefined;
          assert(
            pin.id === 3 &&
              pinResult !== undefined &&
              pinResult.isError !== true,
            `board_connect {instance_id} errored: ${JSON.stringify(pin).slice(0, 300)}`,
          );
          const pinEcho = JSON.parse(pinResult.content[0].text) as {
            connected: boolean;
            target: { kind: string; id: string };
          };
          assert(
            pinEcho.connected === true &&
              pinEcho.target.kind === "instance" &&
              pinEcho.target.id === session.id,
            `unexpected connect echo: ${pinResult.content[0].text}`,
          );
          const got = await conn.rpc(4, "tools/call", {
            name: "board_get",
            arguments: { board_id: session.boardId },
          });
          const gotResult = got.result as
            | { isError?: boolean; content: Array<{ text: string }> }
            | undefined;
          assert(
            got.id === 4 &&
              gotResult !== undefined &&
              gotResult.isError !== true,
            `pinned board_get errored: ${JSON.stringify(got).slice(0, 300)}`,
          );
          const gotBoard = JSON.parse(gotResult.content[0].text) as {
            board: { id: string };
          };
          assert(
            gotBoard.board.id === session.boardId,
            "pinned board_get should have routed to the session instance",
          );
          // Now pin the SMOKE daemon directly ({url, token} — the
          // manager-minted flow) and publish to the release-plan board: with
          // the session instance still live, the pin must override
          // newest-instance auto-resolution (the D23 D4 semantics).
          const repin = await conn.rpc(5, "tools/call", {
            name: "board_connect",
            arguments: { url: baseUrl, token: beta },
          });
          const repinResult = repin.result as
            | { isError?: boolean; content: Array<{ text: string }> }
            | undefined;
          assert(
            repin.id === 5 &&
              repinResult !== undefined &&
              repinResult.isError !== true,
            `board_connect {url, token} errored: ${JSON.stringify(repin).slice(0, 300)}`,
          );
          const repinEcho = JSON.parse(repinResult.content[0].text) as {
            connected: boolean;
            target: { kind: string; url: string };
          };
          assert(
            repinEcho.connected === true &&
              repinEcho.target.kind === "direct" &&
              repinEcho.target.url === baseUrl,
            `unexpected repin echo: ${repinResult.content[0].text}`,
          );
          const pub = await conn.rpc(6, "tools/call", {
            name: "board_publish",
            arguments: {
              board_id: board.id,
              format: "markdown",
              content: V3_MD,
              expected_version: 2,
              label: "via the D23 D4 pin",
            },
          });
          const pubResult = pub.result as
            | { isError?: boolean; content: Array<{ text: string }> }
            | undefined;
          assert(
            pub.id === 6 &&
              pubResult !== undefined &&
              pubResult.isError !== true,
            `pinned board_publish errored: ${JSON.stringify(pub).slice(0, 300)}`,
          );
          const published = JSON.parse(pubResult.content[0].text) as {
            board_id: string;
            n: number;
          };
          assert(
            published.board_id === board.id && published.n === 3,
            `pinned publish should be v3 on the release-plan board, got: ${JSON.stringify(published)}`,
          );
          // It landed on the SMOKE daemon (the pinned target)...
          const check = await api("GET", `/api/boards/${board.id}`, alpha);
          expectStatus(check, 200, "pinned publish readback");
          assert(
            json<{ board: { current_version: number } }>(check).board
              .current_version === 3,
            "release-plan board should be at v3 after the pinned publish",
          );
          // ...and NOT on the session instance auto-resolution would have
          // picked.
          const wrong = await fetch(`${session.url}/api/boards/${board.id}`, {
            headers: { authorization: `Bearer ${envToken}` },
          });
          assert(
            wrong.status === 404,
            `pinned publish must NOT land on the session instance: got HTTP ${wrong.status}`,
          );
          // Status echo + reset round the pin off.
          const status = await conn.rpc(7, "tools/call", {
            name: "board_connect",
            arguments: {},
          });
          const statusEcho = JSON.parse(
            (status.result as { content: Array<{ text: string }> }).content[0]
              .text,
          ) as { connected: boolean; target: { kind: string } };
          assert(
            statusEcho.connected === true &&
              statusEcho.target.kind === "direct",
            `status echo should show the direct pin, got: ${JSON.stringify(statusEcho)}`,
          );
          const reset = await conn.rpc(8, "tools/call", {
            name: "board_connect",
            arguments: { reset: true },
          });
          const resetEcho = JSON.parse(
            (reset.result as { content: Array<{ text: string }> }).content[0]
              .text,
          ) as { connected: boolean; reset: boolean };
          assert(
            resetEcho.connected === false && resetEcho.reset === true,
            `reset echo unexpected: ${JSON.stringify(resetEcho)}`,
          );
        } finally {
          // ALWAYS tear the connector down — EOF on stdin, clean exit expected.
          exitCode = await conn.end();
        }
        assert(
          exitCode === 0,
          `beta connector should exit 0 on stdin EOF, got ${exitCode}`,
        );
      },
    );

    await step(
      "board down — keepsake zip, env + temp purge, port closed",
      async () => {
        const res = await cli(["down", session.id]);
        assert(
          res.code === 0,
          `board down failed (${res.code}):\n${res.stderr}`,
        );
        const paths = instancePaths(dataDir, session.id);
        const zipPath = join(paths.boards, `${session.boardId}.zip`);
        const zip = Bun.file(zipPath);
        assert(await zip.exists(), `keepsake zip missing: ${zipPath}`);
        assert((await zip.size) > 0, `keepsake zip is empty: ${zipPath}`);
        assert(!existsSync(paths.env), "env file survived down");
        const entry = readInstanceEntry(paths);
        if (entry === null || entry.closedAt === undefined) {
          throw new Error("instance entry not closed-stamped after down");
        }
        assert(!existsSync(entry.dataDir), "temp data dir survived down");
        let refused = false;
        try {
          await fetch(`${session.url}/api/health`);
        } catch {
          refused = true; // connection refused — the daemon is gone
        }
        assert(refused, "instance port still accepts connections");
      },
    );

    const verified = receiver.deliveries.filter(
      (d) => d.sigOk && d.event !== null,
    ).length;
    console.log(
      `SMOKE PASS — ${stepNo} steps, ${verified} webhook deliveries verified`,
    );
    return 0;
  } catch (err) {
    console.error(
      `SMOKE FAIL — step ${stepNo} (${stepLabel}): ${err instanceof Error ? err.message : String(err)}`,
    );
    if (lastResponse !== undefined) {
      console.error(
        `  last response: HTTP ${lastResponse.status} ${lastResponse.body.slice(0, 2000)}`,
      );
    }
    // daemon.log replaced the stderr pipe of the hand-rolled spawn: both
    // daemon streams land there (the FAIL-path debugging aid).
    if (smokePaths !== undefined && existsSync(smokePaths.log)) {
      const tail = readFileSync(smokePaths.log, "utf8").slice(-4000).trim();
      if (tail.length > 0) {
        console.error(`  daemon.log (tail):\n${tail}`);
      }
    }
    return 1;
  } finally {
    // ALWAYS tear down — both daemons (the smoke's own and any session
    // instance the CLI wave spawned), the scratch receiver, and the temp
    // dirs die with the script, including on failure paths. The wave-1
    // helper owns the signal ladder + temp purge; keepsake export would be
    // rmSync'd with the registry a line later, so it is off.
    receiver.stop();
    if (spawned !== undefined && smokePaths !== undefined) {
      try {
        await teardownInstance(spawned.entry, smokePaths, {
          exportKeepsakes: false,
          notice: (m) => console.error(`board smoke: ${m}`),
        });
      } catch (err) {
        console.error(
          `board smoke: smoke-daemon teardown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sessionId !== undefined) {
      const sPaths = instancePaths(dataDir, sessionId);
      const sEntry = readInstanceEntry(sPaths);
      if (sEntry !== null && sEntry.closedAt === undefined) {
        // the smoke died before step 21's `board down` — no leaked daemon
        try {
          await teardownInstance(sEntry, sPaths, {
            exportKeepsakes: false,
            notice: (m) => console.error(`board smoke: ${m}`),
          });
        } catch (err) {
          console.error(
            `board smoke: session-instance teardown failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await run());
}
