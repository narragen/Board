// The bundle FORMAT: the schema version and the manifest shape that export
// writes and import reads. It holds no logic of either side — it exists so the
// two cannot drift apart on what a bundle is (docs/architecture.md "Bundle
// export/import").
import type { BoardFormat, BoardStatus } from "./domain.ts";

// The entry-path layout (`content/<n>.<md|html>`, `assets/<id>.<ext>`) is NOT
// shared code: bundle-export.ts builds those names and bundle-import.ts
// validates them against its own patterns. A validator that reused the writer's
// generator would agree with a bug in it.

// Bumped on any bundle-format change; import rejects everything else (422).
export const BUNDLE_SCHEMA_VERSION = 1;

export interface ManifestVersionEntry {
  n: number;
  file: string;
  label: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export interface ManifestAssetEntry {
  id: string;
  file: string;
  mime: string;
  size: number;
  source: string;
  created_by: string;
  created_at: string;
}

export interface Manifest {
  schema_version: number;
  source_board_id: string;
  exported_at: string;
  board: {
    title: string;
    format: BoardFormat;
    status: BoardStatus;
    tags: string[];
    created_by: string;
    created_at: string;
  };
  versions: ManifestVersionEntry[];
  comments: { count: number };
  assets: ManifestAssetEntry[];
}
