import { describeEphemeralDataDir, loadConfig } from "./config.ts";
import { startDaemon } from "./daemon.ts";

// The readiness print is the daemon's one machine-readable contract —
// cli/src/instances.ts (waitForListenLine) matches this exact pattern to know
// a spawned daemon is up, so the line and its pattern live in ONE place.
// Byte-stable: tests regex-match it. [wave 2 hoist]
export const LISTEN_LINE = /board: host app listening on (http:\S+)/;

// The daemon lifecycle — config load, start, signal handling — defined once
// here and reused by the CLI's `board serve` (cli/src/commands/serve.ts),
// which was previously a byte-for-byte copy of this file.
export async function runDaemon(): Promise<void> {
  const config = loadConfig();

  // stderr, and before the listen line: LISTEN_LINE is a machine-readable
  // contract on stdout (cli/src/instances.ts matches it), so nothing advisory
  // goes near that stream.
  const ephemeral = describeEphemeralDataDir(config.dataDir);
  if (ephemeral !== null) {
    console.error(ephemeral);
  }

  const daemon = startDaemon(config);

  console.log(`board: host app listening on ${daemon.hostUrl}`);

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void daemon.stop().then(() => {
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The daemon runs until a signal handler exits the process — park forever.
  await new Promise<never>(() => undefined);
}

if (import.meta.main) {
  await runDaemon();
}
