#!/usr/bin/env bun

import { loadConfig } from "../../server/src/config.ts";
import { openDb } from "../../server/src/db.ts";
import { runBoardsCommand } from "./commands/boards.ts";
import {
  INSTALL_USAGE,
  parseInstallArgs,
  runInstallCommand,
} from "./commands/install.ts";
import { runInstancesCommand } from "./commands/instances.ts";
import { runOpenCommand } from "./commands/open.ts";
import { runServe } from "./commands/serve.ts";
import { runStatusCommand } from "./commands/status.ts";
import {
  type CommandIo,
  runTokenCommand,
  TOKEN_USAGE,
} from "./commands/token.ts";
import { runMcpConnector } from "./mcp-connector.ts";

const USAGE = `board — local-first shared boards

usage: board <command> [args]

commands:
  serve                run the board daemon (loopback only)
  token add [name]     create an agent token; no name mints a generated
                       color-animal handle; printed once, never recoverable
  token list           list tokens: name, created, last used, revoked
  token revoke <name>  revoke an agent token
  install              wire the board MCP server into local agents (mints tokens)
  list                 list boards: status, current version, unresolved comments
  open [board id]      open the web UI in a browser (one-time token)
  export <id> [file]   save a board bundle as a zip (default <id>.zip)
  import <file>        recreate a board from a bundle under a fresh board id
  status <board id>    one board's health: status, version, unresolved comments
  up [file]            spawn a session instance (temp data dir, random port);
                       a file publishes as v1 and prints a one-time human link;
                       --resume[=latest|all|<instance-id>] reimports a prior
                       session's keepsake boards into the fresh instance
  down [id]            tear down a session instance (id, --instance <id>, or
                       $BOARD_INSTANCE): end boards, keep zip keepsakes, purge
                       temp data + env
  instances            list session instances (live; --all closed; --prune stale)
  mcp                  run the stdio MCP connector for agent harnesses (also:
                       node cli/src/mcp-connector.ts — resolves the shared
                       daemon or a session instance per request)

Session instances (board up): list/open/export/import/status and token
add/list/revoke accept --instance <id> (or BOARD_INSTANCE — set by sourceing
an instance env file) and target that instance's daemon/db instead of the
shared one. export works on a closed instance too (zips from disk).

REST commands (list/status/export/import) authenticate with --token <token> or
BOARD_TOKEN; with --instance the instance env file's token is the fallback.
Mint one with: make token add cli
`;

function consoleIo(): CommandIo {
  return {
    stdout: (text) => {
      console.log(text);
    },
    stderr: (text) => {
      console.error(text);
    },
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return 0;
    case "serve":
      runServe();
      return 0;
    case "token": {
      // Validate before opening any db: usage-error paths must not create the
      // data dir (twice-bitten footgun — an empty ~/.board from `make token`).
      // runTokenCommand owns the rest of the parsing and opens the RIGHT db
      // itself (shared data dir, or the instance's temp db with --instance —
      // the sanctioned local-db exception to invariant 3, writes go through
      // the daemon).
      const [sub] = rest;
      if (sub !== "add" && sub !== "list" && sub !== "revoke") {
        console.error(TOKEN_USAGE);
        return 1;
      }
      return runTokenCommand({
        config: loadConfig(),
        argv: rest,
        io: consoleIo(),
      });
    }
    case "install": {
      // Validate before opening the db: usage-error paths must not create the
      // data dir (same footgun as `token`). runInstallCommand re-parses its
      // argv so tests can drive it standalone; the parse is cheap.
      if (typeof parseInstallArgs(rest) === "string") {
        console.error(INSTALL_USAGE);
        return 1;
      }
      // Same sanctioned local-db path as token: the human's tool.
      const config = loadConfig();
      const db = openDb(config.dataDir);
      try {
        return runInstallCommand({ db, argv: rest, io: consoleIo() });
      } finally {
        db.close();
      }
    }
    case "open":
      // The sanctioned local-db path (invariant 3's exception — writes go
      // through the daemon) moved into runOpenCommand: with --instance the
      // exchange token is minted on the INSTANCE's temp db while its daemon
      // serves the link (D20 wave 2).
      return runOpenCommand({
        config: loadConfig(),
        argv: rest,
        io: consoleIo(),
      });
    case "list":
    case "export":
    case "import":
    case "status": {
      // REST against the live daemon — deliberately no local db here: import
      // is a write and every write goes through the daemon API (invariant 3).
      return await (command === "status"
        ? runStatusCommand({
            config: loadConfig(),
            argv: rest,
            io: consoleIo(),
          })
        : runBoardsCommand(command, {
            config: loadConfig(),
            argv: rest,
            io: consoleIo(),
          }));
    }
    case "up":
    case "down":
    case "instances":
      // Session instances (D20): the spawn helper touches an instance's OWN
      // temp db (mint-before-spawn, exchange-token mint) — the sanctioned
      // local-db exception; the shared ~/.board is only read for the registry.
      return await runInstancesCommand(command, {
        config: loadConfig(),
        argv: rest,
        io: consoleIo(),
      });
    case "mcp":
      // Stdio MCP connector (wave 1): the agent-harness entry — opencode
      // spawns it so tools always list, and it resolves a real backend per
      // request (shared daemon when healthy, else the newest healthy session
      // instance). Reads env/registry, proxies HTTP; never writes (invariant
      // 3). Also runnable without bun: node cli/src/mcp-connector.ts.
      return await runMcpConnector();
    default:
      console.error(`board: unknown command "${command}"`);
      console.error(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
