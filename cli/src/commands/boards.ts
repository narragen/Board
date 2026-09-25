// list / export / import (M6, docs/plan.md "Operations"): REST commands
// against the live daemon — unlike token/open/install these never touch the
// local db, because every write (import) must flow through the daemon API
// (invariant 3) and reads want the same view agents see. Exception (D20 wave
// 2): export against a CLOSED instance zips from the on-disk bundle — the
// same sanctioned local-disk read down's keepsake path uses.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildBundle } from "../../../server/src/bundle-export.ts";
import type { Config } from "../../../server/src/config.ts";
import { openDb } from "../../../server/src/db.ts";
import { errText } from "../../../server/src/err-text.ts";
import {
  type ExportTarget,
  exportTarget,
  type RestTarget,
  restTarget,
  type Selection,
} from "../resolve.ts";
import { renderTable } from "../table.ts";
import { bearer, errorMessage, type FetchLike, parseArgs } from "./rest.ts";
import type { CommandIo } from "./token.ts";

export const BOARDS_USAGE =
  "usage: board list | board export <board_id> [file] | board import <file>";

interface BoardsCommandInput {
  config: Config;
  argv: string[];
  io: CommandIo;
  // Seam: tests inject a fake so nothing touches the network (open.ts's
  // openUrl pattern).
  fetchImpl?: FetchLike;
}

async function runListCommand(
  input: BoardsCommandInput,
  target: RestTarget,
): Promise<number> {
  const { io, fetchImpl } = input;
  const url = new URL("/api/boards", target.baseUrl);
  const res = await (fetchImpl ?? fetch)(url, {
    headers: bearer(target.token),
  });
  if (!res.ok) {
    io.stderr(`board: ${await errorMessage(res)}`);
    return 1;
  }
  interface ListRow {
    id: string;
    status: string;
    current_version: number;
    unresolved_comments: number;
    title: string;
  }
  const boards = (await res.json()) as ListRow[];
  if (boards.length === 0) {
    io.stdout("no boards yet; publish one with the board MCP tools");
    return 0;
  }
  for (const line of renderTable(
    ["ID", "STATUS", "VERSIONS", "UNRESOLVED", "TITLE"],
    boards.map((b) => [
      b.id,
      b.status,
      String(b.current_version),
      String(b.unresolved_comments),
      b.title,
    ]),
  )) {
    io.stdout(line);
  }
  return 0;
}

// Closed-instance export (D20 wave 2): the daemon is gone, so the bundle is
// zipped straight from the temp data dir's on-disk mirror. buildBundle is the
// export route's own pure function (and the primitive behind down's keepsake
// writer exportBoardsFromDisk); the zip lands in cwd like the REST path's
// default, NOT in the registry boards/ dir — that stays the keepsake writer's
// job. The db read on a dead daemon is safe (single dead writer; openDb's
// busy_timeout covers the WAL replay). [D20]
async function exportClosed(
  io: CommandIo,
  sel: Selection,
  boardId: string,
  file: string,
): Promise<number> {
  if (!existsSync(join(sel.entry.dataDir, "board.db"))) {
    io.stderr(
      `board: instance "${sel.entry.id}"'s temp data dir is gone (purged at teardown) — its boards were kept as zips in ${sel.paths.boards}`,
    );
    return 1;
  }
  const db = openDb(sel.entry.dataDir);
  let zip: Uint8Array;
  try {
    zip = buildBundle(db, sel.entry.dataDir, boardId);
  } catch (err) {
    io.stderr(
      `board: could not export "${boardId}" from instance "${sel.entry.id}" on disk (${errText(err)})`,
    );
    return 1;
  } finally {
    db.close();
  }
  try {
    await Bun.write(file, zip);
  } catch (err) {
    io.stderr(`board: could not write ${file} (${errText(err)})`);
    return 1;
  }
  io.stdout(`wrote ${file} (${zip.byteLength} bytes)`);
  return 0;
}

async function runExportCommand(
  input: BoardsCommandInput,
  target: ExportTarget,
  boardId: string,
  file: string,
): Promise<number> {
  const { io, fetchImpl } = input;
  if (target.mode === "disk") {
    return exportClosed(io, target.selection, boardId, file);
  }
  const url = new URL(`/api/boards/${boardId}/export`, target.baseUrl);
  const res = await (fetchImpl ?? fetch)(url, {
    headers: bearer(target.token),
  });
  if (!res.ok) {
    io.stderr(`board: ${await errorMessage(res)}`);
    return 1;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  try {
    await Bun.write(file, bytes);
  } catch (err) {
    io.stderr(`board: could not write ${file} (${errText(err)})`);
    return 1;
  }
  io.stdout(`wrote ${file} (${bytes.byteLength} bytes)`);
  return 0;
}

// The import REQUEST — the raw zip bytes POSTed to /api/boards/import — is
// shared by `board import` and `up --resume` (M8.1a, D20 continuity): one
// POST per zip, byte-identical semantics. Import itself is unchanged (the M6
// quarantine re-runs server-side; boards always land under NEW ids —
// import's always-new-id rule). Throws with the daemon's error message on
// non-2xx so callers shape their own UX.
export async function importBundle(
  fetchImpl: FetchLike | undefined,
  target: RestTarget,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ id: string; title: string }> {
  const url = new URL("/api/boards/import", target.baseUrl);
  const res = await (fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { ...bearer(target.token), "content-type": "application/zip" },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return (await res.json()) as { id: string; title: string };
}

async function runImportCommand(
  input: BoardsCommandInput,
  target: RestTarget,
  file: string,
): Promise<number> {
  const { io, fetchImpl } = input;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  } catch (err) {
    io.stderr(`board: could not read ${file} (${errText(err)})`);
    return 1;
  }
  try {
    const board = await importBundle(fetchImpl, target, bytes);
    io.stdout(`imported "${board.title}" as board ${board.id}`);
    return 0;
  } catch (err) {
    io.stderr(`board: ${errText(err)}`);
    return 1;
  }
}

function argError(io: CommandIo, message: string): number {
  io.stderr(`board: ${message}`);
  io.stderr(BOARDS_USAGE);
  return 1;
}

export async function runBoardsCommand(
  command: string,
  input: BoardsCommandInput,
): Promise<number> {
  const parsed =
    command === "list"
      ? parseArgs(input.argv, 0)
      : command === "export"
        ? parseArgs(input.argv, 2)
        : command === "import"
          ? parseArgs(input.argv, 1)
          : null;
  if (parsed === null) {
    input.io.stderr(BOARDS_USAGE);
    return 1;
  }
  if (typeof parsed === "string") {
    return argError(input.io, parsed);
  }
  // Instance-aware target (D20 wave 2): --instance/BOARD_INSTANCE swap the
  // daemon origin, credential, and (for export's disk path) the board source;
  // no selection = the shared daemon, byte-for-byte as before.
  if (command === "export") {
    const boardId = parsed.positional[0];
    if (boardId === undefined || boardId.length === 0) {
      input.io.stderr("board: export needs a board id");
      input.io.stderr(BOARDS_USAGE);
      return 1;
    }
    const target = exportTarget(input.config, parsed);
    if (typeof target === "string") {
      return argError(input.io, target);
    }
    // default: <board_id>.zip in the current directory
    return runExportCommand(
      input,
      target,
      boardId,
      parsed.positional[1] ?? `${boardId}.zip`,
    );
  }
  const target = restTarget(input.config, parsed);
  if (typeof target === "string") {
    return argError(input.io, target);
  }
  if (command === "list") {
    return runListCommand(input, target);
  }
  const file = parsed.positional[0];
  if (file === undefined || file.length === 0) {
    input.io.stderr("board: import needs a bundle file");
    input.io.stderr(BOARDS_USAGE);
    return 1;
  }
  return runImportCommand(input, target, file);
}
