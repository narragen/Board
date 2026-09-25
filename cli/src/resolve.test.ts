// D20 wave-2 contract tests: instance RESOLUTION across the CLI — every case
// runs the real CLI as a subprocess with temp BOARD_DATA_DIR everywhere,
// never the real ~/.board. The subprocess driver, the `board up` stdout
// parser and the spawned-daemon tracking come from cli/test/harness.ts (one
// copy, shared with instances/resume and the smoke); tracked daemons are
// force-killed in afterAll so a failing assertion cannot leak a process.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../server/src/db.ts";
import {
  awaitGone,
  boardIdFrom,
  createCliHarness,
  parseUp,
  type UpOutput,
} from "../test/harness.ts";
import {
  instancePaths,
  readInstanceEntry,
  writeInstanceEntry,
} from "./instances.ts";

const harness = createCliHarness("board-cli-resolve-test-");
const { freshDir, runCli, trackInstance } = harness;

afterAll(() => {
  harness.cleanup();
});

const MD =
  "# Resolution fixture\n\n## Section one\n\nThe resolver must find this board.\n";

// up a fixture instance; returns the parsed output + the tracked pid entry.
async function spawnFixture(dir: string): Promise<{
  up: UpOutput;
  entry: { pid: number; dataDir: string };
  boardId: string;
}> {
  const md = join(dir, "fixture.md");
  writeFileSync(md, MD);
  const res = await runCli(["up", md], { BOARD_DATA_DIR: dir });
  expect(res.exitCode).toBe(0);
  const up = parseUp(res.stdout);
  const entry = trackInstance(dir, up);
  return { up, entry, boardId: boardIdFrom(up) };
}

describe("open --instance (resolution + link)", () => {
  test("contract 1: the link is served by the INSTANCE and exchanges", async () => {
    const dir = freshDir();
    const { up, boardId } = await spawnFixture(dir);
    const res = await runCli(["open", "--instance", up.id, boardId], {
      BOARD_DATA_DIR: dir,
    });
    expect(res.exitCode).toBe(0);
    const url = res.stdout.trim();
    // the link points at the INSTANCE's port, in the exact human-link shape
    expect(url).toMatch(
      new RegExp(
        `^${up.url.replace(/:/g, "\\:")}\\/\\?token=[A-Za-z0-9_-]{43}#\\/boards\\/${boardId}$`,
      ),
    );
    // the link's exchange token swaps for a session that reads the board
    const exchange = /\?token=([A-Za-z0-9_-]{43})/.exec(url)?.[1] ?? "";
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
});

describe("BOARD_INSTANCE env + precedence", () => {
  test("contract 2: `board list` follows BOARD_INSTANCE to the instance db", async () => {
    const dir = freshDir();
    const { up, boardId } = await spawnFixture(dir);
    // NO BOARD_TOKEN env — the credential comes from the instance env file;
    // no shared daemon exists on :7800, so success itself proves redirection.
    const res = await runCli(["list"], {
      BOARD_DATA_DIR: dir,
      BOARD_INSTANCE: up.id,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain(boardId);
    expect(res.stdout).toContain("fixture.md");
  }, 30_000);

  test("contract 3a: --instance flag beats a bogus BOARD_INSTANCE env", async () => {
    const dir = freshDir();
    const { up, boardId } = await spawnFixture(dir);
    // env points at a dead id; the flag must win
    const res = await runCli(["list", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
      BOARD_INSTANCE: "s-bogus00000",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(boardId);
    // and the mirror: the flag pointing at a dead id must NOT fall back to env
    const back = await runCli(["list", "--instance", "s-bogus00000"], {
      BOARD_DATA_DIR: dir,
      BOARD_INSTANCE: up.id,
    });
    expect(back.exitCode).toBe(1);
    expect(back.stderr).toContain("s-bogus00000");
  }, 30_000);

  test("contract 3b: --token beats a (sabotaged) env-file token", async () => {
    const dir = freshDir();
    const { up, boardId } = await spawnFixture(dir);
    const paths = instancePaths(dir, up.id);
    // sabotage the env-file credential: env-file alone must now fail
    writeFileSync(
      paths.env,
      `export BOARD_INSTANCE=${up.id}\nexport BOARD_TOKEN=bogus-token\n`,
    );
    const sabotaged = await runCli(["list", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(sabotaged.exitCode).toBe(1);
    // --token must override the sabotaged env file and succeed
    const res = await runCli(
      ["list", "--instance", up.id, "--token", up.token],
      { BOARD_DATA_DIR: dir },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(boardId);
    // the missing middle link (audit test-gap): BOARD_TOKEN env beats the
    // sabotaged env-file token too — env file is the LAST fallback
    const envBeat = await runCli(["list", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
      BOARD_TOKEN: up.token,
    });
    expect(envBeat.exitCode).toBe(0);
    expect(envBeat.stdout).toContain(boardId);
  }, 30_000);

  test("contract 8: a non-loopback entry url refuses the credential (audit N3)", async () => {
    const dir = freshDir();
    const { up } = await spawnFixture(dir);
    const paths = instancePaths(dir, up.id);
    const entry = readInstanceEntry(paths);
    if (entry === null) {
      throw new Error("no instance entry for the fixture");
    }
    // url and pid are independently tamperable in the registry — point the
    // entry's url off-loopback; the env-file bearer must never go there
    writeInstanceEntry(paths, { ...entry, url: "http://10.0.0.1:7800/" });
    const t0 = Date.now();
    const res = await runCli(["list", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(up.id);
    expect(res.stderr).toContain("not loopback");
    // refused BEFORE any fetch: a request to 10.0.0.1 would hang on connect
    // timeouts — the fast failure itself is the no-request proof
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});

describe("export --instance on a closed instance", () => {
  test("contract 4a: down --keep-data then export zips from disk to cwd", async () => {
    const dir = freshDir();
    const { up, boardId } = await spawnFixture(dir);
    const down = await runCli(["down", up.id, "--keep-data"], {
      BOARD_DATA_DIR: dir,
    });
    expect(down.exitCode).toBe(0);

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const res = await runCli(["export", "--instance", up.id, boardId], {
        BOARD_DATA_DIR: dir,
      });
      expect(res.exitCode).toBe(0);
      const file = join(dir, `${boardId}.zip`);
      expect(existsSync(file)).toBe(true);
      expect(res.stdout).toContain(`${boardId}.zip`);
      // non-empty and a real zip (PK magic) — re-importable by construction
      const bytes = new Uint8Array(readFileSync(file));
      expect(bytes.length).toBeGreaterThan(0);
      expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    } finally {
      process.chdir(cwd);
    }
  }, 60_000);

  test("contract 4b: a purged dataDir errors pointing at the keepsake zips", async () => {
    const dir = freshDir();
    const { up, boardId } = await spawnFixture(dir);
    const down = await runCli(["down", up.id], { BOARD_DATA_DIR: dir });
    expect(down.exitCode).toBe(0);
    const keepsakes = instancePaths(dir, up.id).boards;

    const res = await runCli(["export", "--instance", up.id, boardId], {
      BOARD_DATA_DIR: dir,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("purged at teardown");
    expect(res.stderr).toContain(keepsakes);
    // and the keepsakes really are there to be pointed at
    expect(readdirSync(keepsakes)).toEqual([`${boardId}.zip`]);
  }, 60_000);
});

describe("dead instance errors", () => {
  test("contract 5: open/list on a killed instance error clearly, exit 1", async () => {
    const dir = freshDir();
    const { up } = await spawnFixture(dir);
    const entry = trackInstanceData(dir, up);
    process.kill(entry.pid, "SIGKILL");
    await awaitGone(entry.pid);

    const open = await runCli(["open", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(open.exitCode).toBe(1);
    expect(open.stderr).toContain(up.id);
    expect(open.stderr).toContain("not running");

    const list = await runCli(["list", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toContain(up.id);
    expect(list.stderr).toContain("not serving REST");
  }, 30_000);

  test("contract 6: an unknown id errors listing the live instances", async () => {
    const dir = freshDir();
    const { up } = await spawnFixture(dir);
    const res = await runCli(["list", "--instance", "s-nonexistnt"], {
      BOARD_DATA_DIR: dir,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('unknown instance "s-nonexistnt"');
    expect(res.stderr).toContain(up.id);
  }, 30_000);
});

describe("token --instance (dataDir resolution)", () => {
  test("contract 7: token add lands in the INSTANCE db, list sees it", async () => {
    const dir = freshDir();
    const { up } = await spawnFixture(dir);
    const entry = trackInstanceData(dir, up);

    const add = await runCli(["token", "add", "extra", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(add.exitCode).toBe(0);
    const minted = add.stdout
      .split("\n")
      .find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
    expect(minted).toBeDefined();

    // the row is in the instance's temp db, not the shared one
    const db = openDb(entry.dataDir);
    try {
      const names = (
        db.prepare("SELECT name FROM tokens ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(names).toEqual(["extra", "session"]);
    } finally {
      db.close();
    }

    const list = await runCli(["token", "list", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("extra");
  }, 30_000);

  test("contract 7b: token add with NO name mints a generated handle on the instance db", async () => {
    const dir = freshDir();
    const { up } = await spawnFixture(dir);
    const entry = trackInstanceData(dir, up);

    // no name argument at all — the generated-handle path must work through
    // the same --instance resolution (no special-casing)
    const add = await runCli(["token", "add", "--instance", up.id], {
      BOARD_DATA_DIR: dir,
    });
    expect(add.exitCode).toBe(0);
    const minted = add.stdout
      .split("\n")
      .find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
    expect(minted).toBeDefined();
    const name = /^token for "([^"]+)" /.exec(add.stdout)?.[1] ?? "";
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);

    const db = openDb(entry.dataDir);
    try {
      const names = (
        db.prepare("SELECT name FROM tokens ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      // the generated handle lands next to the up-minted "session" token
      expect(names).toEqual([name, "session"].sort());
    } finally {
      db.close();
    }
  }, 30_000);
});

// Re-read the registry pid (spawnFixture already tracked it; this second read
// keeps the dead-instance test independent of spawnFixture's return shape).
function trackInstanceData(
  dir: string,
  up: UpOutput,
): { pid: number; dataDir: string } {
  return JSON.parse(readFileSync(instancePaths(dir, up.id).json, "utf8")) as {
    pid: number;
    dataDir: string;
  };
}
