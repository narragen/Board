import { type RefObject, useEffect } from "react";
import type { Version } from "../../server/src/domain.ts";
import type { BoardWithVersions } from "./api.ts";
import { mountBoardDocument } from "./board-mount.ts";
import { renderMermaidBlocks } from "./mermaid.ts";

// Gets the published document's diagrams rendered inside `containerRef`, and
// for html boards does the mounting too. The two formats take different paths
// (D18) and exactly one of the effects below applies to a given board.
//
// `version` + `data` are the mounted content's identity, not data this hook
// reads for its own sake: a new pair means the content DOM was replaced. Call
// this BEFORE the hooks that bind listeners to that DOM (useBoardImages,
// useAnchorAffordance) — effect order is mount-then-bind.
export function useBoardDocument(
  containerRef: RefObject<HTMLDivElement | null>,
  version: Version | null,
  data: BoardWithVersions | null,
): void {
  // Markdown boards: content is committed by React's render, so the blocks
  // are there as soon as this runs. The html case is chained onto the mount
  // below instead, because that content arrives asynchronously.
  useEffect(() => {
    const root = containerRef.current;
    if (
      version === null ||
      data === null ||
      root === null ||
      data.board.format === "html"
    ) {
      return;
    }
    let cancelled = false;
    void renderMermaidBlocks(root, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [containerRef, version, data]);

  // D18: html boards mount into the host DOM like markdown — the document is
  // parsed, head styles and body children are injected, and scripts are
  // re-created so they actually run (innerHTML would not execute them). The
  // mount is async: external scripts are awaited in document order so inline
  // code never races its dependencies; a version switch mid-mount aborts the
  // old sequence (its scripts are detached and never fire).
  useEffect(() => {
    const root = containerRef.current;
    if (
      version === null ||
      data === null ||
      root === null ||
      data.board.format !== "html"
    ) {
      return;
    }
    let cancelled = false;
    // Diagrams render only once the mount resolves (D26): the body children
    // land before the first await, but an agent script may also emit a block,
    // and chaining is the only ordering that holds in both cases.
    void mountBoardDocument(version.content, root).then(() => {
      if (cancelled) {
        return;
      }
      return renderMermaidBlocks(root, () => cancelled);
    });
    return () => {
      cancelled = true;
    };
  }, [containerRef, version, data]);
}
