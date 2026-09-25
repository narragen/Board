// M8.1a contract tests: `board up --resume` (session-board continuity — D20,
// owner green-light 2026-09-16) driven as REAL subprocesses with a temp
// BOARD_DATA_DIR everywhere — never the real ~/.board. The subprocess driver,
// the `board up` stdout parser and the spawned-daemon tracking come from
// cli/test/harness.ts (one copy, shared with instances/resolve and the
// smoke); tracked daemons are force-killed in afterAll so a failing assertion
// cannot leak a process. Every "board is intact" claim is verified over REST
// against the NEW instance's daemon with the freshly minted agent token — the
// way the resumed session's agent would consume it.
import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boardIdFrom,
  createCliHarness,
  parseUp,
  type UpOutput,
} from "../test/harness.ts";
import {
  instancePaths,
  instancesRoot,
  readInstanceEntry,
  writeInstanceEntry,
} from "./instances.ts";

const harness = createCliHarness("board-cli-resume-test-");
const { freshDir, runCli, trackDir, trackInstance } = harness;

afterAll(() => {
  harness.cleanup();
});

const V1_MD =
  "# Decision log\n\n## Rollout order\n\nThe rollout must wait for the migration to finish.\n";
const OTHER_MD = "# Scratch notes\n\nUnrelated prior session.\n";

interface ResumedBoard {
  source: string;
  id: string;
  title: string;
}

// The resume block's per-board lines (commands/instances.ts resumeKeepsakes):
// `resumed N board(s) from <instance-id>: <new-id> — "<title>"`
function parseResumed(stdout: string): ResumedBoard[] {
  return [
    ...stdout.matchAll(
      /^resumed \d+ board\(s\) from (s-[0-9A-Za-z]{10}): ([0-9A-Za-z]{10}) — "(.+)"$/gm,
    ),
  ].map((m) => ({
    source: m[1] ?? "",
    id: m[2] ?? "",
    title: m[3] ?? "",
  }));
}

// up + publish a file, then down — the keepsake-zip factory most resume
// tests need. Returns the closed instance's id and its board id.
async function upPublishDown(
  dir: string,
  fileName: string,
  content: string,
): Promise<{ instanceId: string; boardId: string; zipPath: string }> {
  const md = join(dir, fileName);
  writeFileSync(md, content);
  const res = await runCli(["up", md], { BOARD_DATA_DIR: dir });
  expect(res.exitCode).toBe(0);
  const up = parseUp(res.stdout);
  trackInstance(dir, up);
  const boardId = boardIdFrom(up);
  const down = await runCli(["down", up.id], { BOARD_DATA_DIR: dir });
  expect(down.exitCode).toBe(0);
  return {
    instanceId: up.id,
    boardId,
    zipPath: join(instancePaths(dir, up.id).boards, `${boardId}.zip`),
  };
}

// The human half of contract 17: exchange the one-time link for a session and
// comment on the v1 heading (the instances.test.ts contract-3 pattern).
async function postHumanHeadingComment(
  up: UpOutput,
  boardId: string,
  body: string,
): Promise<void> {
  const exchange =
    /\?token=([A-Za-z0-9_-]{43})/.exec(up.human ?? "")?.[1] ?? "";
  const session = (await (
    await fetch(`${up.url}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: exchange }),
    })
  ).json()) as { token: string };
  const v1 = (await (
    await fetch(`${up.url}/api/boards/${boardId}/versions/1`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
  ).json()) as { anchors: Array<{ kind: string; id: string; label: string }> };
  const heading = v1.anchors.find((a) => a.kind === "heading");
  expect(heading).toBeDefined();
  const quote = heading?.label ?? "";
  const res = await fetch(`${up.url}/api/boards/${boardId}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
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
      body,
      version_n: 1,
    }),
  });
  expect(res.status).toBe(201);
}

describe("board up --resume", () => {
  test("contract 17: full round-trip — new instance serves the board with content AND comments intact", async () => {
    const dir = freshDir();
    // session A: publish, collect a human comment, tear down
    const md = join(dir, "notes.md");
    writeFileSync(md, V1_MD);
    const resA = await runCli(["up", md], { BOARD_DATA_DIR: dir });
    expect(resA.exitCode).toBe(0);
    const upA = parseUp(resA.stdout);
    trackInstance(dir, upA);
    const boardA = boardIdFrom(upA);
    await postHumanHeadingComment(
      upA,
      boardA,
      "does this really need to wait for the migration?",
    );
    const downA = await runCli(["down", upA.id], { BOARD_DATA_DIR: dir });
    expect(downA.exitCode).toBe(0);
    expect(readdirSync(instancePaths(dir, upA.id).boards)).toEqual([
      `${boardA}.zip`,
    ]);

    // session B: same registry, bare --resume (= latest; A is the only prior)
    const resB = await runCli(["up", "--resume"], { BOARD_DATA_DIR: dir });
    expect(resB.exitCode).toBe(0);
    const upB = parseUp(resB.stdout);
    trackInstance(dir, upB);
    const resumed = parseResumed(resB.stdout);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.source).toBe(upA.id);
    expect(resumed[0]?.title).toBe("notes.md");
    const boardB = resumed[0]?.id ?? "";
    expect(boardB).not.toBe(boardA); // import's always-new-id rule
    expect(resB.stdout).toContain(
      `hint: board open --instance ${upB.id} ${boardB}`,
    );

    // the NEW instance's daemon serves the resumed board under its NEW id,
    // authenticated with the freshly minted agent token
    const agent = { authorization: `Bearer ${upB.token}` };
    const view = (await (
      await fetch(`${upB.url}/api/boards/${boardB}`, { headers: agent })
    ).json()) as {
      board: { title: string; current_version: number; status: string };
    };
    expect(view.board.title).toBe("notes.md");
    expect(view.board.current_version).toBe(1);
    // content intact — import re-renders, the markdown SOURCE survives
    const v1 = (await (
      await fetch(`${upB.url}/api/boards/${boardB}/versions/1`, {
        headers: agent,
      })
    ).json()) as { source_md: string | null };
    expect(v1.source_md).toBe(V1_MD);
    // comments intact — the human's anchored comment replayed onto the copy
    const poll = (await (
      await fetch(`${upB.url}/api/boards/${boardB}/comments?since=0`, {
        headers: agent,
      })
    ).json()) as { comments: Array<{ body: string; author: string }> };
    expect(poll.comments).toHaveLength(1);
    expect(poll.comments[0]?.body).toBe(
      "does this really need to wait for the migration?",
    );
    expect(poll.comments[0]?.author).toBe("human");
  }, 90_000);

  test("contract 18: --resume=all lands boards from every prior instance; the file board is published first", async () => {
    const dir = freshDir();
    await upPublishDown(dir, "a.md", OTHER_MD);
    await upPublishDown(dir, "b.md", V1_MD);

    const md = join(dir, "c.md");
    writeFileSync(md, "# Live\n\nThe new primary board.\n");
    const res = await runCli(["up", md, "--resume=all"], {
      BOARD_DATA_DIR: dir,
    });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);

    // both priors landed, most recent first (b.md's instance closed last)
    const resumed = parseResumed(res.stdout);
    expect(resumed.map((r) => r.title)).toEqual(["b.md", "a.md"]);
    expect(new Set(resumed.map((r) => r.source)).size).toBe(2);
    for (const board of resumed) {
      const view = await fetch(`${up.url}/api/boards/${board.id}`, {
        headers: { authorization: `Bearer ${up.token}` },
      });
      expect(view.status).toBe(200);
    }

    // the primary (file) board exists too — three boards on the new instance
    const list = (await (
      await fetch(`${up.url}/api/boards`, {
        headers: { authorization: `Bearer ${up.token}` },
      })
    ).json()) as Array<{ title: string }>;
    expect(list.map((b) => b.title).sort()).toEqual(["a.md", "b.md", "c.md"]);

    // output order: the primary's human link before the resume block
    expect(res.stdout.indexOf("human link:")).toBeLessThan(
      res.stdout.indexOf("resumed 1 board(s)"),
    );
  }, 120_000);

  test("contract 19: --resume=<id> takes only that instance; repeated resume yields fresh ids again", async () => {
    const dir = freshDir();
    const a = await upPublishDown(dir, "a.md", OTHER_MD);
    await upPublishDown(dir, "b.md", V1_MD);

    const first = await runCli(["up", `--resume=${a.instanceId}`], {
      BOARD_DATA_DIR: dir,
    });
    expect(first.exitCode).toBe(0);
    const upR1 = parseUp(first.stdout);
    trackInstance(dir, upR1);
    const resumed1 = parseResumed(first.stdout);
    expect(resumed1).toHaveLength(1);
    expect(resumed1[0]?.source).toBe(a.instanceId);
    expect(resumed1[0]?.title).toBe("a.md");
    const boardR1 = resumed1[0]?.id ?? "";

    // zips persist after down: the same resume mints fresh copies again
    const second = await runCli(["up", `--resume=${a.instanceId}`], {
      BOARD_DATA_DIR: dir,
    });
    expect(second.exitCode).toBe(0);
    const upR2 = parseUp(second.stdout);
    trackInstance(dir, upR2);
    const resumed2 = parseResumed(second.stdout);
    expect(resumed2).toHaveLength(1);
    const boardR2 = resumed2[0]?.id ?? "";
    expect(boardR2).not.toBe(boardR1);
    const view = await fetch(`${upR2.url}/api/boards/${boardR2}`, {
      headers: { authorization: `Bearer ${upR2.token}` },
    });
    expect(view.status).toBe(200);
  }, 120_000);

  test("contract 20: bare --resume ≡ latest — the most recently closed prior wins", async () => {
    const dir = freshDir();
    await upPublishDown(dir, "a.md", OTHER_MD);
    const b = await upPublishDown(dir, "b.md", V1_MD);

    const res = await runCli(["up", "--resume"], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    trackInstance(dir, parseUp(res.stdout));
    const resumed = parseResumed(res.stdout);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.source).toBe(b.instanceId);
    expect(resumed[0]?.title).toBe("b.md");
  }, 90_000);

  test("contract 21: empty cases — notice, exit 0, instance healthy; bad id shape errors before spawn", async () => {
    // empty registry: bare --resume still spawns a healthy instance
    const dir = freshDir();
    const res = await runCli(["up", "--resume"], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    expect(res.stdout).toContain("no previous session boards to resume");
    expect((await fetch(`${up.url}/api/health`)).status).toBe(200);

    // a plausible but unknown instance id: same gentle outcome, id named
    const unknown = await runCli(["up", "--resume=s-unknownid0"], {
      BOARD_DATA_DIR: dir,
    });
    expect(unknown.exitCode).toBe(0);
    trackInstance(dir, parseUp(unknown.stdout));
    expect(unknown.stdout).toContain(
      "no previous session boards to resume from s-unknownid0",
    );

    // a closed instance with no keepsakes (never published a board)
    const dir2 = freshDir();
    const bare = await runCli(["up"], { BOARD_DATA_DIR: dir2 });
    expect(bare.exitCode).toBe(0);
    trackInstance(dir2, parseUp(bare.stdout));
    const closed = await runCli(["down", parseUp(bare.stdout).id], {
      BOARD_DATA_DIR: dir2,
    });
    expect(closed.exitCode).toBe(0);
    const resAll = await runCli(["up", "--resume=all"], {
      BOARD_DATA_DIR: dir2,
    });
    expect(resAll.exitCode).toBe(0);
    trackInstance(dir2, parseUp(resAll.stdout));
    expect(resAll.stdout).toContain("no previous session boards to resume");

    // a non-id value can never become a registry path: parse error, no spawn
    const dir3 = freshDir();
    const evil = await runCli(["up", "--resume=../evil"], {
      BOARD_DATA_DIR: dir3,
    });
    expect(evil.exitCode).toBe(1);
    expect(evil.stderr).toContain("--resume");
    expect(existsSync(instancesRoot(dir3))).toBe(false);
  }, 90_000);

  test("contract 22: a corrupt keepsake is a per-board notice; the rest resume and up still exits 0", async () => {
    const dir = freshDir();
    const md = join(dir, "work.md");
    writeFileSync(md, V1_MD);
    const res = await runCli(["up", md], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    const upA = parseUp(res.stdout);
    trackInstance(dir, upA);
    const boardA = boardIdFrom(upA);

    // a second board on the same instance, so one corrupt zip proves the
    // others still resume
    const created = (await (
      await fetch(`${upA.url}/api/boards`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${upA.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Spare", format: "markdown" }),
      })
    ).json()) as { id: string };
    const pub = await fetch(`${upA.url}/api/boards/${created.id}/publish`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${upA.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        format: "markdown",
        content: OTHER_MD,
        expected_version: 0,
      }),
    });
    expect(pub.status).toBe(201);

    const down = await runCli(["down", upA.id], { BOARD_DATA_DIR: dir });
    expect(down.exitCode).toBe(0);
    const boardsDir = instancePaths(dir, upA.id).boards;
    expect(readdirSync(boardsDir).sort()).toEqual(
      [boardA, created.id].map((id) => `${id}.zip`).sort(),
    );

    // plant the corrupt keepsake
    writeFileSync(join(boardsDir, `${boardA}.zip`), "not a zip at all");

    const resumed = await runCli([`up`, `--resume=${upA.id}`], {
      BOARD_DATA_DIR: dir,
    });
    expect(resumed.exitCode).toBe(0); // a bad keepsake must not break the session
    expect(resumed.stderr).toContain(`resuming keepsake ${boardA}.zip`);
    expect(resumed.stderr).toContain("failed");
    const lines = parseResumed(resumed.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.title).toBe("Spare");
    const up = parseUp(resumed.stdout);
    trackInstance(dir, up);
    const view = await fetch(`${up.url}/api/boards/${lines[0]?.id}`, {
      headers: { authorization: `Bearer ${up.token}` },
    });
    expect(view.status).toBe(200);
  }, 120_000);

  test("contract 23: the zips on disk are the truth (drifted stamp, no closedAt — mtime fallback)", async () => {
    // produce one real keepsake zip in a scratch registry…
    const scratch = freshDir();
    const source = await upPublishDown(scratch, "drift.md", V1_MD);

    // …and a hand-crafted registry entry whose stamped metadata lies: the
    // `boards` list names a board that was never kept, and closedAt is
    // absent (a down that died between the zip writes and the stamp).
    // Discovery must ignore the stamp and import the zip it finds.
    const dir = freshDir();
    const craftedId = "s-crafted000";
    const paths = instancePaths(dir, craftedId);
    mkdirSync(paths.dir, { recursive: true });
    mkdirSync(paths.boards, { recursive: true });
    const decoy = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const craftedDataDir = mkdtempSync(join(tmpdir(), "board-instance-"));
      trackDir(craftedDataDir);
      writeInstanceEntry(paths, {
        id: craftedId,
        pid: decoy.pid, // live + foreign: up's prune must leave the entry alone
        port: 1,
        url: "http://127.0.0.1:1",
        dataDir: craftedDataDir,
        agentTokenName: "session",
        createdAt: new Date().toISOString(),
        boards: ["b-drifted000"], // drift: not what is on disk
      });
      copyFileSync(source.zipPath, join(paths.boards, "stolen.zip"));

      const res = await runCli(["up", "--resume"], { BOARD_DATA_DIR: dir });
      expect(res.exitCode).toBe(0);
      trackInstance(dir, parseUp(res.stdout));
      const lines = parseResumed(res.stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.source).toBe(craftedId);
      // the ZIP's title won — the drifted boards stamp was ignored
      expect(lines[0]?.title).toBe("drift.md");

      // the foreign-pid entry was reported to no one and mutated by no one
      const after = readInstanceEntry(paths);
      expect(after?.closedAt).toBeUndefined();
      expect(after?.boards).toEqual(["b-drifted000"]);
    } finally {
      decoy.kill("SIGKILL");
      await decoy.exited;
    }
  }, 90_000);
});
