// D20 wave-1 contract tests: `board up / down / instances` driven as REAL
// subprocesses (the cli/src/main.test.ts pattern) with temp BOARD_DATA_DIR
// everywhere — never the real ~/.board. The subprocess driver, the `board up`
// stdout parser and the spawned-daemon tracking come from cli/test/harness.ts
// — one copy, shared with resolve/resume and the smoke. Tracked daemons are
// force-killed in afterAll so a failing assertion cannot leak a process.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "../../server/test/helpers.ts";
import {
  awaitGone,
  boardIdFrom,
  createCliHarness,
  parseUp,
} from "../test/harness.ts";
import {
  instancePaths,
  instancesRoot,
  readInstanceEntry,
  spawnInstance,
  writeInstanceEntry,
} from "./instances.ts";

const harness = createCliHarness("board-cli-instances-test-");
const { freshDir, runCli, trackDaemon, trackDir, trackInstance } = harness;

afterAll(() => {
  harness.cleanup();
});

// The instance port must REFUSE connections (dead daemon), not merely error.
async function expectRefused(url: string): Promise<void> {
  try {
    await fetch(`${url}/api/health`);
  } catch {
    return; // connection refused — the daemon is gone
  }
  throw new Error(`expected ${url} to refuse connections`);
}

const V1_MD =
  "# Decision log\n\n## Rollout order\n\nThe rollout must wait for the migration to finish.\n";

// F3 tests: the pre-readiness (booting) registry entry is the signal to kill
// `up` against — poll the registry until it appears (written right after the
// daemon spawn, ~the whole boot before readiness).
async function awaitBootingEntry(
  dataDir: string,
  timeoutMs = 15_000,
): Promise<{ id: string; pid: number; dataDir: string; url?: string }> {
  const deadline = Date.now() + timeoutMs;
  const root = instancesRoot(dataDir);
  while (Date.now() < deadline) {
    if (existsSync(root)) {
      for (const id of readdirSync(root)) {
        const entry = readInstanceEntry(instancePaths(dataDir, id));
        if (entry?.booting === true) {
          return { id: entry.id, pid: entry.pid, dataDir: entry.dataDir };
        }
      }
    }
    await Bun.sleep(10);
  }
  throw new Error(`no booting entry appeared in ${root} within ${timeoutMs}ms`);
}

describe("board up", () => {
  test("contract 1: bare up — health, port, registry hygiene", async () => {
    const dir = freshDir();
    const res = await runCli(["up"], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);

    const port = Number(new URL(up.url).port);
    expect(port).not.toBe(7800);
    const health = await fetch(`${up.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const paths = instancePaths(dir, up.id);
    // the registry lives under the temp BOARD_DATA_DIR, never ~/.board
    expect(paths.dir.startsWith(join(dir, "instances"))).toBe(true);
    const entry = JSON.parse(readFileSync(paths.json, "utf8")) as {
      pid: number;
      port: number;
      url: string;
      agentTokenName: string;
      dataDir: string;
      closedAt?: string;
    };
    expect(entry.pid).toBeGreaterThan(0);
    expect(entry.port).toBe(port);
    expect(entry.url).toBe(up.url);
    expect(entry.agentTokenName).toBe("session");
    expect(entry.dataDir).toContain("board-instance-");
    // instance.json must never hold token plaintext (invariant 7)
    expect(JSON.stringify(entry)).not.toContain(up.token);

    const envText = readFileSync(up.envPath, "utf8");
    expect(statSync(up.envPath).mode & 0o777).toBe(0o600);
    expect(envText).toContain(`export BOARD_TOKEN=${up.token}`);
    expect(envText).toContain(`export BOARD_INSTANCE=${up.id}`);
    expect(envText).toContain(`export BOARD_PORT=${port}`);
    expect(statSync(join(paths.dir, "daemon.log")).size).toBeGreaterThan(0);

    // down with NO target (and no BOARD_INSTANCE) errors and lists live ids
    const noTarget = await runCli(["down"], { BOARD_DATA_DIR: dir });
    expect(noTarget.exitCode).toBe(1);
    expect(noTarget.stderr).toContain(up.id);
    const down = await runCli(["down", up.id], { BOARD_DATA_DIR: dir });
    expect(down.exitCode).toBe(0);
  }, 30_000);

  test("contract 2: up <file.md> — v1 published, human link exchanges", async () => {
    const dir = freshDir();
    const md = join(dir, "notes.md");
    writeFileSync(md, V1_MD);
    const res = await runCli(["up", md, "--tags", "review,ops"], {
      BOARD_DATA_DIR: dir,
    });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    expect(up.human).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43}#\/boards\/[0-9A-Za-z]{10}$/,
    );
    const boardId = boardIdFrom(up);
    const headers = { authorization: `Bearer ${up.token}` };

    // board exists at v1 with the inferred title (basename) and tags
    const view = (await (
      await fetch(`${up.url}/api/boards/${boardId}`, { headers })
    ).json()) as {
      board: { title: string; tags: string[]; current_version: number };
    };
    expect(view.board.current_version).toBe(1);
    expect(view.board.title).toBe("notes.md");
    expect(view.board.tags).toEqual(["review", "ops"]);

    // the human link's exchange token swaps for a session that reads the board
    const exchange =
      /\?token=([A-Za-z0-9_-]{43})/.exec(up.human ?? "")?.[1] ?? "";
    const xres = await fetch(`${up.url}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: exchange }),
    });
    expect(xres.status).toBe(200);
    const session = (await xres.json()) as { token: string };
    const sres = await fetch(`${up.url}/api/boards/${boardId}`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(sres.status).toBe(200);
  }, 30_000);

  test("contract 3: iterate — v2 via REST, human comment, agent cursor sees it", async () => {
    const dir = freshDir();
    const md = join(dir, "plan.md");
    writeFileSync(md, V1_MD);
    const res = await runCli(["up", md], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    const boardId = boardIdFrom(up);
    const agent = { authorization: `Bearer ${up.token}` };

    // agent publishes v2 via REST
    const pub = await fetch(`${up.url}/api/boards/${boardId}/publish`, {
      method: "POST",
      headers: { ...agent, "content-type": "application/json" },
      body: JSON.stringify({
        format: "markdown",
        content: `${V1_MD}\nOrder reversed after review.\n`,
        expected_version: 1,
      }),
    });
    expect(pub.status).toBe(201);

    // human session comments on the v1 heading
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
    ).json()) as {
      anchors: Array<{ kind: string; id: string; label: string }>;
    };
    const heading = v1.anchors.find((a) => a.kind === "heading");
    expect(heading).toBeDefined();
    const quote = heading?.label ?? "";
    const cres = await fetch(`${up.url}/api/boards/${boardId}/comments`, {
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
        body: "does this really need to wait for the migration?",
        version_n: 1,
      }),
    });
    expect(cres.status).toBe(201);

    // the agent cursor returns the human comment
    const poll = (await (
      await fetch(`${up.url}/api/boards/${boardId}/comments?since=0`, {
        headers: agent,
      })
    ).json()) as { comments: Array<{ body: string; author: string }> };
    expect(poll.comments).toHaveLength(1);
    expect(poll.comments[0]?.author).toBe("human");
  }, 30_000);

  test("contract 7: hostile inherited env cannot widen the instance", async () => {
    const dir = freshDir();
    const res = await runCli(["up"], {
      BOARD_DATA_DIR: dir,
      BOARD_HOST: "0.0.0.0",
      BOARD_BIND: "evil.example",
      BOARD_PORT: "7654",
    });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    // pinned: loopback URL and a kernel-assigned port, not the inherited env
    expect(up.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Number(new URL(up.url).port)).not.toBe(7654);
    expect((await fetch(`${up.url}/api/health`)).status).toBe(200);
  }, 30_000);

  test("contract 8: token plaintext only in the env file + print-once line", async () => {
    const dir = freshDir();
    const md = join(dir, "secret.md");
    writeFileSync(md, V1_MD);
    const res = await runCli(["up", md], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    // exactly one stdout occurrence (the marked print-once line), none on stderr
    expect(res.stdout.split(up.token)).toHaveLength(2);
    expect(res.stderr).not.toContain(up.token);
    const paths = instancePaths(dir, up.id);
    expect(readFileSync(paths.json, "utf8")).not.toContain(up.token);
    expect(readFileSync(paths.log, "utf8")).not.toContain(up.token);
    // sanity: the token is real — the env file carries it
    expect(readFileSync(paths.env, "utf8")).toContain(up.token);
  }, 30_000);

  test("contract 10: ambient BOARD_* env is scrubbed from the daemon (audit F2/N5)", async () => {
    const dir = freshDir();
    // a sourced previous-session env file leaves exactly these in the shell
    // that runs `up` — none may reach the daemon's /proc/<pid>/environ
    const res = await runCli(["up"], {
      BOARD_DATA_DIR: dir,
      BOARD_TOKEN: "sentinel-plain-token",
      BOARD_INSTANCE: "s-sentinel00",
      BOARD_SSE_HEARTBEAT_MS: "0",
    });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    const entry = JSON.parse(
      readFileSync(instancePaths(dir, up.id).json, "utf8"),
    ) as { pid: number; dataDir: string };
    const environ = readFileSync(`/proc/${entry.pid}/environ`, "utf8").split(
      "\0",
    );
    // sentinels ABSENT: the live plaintext token never lands in an environ
    expect(environ).not.toContain("BOARD_TOKEN=sentinel-plain-token");
    expect(environ).not.toContain("BOARD_INSTANCE=s-sentinel00");
    // N5: the stripped heartbeat var reverts to the documented default
    expect(environ).not.toContain("BOARD_SSE_HEARTBEAT_MS=0");
    // the pinned four are exactly what the spawner overlays
    expect(environ).toContain(`BOARD_DATA_DIR=${entry.dataDir}`);
    expect(environ).toContain("BOARD_PORT=0");
    expect(environ).toContain("BOARD_HOST=127.0.0.1");
    expect(environ).toContain("BOARD_BIND=127.0.0.1");
  }, 30_000);
});

describe("board down", () => {
  test("contract 4: alive teardown — end before export, keepsakes, cleanup", async () => {
    const dir = freshDir();
    const md = join(dir, "work.md");
    writeFileSync(md, V1_MD);
    const res = await runCli(["up", md], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    const boardId = boardIdFrom(up);
    const paths = instancePaths(dir, up.id);
    const entry = JSON.parse(readFileSync(paths.json, "utf8")) as {
      pid: number;
      dataDir: string;
    };

    // pre-kill sanity: the board is open over REST
    const view = (await (
      await fetch(`${up.url}/api/boards/${boardId}`, {
        headers: { authorization: `Bearer ${up.token}` },
      })
    ).json()) as { board: { status: string } };
    expect(view.board.status).toBe("open");

    const down = await runCli(["down", up.id], { BOARD_DATA_DIR: dir });
    expect(down.exitCode).toBe(0);
    await expectRefused(up.url); // port refuses connections
    expect(existsSync(entry.dataDir)).toBe(false); // temp dir purged
    expect(existsSync(paths.env)).toBe(false); // env purged
    expect(readFileSync(paths.log, "utf8")).toContain("listening"); // audit keepsake

    // the keepsake zip exists and the board in it was ENDED before export —
    // proven by re-importing it (import restores the exported status)
    expect(readdirSync(paths.boards)).toEqual([`${boardId}.zip`]);
    const server = startTestServer();
    trackDir(server.dataDir);
    try {
      const reimporter = await server.createAgent("reimport");
      const ires = await fetch(`${server.hostUrl}/api/boards/import`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${reimporter.token}`,
          "content-type": "application/zip",
        },
        body: Buffer.from(
          await Bun.file(join(paths.boards, `${boardId}.zip`)).arrayBuffer(),
        ),
      });
      expect(ires.status).toBe(201);
      const imported = (await ires.json()) as { status: string };
      expect(imported.status).toBe("ended");
    } finally {
      await server.stop();
    }

    const closed = JSON.parse(readFileSync(paths.json, "utf8")) as {
      closedAt?: string;
      boards?: string[];
    };
    expect(closed.closedAt).toBeDefined();
    expect(closed.boards).toEqual([boardId]);
    // idempotent: a second down is a friendly no-op
    const again = await runCli(["down", up.id], { BOARD_DATA_DIR: dir });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already closed");
  }, 60_000);

  test("contract 5: down on a SIGKILLed instance still produces keepsakes", async () => {
    const dir = freshDir();
    const md = join(dir, "doomed.md");
    writeFileSync(md, V1_MD);
    const res = await runCli(["up", md], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    const boardId = boardIdFrom(up);
    const paths = instancePaths(dir, up.id);
    const entry = JSON.parse(readFileSync(paths.json, "utf8")) as {
      pid: number;
      dataDir: string;
    };
    process.kill(entry.pid, "SIGKILL");
    await awaitGone(entry.pid);

    // down via $BOARD_INSTANCE (the env-file resolution path)
    const down = await runCli(["down"], {
      BOARD_DATA_DIR: dir,
      BOARD_INSTANCE: up.id,
    });
    expect(down.exitCode).toBe(0);
    expect(down.stdout).toContain("already dead");
    expect(readdirSync(paths.boards)).toEqual([`${boardId}.zip`]);
    expect(existsSync(entry.dataDir)).toBe(false);
    expect(existsSync(paths.env)).toBe(false);
    await expectRefused(up.url);
  }, 60_000);

  test("contract 6: pid spoof — down refuses to signal a foreign live pid", async () => {
    const dir = freshDir();
    const decoy = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const id = "s-spoofedid0";
      const paths = instancePaths(dir, id);
      mkdirSync(paths.dir, { recursive: true });
      // a registry entry whose pid is a live non-board process; the dataDir
      // must be a structurally valid session dir so the F1 shape guard
      // passes and the PID-identity refusal is what fires here
      const spoofDataDir = mkdtempSync(join(tmpdir(), "board-instance-"));
      trackDir(spoofDataDir); // the foreign-pid refusal must not leak it
      writeInstanceEntry(paths, {
        id,
        pid: decoy.pid,
        port: 1,
        url: "http://127.0.0.1:1",
        dataDir: spoofDataDir,
        agentTokenName: "session",
        createdAt: new Date().toISOString(),
      });
      const down = await runCli(["down", id], { BOARD_DATA_DIR: dir });
      expect(down.exitCode).toBe(1);
      expect(down.stderr).toContain("refusing to signal");
      // the decoy is untouched, and the entry was not mutated into "closed"
      expect(existsSync(`/proc/${decoy.pid}`)).toBe(true);
      const entry = JSON.parse(readFileSync(paths.json, "utf8")) as {
        closedAt?: string;
      };
      expect(entry.closedAt).toBeUndefined();
    } finally {
      decoy.kill("SIGKILL");
      await decoy.exited;
    }
  }, 30_000);

  test("contract 11: corrupt dataDir — down refuses to signal or purge a live daemon (audit F1)", async () => {
    const dir = freshDir();
    // the audit's live repro: a REAL board daemon on a data dir that is NOT
    // a session temp dir, plus a crafted entry pointing `down` at it —
    // without the structural guard this SIGTERMs the victim and purges it
    const victim = mkdtempSync(join(tmpdir(), "board-victim-"));
    trackDir(victim);
    const decoy = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "..", "server", "src", "main.ts"),
      ],
      {
        env: { BOARD_DATA_DIR: victim, BOARD_PORT: "0" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    trackDaemon({ pid: decoy.pid, dataDir: victim });
    expect(existsSync(`/proc/${decoy.pid}`)).toBe(true); // alive pre-down

    const id = "s-decoyed000";
    const paths = instancePaths(dir, id);
    mkdirSync(paths.dir, { recursive: true });
    writeInstanceEntry(paths, {
      id,
      pid: decoy.pid,
      port: 1,
      url: "http://127.0.0.1:1",
      dataDir: victim,
      agentTokenName: "session",
      createdAt: new Date().toISOString(),
    });

    const down = await runCli(["down", id], { BOARD_DATA_DIR: dir });
    expect(down.exitCode).toBe(1);
    expect(down.stderr).toContain(id);
    expect(down.stderr).toContain("corrupt");
    // decoy alive, victim dir intact, entry not stamped closed
    expect(existsSync(`/proc/${decoy.pid}`)).toBe(true);
    expect(existsSync(victim)).toBe(true);
    const entry = readInstanceEntry(paths);
    expect(entry?.closedAt).toBeUndefined();
  }, 30_000);

  test("contract 12: corrupt dataDir + dead pid — down and up-prune both refuse (audit F1)", async () => {
    const dir = freshDir();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    // sentinel NON-tmp dir: a purge that ignored the guard would eat this
    const sentinel = join(dir, "victim-data");
    mkdirSync(sentinel);
    writeFileSync(join(sentinel, "keep-me.txt"), "do not delete");

    const id = "s-stalepid00";
    const paths = instancePaths(dir, id);
    mkdirSync(paths.dir, { recursive: true });
    writeInstanceEntry(paths, {
      id,
      pid: dead.pid,
      port: 1,
      url: "http://127.0.0.1:1",
      dataDir: sentinel,
      agentTokenName: "session",
      createdAt: new Date().toISOString(),
    });

    // down refuses: the dead-pid path used to purge with NO identity check
    const down = await runCli(["down", id], { BOARD_DATA_DIR: dir });
    expect(down.exitCode).toBe(1);
    expect(down.stderr).toContain(id);
    expect(down.stderr).toContain("corrupt");
    expect(existsSync(join(sentinel, "keep-me.txt"))).toBe(true);

    // up's self-heal prune REPORTS the corrupt entry and moves on (no
    // auto-action), then spawns normally
    const up = await runCli(["up"], { BOARD_DATA_DIR: dir });
    expect(up.exitCode).toBe(0);
    expect(up.stderr).toContain(id);
    expect(up.stderr).toContain("corrupt");
    trackInstance(dir, parseUp(up.stdout));
    expect(existsSync(join(sentinel, "keep-me.txt"))).toBe(true);
  }, 60_000);
});

describe("board instances / prune", () => {
  test("contract 9: next up prunes a stale entry with keepsakes and reports it", async () => {
    const dir = freshDir();
    const md = join(dir, "stale.md");
    writeFileSync(md, V1_MD);
    const res = await runCli(["up", md], { BOARD_DATA_DIR: dir });
    expect(res.exitCode).toBe(0);
    const up = parseUp(res.stdout);
    trackInstance(dir, up);
    const boardId = boardIdFrom(up);
    const oldPaths = instancePaths(dir, up.id);
    const oldEntry = JSON.parse(readFileSync(oldPaths.json, "utf8")) as {
      pid: number;
      dataDir: string;
    };
    process.kill(oldEntry.pid, "SIGKILL");
    await awaitGone(oldEntry.pid);

    // the default view reports the stale entry with the prune hint
    const list = await runCli(["instances"], { BOARD_DATA_DIR: dir });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(up.id);
    expect(list.stdout).toContain("stale");
    expect(list.stderr).toContain("--prune");

    // the next up prunes it, reports it, and keepsakes the board
    const up2 = await runCli(["up"], { BOARD_DATA_DIR: dir });
    expect(up2.exitCode).toBe(0);
    const up2out = parseUp(up2.stdout);
    trackInstance(dir, up2out);
    expect(up2out.id).not.toBe(up.id);
    expect(up2.stdout).toMatch(/pruned stale instance s-[0-9A-Za-z]{10}/);
    expect(readdirSync(oldPaths.boards)).toEqual([`${boardId}.zip`]);
    const closed = JSON.parse(readFileSync(oldPaths.json, "utf8")) as {
      closedAt?: string;
    };
    expect(closed.closedAt).toBeDefined();
    expect(existsSync(oldPaths.env)).toBe(false);
    expect(existsSync(oldEntry.dataDir)).toBe(false);

    // --all shows the closed entry alongside the fresh live one
    const all = await runCli(["instances", "--all"], { BOARD_DATA_DIR: dir });
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain(up.id);
    expect(all.stdout).toContain("closed");
    expect(all.stdout).toContain(up2out.id);
  }, 60_000);

  test("contract 15: prune spares a young booting entry, reaps an old orphan (audit F3)", async () => {
    const dir = freshDir();
    const dead = Bun.spawn(["true"]);
    await dead.exited;

    // young booting entry with an already-dead pid: ONLY the boot-age guard
    // protects it (another shell's up may still be mid-boot)
    const youngDir = mkdtempSync(join(tmpdir(), "board-instance-"));
    trackDir(youngDir);
    const youngId = "s-youngboot0";
    mkdirSync(instancePaths(dir, youngId).dir, { recursive: true });
    writeInstanceEntry(instancePaths(dir, youngId), {
      id: youngId,
      pid: dead.pid,
      dataDir: youngDir,
      agentTokenName: "session",
      createdAt: new Date().toISOString(),
      booting: true,
    });
    const list = await runCli(["instances"], { BOARD_DATA_DIR: dir });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(youngId);
    expect(list.stdout).toContain("booting");
    const prune = await runCli(["instances", "--prune"], {
      BOARD_DATA_DIR: dir,
    });
    expect(prune.exitCode).toBe(0);
    expect(existsSync(youngDir)).toBe(true);
    const young = readInstanceEntry(instancePaths(dir, youngId));
    expect(young?.closedAt).toBeUndefined();

    // the same shape, aged past the boot grace: reaped as a SIGKILL orphan
    const oldDir = mkdtempSync(join(tmpdir(), "board-instance-"));
    const oldId = "s-oldboot000";
    mkdirSync(instancePaths(dir, oldId).dir, { recursive: true });
    writeInstanceEntry(instancePaths(dir, oldId), {
      id: oldId,
      pid: dead.pid,
      dataDir: oldDir,
      agentTokenName: "session",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      booting: true,
    });
    const prune2 = await runCli(["instances", "--prune"], {
      BOARD_DATA_DIR: dir,
    });
    expect(prune2.exitCode).toBe(0);
    expect(existsSync(oldDir)).toBe(false);
    const old = readInstanceEntry(instancePaths(dir, oldId));
    expect(old?.closedAt).toBeDefined();
  }, 30_000);
});

describe("boot-window orphaning (audit F3)", () => {
  test("contract 13: SIGKILL mid-boot leaves a booting entry `down` can manage", async () => {
    const dir = freshDir();
    const up = Bun.spawn(
      [process.execPath, join(import.meta.dir, "main.ts"), "up"],
      { env: { BOARD_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" },
    );
    const booting = await awaitBootingEntry(dir);
    // track for afterAll in case an assert fails before down
    trackDaemon({ pid: booting.pid, dataDir: booting.dataDir });
    // minimal pre-readiness shape: no port/url yet
    expect(booting.url).toBeUndefined();
    // the daemon is real and carries the instance's BOARD_DATA_DIR (the
    // environ identity `down` will use)
    const environ = readFileSync(`/proc/${booting.pid}/environ`, "utf8").split(
      "\0",
    );
    expect(environ).toContain(`BOARD_DATA_DIR=${booting.dataDir}`);
    up.kill("SIGKILL");
    await up.exited;
    // the entry survives the SIGKILL (the backstop)…
    const stamped = readInstanceEntry(instancePaths(dir, booting.id));
    expect(stamped?.booting).toBe(true);
    // …and down manages it: kills the daemon, purges the temp dir, stamps closed
    const down = await runCli(["down", booting.id], { BOARD_DATA_DIR: dir });
    expect(down.exitCode).toBe(0);
    await awaitGone(booting.pid);
    expect(existsSync(booting.dataDir)).toBe(false);
    const closed = readInstanceEntry(instancePaths(dir, booting.id));
    expect(closed?.closedAt).toBeDefined();
  }, 30_000);

  test("contract 14: SIGTERM mid-boot cleans daemon, dirs, and entry", async () => {
    const dir = freshDir();
    const up = Bun.spawn(
      [process.execPath, join(import.meta.dir, "main.ts"), "up"],
      { env: { BOARD_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" },
    );
    const booting = await awaitBootingEntry(dir);
    // track for afterAll in case an assert fails mid-test
    trackDaemon({ pid: booting.pid, dataDir: booting.dataDir });
    up.kill("SIGTERM");
    const code = await up.exited;
    expect(code).toBe(143); // the boot-window handler's non-zero exit
    // the handler ran the catch-path cleanup: no daemon, no temp dir, no
    // registry entry left behind
    await awaitGone(booting.pid);
    expect(existsSync(booting.dataDir)).toBe(false);
    expect(existsSync(instancePaths(dir, booting.id).dir)).toBe(false);
  }, 30_000);

  // Every live daemon whose BOARD_DATA_DIR is an OS-temp instance dir. The
  // daemon is not this process's child, so /proc is the only way to see it —
  // and filesystem assertions cannot: an unkilled daemon RECREATES the temp
  // dir that rmSync just deleted, so "no leaked dir" passes while an orphan
  // holding a live token runs on (found by audit, 2026-09-25).
  const liveInstanceDaemons = (): number[] => {
    const pids: number[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) {
        continue;
      }
      try {
        const environ = readFileSync(`/proc/${name}/environ`, "utf8");
        if (
          environ.includes(
            `BOARD_DATA_DIR=${join(tmpdir(), "board-instance-")}`,
          )
        ) {
          pids.push(Number(name));
        }
      } catch {
        // the process exited between readdir and read, or is not ours
      }
    }
    return pids;
  };

  // The other way a boot ends badly: readiness never arrives. It runs the SAME
  // abortBoot closure as the two signal tests above (they were two hand-copied
  // cleanups before, with only a comment asserting they matched). The signal
  // tests assert the daemon dies via awaitGone; this one cannot — spawnInstance
  // rejects without handing back a pid — so it asserts the same invariant by
  // scanning /proc. Without that scan this test passes with the SIGKILL removed
  // from abortBoot, which is the one half of the cleanup consolidation could
  // ever break.
  test("a boot that never becomes ready leaves no daemon, no temp dir, no entry", async () => {
    const dir = freshDir();
    const daemonsBefore = new Set(liveInstanceDaemons());
    const tempBefore = new Set(
      readdirSync(tmpdir()).filter((name) =>
        name.startsWith("board-instance-"),
      ),
    );
    // 1ms is shorter than any real boot, so readiness cannot win the race.
    await expect(
      spawnInstance({
        registryDataDir: dir,
        agentTokenName: "session",
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/not ready after 1ms|exited before becoming ready/);
    // The daemon first: an orphan is the failure that costs something (a live
    // process holding an unrecoverable token), and it is the one a leaked-dir
    // check cannot see.
    const orphans = liveInstanceDaemons().filter(
      (pid) => !daemonsBefore.has(pid),
    );
    for (const pid of orphans) {
      trackDaemon({ pid, dataDir: "" });
    }
    expect(orphans).toEqual([]);
    const leaked = readdirSync(tmpdir()).filter(
      (name) => name.startsWith("board-instance-") && !tempBefore.has(name),
    );
    expect(leaked).toEqual([]);
    expect(
      existsSync(instancesRoot(dir)) ? readdirSync(instancesRoot(dir)) : [],
    ).toEqual([]);
  }, 30_000);

  test("contract 16: down --instance <id> works; positional still does (N6)", async () => {
    const dir = freshDir();
    const first = await runCli(["up"], { BOARD_DATA_DIR: dir });
    expect(first.exitCode).toBe(0);
    const firstUp = parseUp(first.stdout);
    trackInstance(dir, firstUp);
    const byFlag = await runCli(["down", "--instance", firstUp.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(byFlag.exitCode).toBe(0);
    expect(byFlag.stdout).toContain(firstUp.id);

    const second = await runCli(["up"], { BOARD_DATA_DIR: dir });
    expect(second.exitCode).toBe(0);
    const secondUp = parseUp(second.stdout);
    trackInstance(dir, secondUp);
    const byPositional = await runCli(["down", secondUp.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(byPositional.exitCode).toBe(0);
  }, 60_000);
});
