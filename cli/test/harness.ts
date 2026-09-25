// Shared driver for the CLI's subprocess contract tests (cli/src/*.test.ts)
// and scripts/smoke.ts — the cli/ counterpart of server/test/helpers.ts.
//
// The point is ONE parser for `board up`'s stdout. That output contract had
// four independent copies (three test files plus the smoke), so changing the
// printed lines and updating three of them failed nothing loudly. Everything
// else here is the same tracked-subprocess discipline all three test files
// need: temp BOARD_DATA_DIR only (never the real ~/.board — AGENTS.md), and
// every spawned daemon force-killed in cleanup so a failing assertion cannot
// leak a process or a /tmp/board-instance-* dir.
//
// Runs under Bun only (Bun.spawn/Bun.sleep) — every consumer does. Never
// import this from cli/src/mcp-connector.ts, which must stay node-runnable.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instancePaths } from "../src/instances.ts";

export interface Proc {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// The lines `board up` prints (commands/instances.ts runUp) — the contract
// this module exists to keep single-sourced. `human` is absent when `up` ran
// without a file argument (nothing published, no link).
export interface UpOutput {
  id: string;
  url: string;
  token: string;
  envPath: string;
  human?: string;
}

export function parseUp(stdout: string): UpOutput {
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
  if (head === null || token === undefined || envPath === undefined) {
    throw new Error(`could not parse up output:\n${stdout}`);
  }
  return { id: head[1] ?? "", url: head[2] ?? "", token, envPath, human };
}

export function boardIdFrom(up: UpOutput): string {
  const id = /#\/boards\/([0-9A-Za-z]{10})/.exec(up.human ?? "")?.[1];
  if (id === undefined) {
    throw new Error(`no human link board id in up output:\n${up.human}`);
  }
  return id;
}

// The daemon is not this process's child, so /proc is the only liveness
// mechanism (the same reason instances.ts polls it).
export async function awaitGone(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(`/proc/${pid}`)) {
    if (Date.now() > deadline) {
      throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    }
    await Bun.sleep(50);
  }
}

// A spawned session daemon, as the registry records it — pid + dataDir is
// everything cleanup needs (kill, then purge the temp dir).
export interface TrackedDaemon {
  pid: number;
  dataDir: string;
}

export interface CliHarness {
  // A fresh temp BOARD_DATA_DIR, removed by cleanup.
  freshDir(): string;
  // Any other directory cleanup should remove (crafted fixtures, a test
  // server's data dir).
  trackDir(dir: string): void;
  // A daemon this test spawned by hand (a decoy, a mid-boot `up`).
  trackDaemon(daemon: TrackedDaemon): void;
  // A daemon `board up` spawned: the pid is read back from the registry,
  // because the CLI output deliberately does not print it.
  trackInstance(dir: string, up: UpOutput): TrackedDaemon;
  // The real CLI as a subprocess — the only way these tests exercise it.
  runCli(args: string[], env?: Record<string, string>): Promise<Proc>;
  cleanup(): void;
}

// One harness per test file: the tracked dirs/pids are file-scoped, so a
// file's afterAll cleans up exactly what that file created even though bun
// test shares the module registry across files.
export function createCliHarness(prefix: string): CliHarness {
  const dirs: string[] = [];
  const daemons: TrackedDaemon[] = [];
  const cliEntry = join(import.meta.dir, "..", "src", "main.ts");

  const trackInstance = (dir: string, up: UpOutput): TrackedDaemon => {
    const entry = JSON.parse(
      readFileSync(instancePaths(dir, up.id).json, "utf8"),
    ) as TrackedDaemon;
    daemons.push({ pid: entry.pid, dataDir: entry.dataDir });
    return entry;
  };

  return {
    freshDir: () => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    trackDir: (dir) => {
      dirs.push(dir);
    },
    trackDaemon: (daemon) => {
      daemons.push(daemon);
    },
    trackInstance,
    runCli: async (args, env = {}) => {
      const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { exitCode: exitCode ?? -1, stdout, stderr };
    },
    cleanup: () => {
      for (const { pid } of daemons) {
        if (existsSync(`/proc/${pid}`)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      // The instance temp data dirs too — a test failing before its down must
      // not orphan /tmp/board-instance-* dirs.
      for (const { dataDir } of daemons) {
        rmSync(dataDir, { recursive: true, force: true });
      }
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
