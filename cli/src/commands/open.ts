import type { Config } from "../../../server/src/config.ts";
import { openDb } from "../../../server/src/db.ts";
import { createExchangeToken } from "../../../server/src/sessions.ts";
import { openTarget } from "../resolve.ts";
import { scan } from "./rest.ts";
import type { CommandIo } from "./token.ts";

export type OpenUrl = (url: string, io: CommandIo) => void;

const OPEN_USAGE = "usage: board open [board id] [--instance <id>]";

interface OpenCommandInput {
  config: Config;
  argv: string[];
  io: CommandIo;
  // Seam: tests inject a recorder; the default spawns xdg-open.
  openUrl?: OpenUrl;
}

// xdg-open can be absent (headless boxes) or fail (no default browser). The
// URL is printed either way, so a failed spawn only downgrades UX — never the
// exit status.
function spawnXdgOpen(url: string): boolean {
  try {
    const proc = Bun.spawnSync(["xdg-open", url], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

// The failure-downgrades-to-print opener, shared with `board up --open` (D20).
export function defaultOpener(url: string, io: CommandIo): void {
  if (!spawnXdgOpen(url)) {
    io.stderr("board: xdg-open failed; open the printed URL in a browser");
  }
}

// The base comes from resolution (the instance's url or the shared daemon's
// origin); the link shape is identical either way:
// http://127.0.0.1:<port>/?token=<ex>#/boards/<id>.
function boardOpenUrl(
  baseUrl: string,
  exchangeToken: string,
  boardId?: string,
): string {
  const base = `${baseUrl}/?token=${exchangeToken}`;
  return boardId === undefined ? base : `${base}#/boards/${boardId}`;
}

export function runOpenCommand({
  config,
  argv,
  io,
  openUrl = defaultOpener,
}: OpenCommandInput): number {
  const scanned = scan(argv, ["--instance"], []);
  if (typeof scanned === "string") {
    io.stderr(`board: ${scanned}`);
    io.stderr(OPEN_USAGE);
    return 1;
  }
  if (scanned.positional.length > 1) {
    io.stderr("board: open takes at most one board id");
    io.stderr(OPEN_USAGE);
    return 1;
  }
  const boardId = scanned.positional[0];
  const target = openTarget(config, scanned.values.get("instance"));
  if (typeof target === "string") {
    io.stderr(`board: ${target}`);
    io.stderr(OPEN_USAGE);
    return 1;
  }
  // The human's-tool local-db path (invariant 3's sanctioned exception —
  // writes go through the daemon — same as token): the exchange token is
  // minted directly on the target db — with --instance that is the instance's
  // temp db while its daemon serves the link. Opened only after
  // argv/resolution pass so usage errors never create the data dir (the
  // twice-bitten footgun).
  const db = openDb(target.dataDir);
  try {
    // docs/security.md: a one-time exchange token rides the URL; the SPA swaps
    // it for a localStorage session bearer via POST /api/session/exchange.
    const exchangeToken = createExchangeToken(db, boardId);
    const url = boardOpenUrl(target.baseUrl, exchangeToken, boardId);
    io.stdout(url);
    openUrl(url, io);
    return 0;
  } finally {
    db.close();
  }
}
