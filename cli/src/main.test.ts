import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-cli-main-test-"));
  dirs.push(dir);
  return dir;
}

interface Proc {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Proc {
  const proc = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "main.ts"), ...args],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("board cli", () => {
  test("subprocess: token add exits 0 and prints a token exactly once", () => {
    const dir = freshDir();
    const proc = runCli(["token", "add", "smoke"], { BOARD_DATA_DIR: dir });
    expect(proc.exitCode).toBe(0);
    const token = proc.stdout
      .split("\n")
      .find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
    expect(token).toBeDefined();
    expect(proc.stdout.split(token ?? "")).toHaveLength(2);
    expect(proc.stdout).toContain("not recoverable");
    expect(proc.stderr).toBe("");
  });

  test("subprocess: board open prints a one-time exchange URL on the default port", () => {
    const dir = freshDir();
    const proc = runCli(["open"], { BOARD_DATA_DIR: dir });
    expect(proc.exitCode).toBe(0);
    const url = proc.stdout.trim();
    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:7800\/\?token=[A-Za-z0-9_-]{43}$/,
    );
    const token = /\?token=([A-Za-z0-9_-]{43})/.exec(url)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(proc.stdout.split(token)).toHaveLength(2);
    expect(proc.stderr).not.toContain(token);
  });

  test("subprocess: board open <ID> deep-links to the board", () => {
    const dir = freshDir();
    const proc = runCli(["open", "ab12cd34ef"], { BOARD_DATA_DIR: dir });
    expect(proc.exitCode).toBe(0);
    const url = proc.stdout.trim();
    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:7800\/\?token=[A-Za-z0-9_-]{43}#\/boards\/ab12cd34ef$/,
    );
    const token = /\?token=([A-Za-z0-9_-]{43})/.exec(url)?.[1] ?? "";
    expect(proc.stderr).not.toContain(token);
  });

  test("--help and bare invocation print usage listing every command", () => {
    for (const args of [[], ["--help"]]) {
      const proc = runCli(args);
      expect(proc.exitCode).toBe(0);
      expect(proc.stderr).toBe("");
      for (const entry of [
        "serve",
        "token add",
        "token list",
        "token revoke",
        "list",
        "open",
        "export",
        "import",
        "status <board id>",
        "one board's health",
      ]) {
        expect(proc.stdout).toContain(entry);
      }
    }
  });

  test("an unknown command exits 1 with usage on stderr", () => {
    const proc = runCli(["frobnicate"]);
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain("frobnicate");
    expect(proc.stderr).toContain("serve");
  });

  test("bare token (usage error) never creates the default data dir", () => {
    const home = freshDir();
    const proc = runCli(["token"], { HOME: home });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain("usage");
    expect(existsSync(join(home, ".board"))).toBe(false);
  });

  test("token add --force without a name (usage error) never creates the default data dir", () => {
    const home = freshDir();
    const proc = runCli(["token", "add", "--force"], { HOME: home });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain("usage");
    expect(existsSync(join(home, ".board"))).toBe(false);
  });
});

// The serve command shares server/src/main.ts's runDaemon (the two entrypoints
// were byte-identical copies before consolidating) — exercised as a real
// subprocess: listen line, health, then SIGTERM runs the shutdown handler and
// exits 0.
describe("board serve (runDaemon)", () => {
  test("subprocess: daemon serves health, SIGTERM exits 0", async () => {
    const dir = freshDir();
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "main.ts"), "serve"],
      {
        env: { BOARD_DATA_DIR: dir, BOARD_PORT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const deadline = Date.now() + 10000;
      let url = "";
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let out = "";
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        out += decoder.decode(value, { stream: true });
        const match = /board: host app listening on (http:\S+)/.exec(out);
        if (match !== null) {
          url = match[1];
          break;
        }
      }
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await fetch(`${url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});
