import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  Anchor,
  Comment,
  ImageAnchor,
  ImageOverlay,
  Version,
} from "../../../server/src/domain.ts";
import { errText } from "../../../server/src/err-text.ts";
import { highlightAnchor } from "../anchor.ts";
import {
  type BoardWithVersions,
  getBoard,
  getVersion,
  restoreBoard,
} from "../api.ts";
import { formatDate } from "../format.ts";
import { useAnchorAffordance } from "../use-anchor-affordance.ts";
import { useBoardDocument } from "../use-board-document.ts";
import { useBoardImages } from "../use-board-images.ts";
import { useBoardStream } from "../use-board-stream.ts";
import { CommentSidebar } from "./CommentSidebar.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { ImageOverlayLayer } from "./ImageOverlaySvg.tsx";

// The board page: header, version switcher + restore, the one container the
// published document is rendered into, and the surfaces that hang off it. It
// owns the page-level state — which version is viewed, the comments the
// sidebar streams up, the anchor staged for the composer — and delegates the
// mechanics: board-mount.ts (D18 html mounting), anchor.ts (anchor resolution,
// docs/anchors.md), CommentSidebar (all comment reading/writing, including the
// ImageOverlayEditor), and the use-board-*/use-anchor-affordance hooks (the
// effects over the mounted content DOM — call order there is mount-then-bind).
//
// The one non-obvious constraint: markdown content is injected as HTML because
// it was sanitized server-side at publish, and html boards are deliberately
// NOT sanitized (D18) — neither rule may be traded for the other here.
function boardBodyHtml(content: string): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  return doc.body.innerHTML;
}

export function BoardView({ id }: { id: string }) {
  const [data, setData] = useState<BoardWithVersions | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<Anchor | null>(null);
  // Restore-to-version (M7, plan.md "Web UI" → board view): two-click
  // arm/confirm (SessionsPanel's revoke is the house pattern) — restoring is
  // safe (append-only copy, history is kept) but surprising (the board jumps to
  // a new version), so the confirm copy says what happens. `restoreArmed` holds
  // the version n being confirmed.
  const [restoreArmed, setRestoreArmed] = useState<number | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // image annotation: the sidebar streams comments up; image-anchored threads
  // badge their board image and hover-preview the overlay on it, and the
  // lightbox (below) reviews any board image full size with its overlays
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeImage, setActiveImage] = useState<{
    anchor: ImageAnchor;
    overlay: ImageOverlay;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // synchronous half of the restore double-post guard (see restore below) —
  // state alone batches and lets a same-tick second click through
  const restoreBusyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setSelected(null);
    setVersion(null);
    setError(null);
    setRestoreArmed(null);
    setRestoreError(null);
    getBoard(id)
      .then((loaded) => {
        if (!alive) {
          return;
        }
        setData(loaded);
        setSelected(loaded.board.current_version);
      })
      .catch((err) => {
        if (alive) {
          setError(errText(err, "failed to load board"));
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (selected === null) {
      return;
    }
    let alive = true;
    getVersion(id, selected)
      .then((loaded) => {
        if (alive) {
          setVersion(loaded);
        }
      })
      .catch((err) => {
        if (alive) {
          setError(errText(err, "failed to load version"));
        }
      });
    return () => {
      alive = false;
    };
  }, [id, selected]);

  // Hook order is load-bearing: the document mounts first, then the hooks
  // that bind listeners to the mounted DOM (each hook's header says so).
  useBoardDocument(containerRef, version, data);
  const { imageTargets, lightbox, openLightbox, closeLightbox } =
    useBoardImages(containerRef, version, data);
  // setData is the stable reference the subscription needs (see the hook)
  const refreshKey = useBoardStream(id, setData);
  const affordance = useAnchorAffordance(containerRef, version, data);
  // narrowed once here: TypeScript drops the null-check on a property access
  // inside the button's own handlers
  const floating = affordance.current;

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (data === null) {
    return <div className="status">loading…</div>;
  }
  const board = data.board;
  // Affordance gate: viewing a PAST version of an OPEN board only. The
  // current version has nothing to restore (it IS current). Ended boards get
  // no affordance at all — the sidebar's ended treatment (hide write
  // affordances + a read-only notice) is the house pattern, the header badge
  // already says why, and the server 409s board_ended regardless
  // (boards.ts requireOpenBoard).
  const canRestore =
    board.status === "open" &&
    selected !== null &&
    selected !== board.current_version;
  const restore = async (): Promise<void> => {
    // Ref guard, not just the busy state: React state updates batch, so two
    // synchronous clicks share one closure whose restoreBusy is still false —
    // the ref makes no-double-post airtight; the disabled button is the
    // visible half of the same guard.
    if (selected === null || restoreBusyRef.current) {
      return;
    }
    restoreBusyRef.current = true;
    setRestoreBusy(true);
    try {
      // The route requires BOTH fields: the version being restored + the
      // current_version the client knows — a stale one 409s version_conflict
      // and the SSE meta refresh resyncs the header.
      const restored = await restoreBoard(id, selected, board.current_version);
      // Post-restore viewed-version choice: the 201 body IS the new current
      // version, so the view lands there immediately — deterministic, no SSE
      // race. The stream's board.restored event deliberately only refreshes
      // the meta (a REMOTE publish must not yank your viewed version), but
      // this jump is the user's own explicit action; staring at v2 while the
      // board sits at v3 would read as the restore doing nothing.
      setSelected(restored.n);
      setRestoreArmed(null);
      setRestoreError(null);
    } catch (err) {
      setRestoreError(errText(err, "restore failed"));
      // failure disarms back to the arm button — a stuck confirm over a
      // failed request invites blind re-clicks
      setRestoreArmed(null);
    } finally {
      restoreBusyRef.current = false;
      setRestoreBusy(false);
    }
  };
  // every image-anchored root comment's overlay for the lightboxed asset —
  // the review modal stacks them all (the board image shows one at a time on
  // hover; review shows the full picture)
  const lightboxOverlays =
    lightbox === null
      ? []
      : comments.flatMap((comment) =>
          comment.in_reply_to === null &&
          comment.anchor.type === "image" &&
          comment.anchor.asset_id === lightbox.assetId &&
          comment.anchor.overlay !== undefined
            ? [{ id: comment.id, overlay: comment.anchor.overlay }]
            : [],
        );
  return (
    <div className="board-view">
      <header className="board-header">
        <a className="back" href="#/">
          ← boards
        </a>
        <h1>{board.title}</h1>
        <div className="board-card-meta">
          <span className={`badge ${board.status}`}>{board.status}</span>
          <span>{board.created_by}</span>
          <span>{formatDate(board.created_at)}</span>
        </div>
      </header>
      <nav className="version-switcher">
        {data.versions.map((meta) => (
          <button
            key={meta.n}
            type="button"
            className={`pill${meta.n === selected ? " active" : ""}`}
            onClick={() => {
              setSelected(meta.n);
              // switching versions drops any armed confirm + stale error
              setRestoreArmed(null);
              setRestoreError(null);
            }}
          >
            {meta.label ?? `v${meta.n}`}
          </button>
        ))}
      </nav>
      {canRestore && (
        <div className="restore-bar">
          {restoreArmed === selected ? (
            <span className="confirm-inline">
              Restore v{selected}? Publishes this version as a new version —
              history is kept.
              <button
                type="button"
                className="pill"
                disabled={restoreBusy}
                onClick={() => {
                  void restore();
                }}
              >
                confirm restore
              </button>
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  setRestoreArmed(null);
                }}
              >
                keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setRestoreArmed(selected);
              }}
            >
              Restore this version
            </button>
          )}
        </div>
      )}
      {/* outside the bar: a 409 (e.g. the board was ended mid-flight)
            flips canRestore off — the error must survive the bar unmounting */}
      {restoreError !== null && <div className="error">{restoreError}</div>}
      <div className="board-layout">
        <div className="board-main">
          {version === null ? (
            <div className="status">loading version…</div>
          ) : (
            <div
              ref={containerRef}
              // the format class scopes snapshot-only styling (e.g. the static
              // markdown task-list glyphs) away from html boards, whose
              // checkboxes may be genuinely interactive (D18 scripts run)
              className={`board-content ${board.format}`}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: the sanctioned host-chrome display mode — markdown content is sanitized server-side at publish and script-free by construction (invariant 5, markdown through DOMPurify — docs/security.md "Content rules"); html boards mount through mountBoardDocument instead (D18)
              dangerouslySetInnerHTML={
                board.format === "html"
                  ? undefined
                  : { __html: boardBodyHtml(version.content) }
              }
            />
          )}
        </div>
        <CommentSidebar
          boardId={id}
          boardStatus={board.status}
          versionN={selected}
          refreshKey={refreshKey}
          pendingAnchor={pendingAnchor}
          onPendingAnchorConsumed={() => {
            setPendingAnchor(null);
          }}
          onHighlight={(anchor) => {
            highlightAnchor(anchor, containerRef.current);
          }}
          onSwitchVersion={(n) => {
            setSelected(n);
          }}
          onCommentsChange={setComments}
          onImageHover={(anchor) => {
            if (anchor === null || anchor.overlay === undefined) {
              setActiveImage(null);
              return;
            }
            setActiveImage({ anchor, overlay: anchor.overlay });
          }}
          onOpenImage={(assetId) => {
            // a thread thumbnail click opens the same lightbox as the board
            // image itself (the modal is the one review surface)
            openLightbox(assetId);
          }}
        />
      </div>
      {/* badges + hover overlays portal into each wrapped board image */}
      {Object.entries(imageTargets).map(([assetId, target]) => {
        const threads = comments.filter(
          (comment) =>
            comment.in_reply_to === null &&
            comment.anchor.type === "image" &&
            comment.anchor.asset_id === assetId,
        );
        const overlay =
          activeImage?.anchor.asset_id === assetId ? activeImage.overlay : null;
        return createPortal(
          <>
            {threads.length > 0 && (
              <span className="image-anchor-badge">{threads.length}</span>
            )}
            {overlay !== null && <ImageOverlayLayer overlay={overlay} />}
          </>,
          target,
        );
      })}
      {floating !== null && board.status === "open" && (
        <button
          type="button"
          className="floating-comment"
          style={{ top: `${floating.top}px`, left: `${floating.left}px` }}
          onMouseDown={(event) => {
            // keep the selection alive through the click — the default
            // collapse would race the handler and drop the affordance
            event.preventDefault();
          }}
          onMouseEnter={affordance.pin}
          onMouseLeave={affordance.unpin}
          onClick={() => {
            setPendingAnchor(floating.anchor);
            affordance.consume();
            window.getSelection()?.removeAllRanges();
          }}
        >
          {floating.label}
        </button>
      )}
      {/* the image lightbox (dogfooded ask [163]) reviews one asset full
          size with every image-anchored overlay for it stacked; annotate
          routes back through this component's pendingAnchor flow */}
      {lightbox !== null && (
        <ImageLightbox
          assetId={lightbox.assetId}
          overlays={lightboxOverlays}
          canAnnotate={board.status === "open"}
          onAnnotate={() => {
            // the floating "annotate image" button's exact flow: stage
            // the image anchor as a pending composer anchor and let
            // the sidebar own the editor — one editor implementation,
            // no fork (the composer holds the preview and its annotate
            // affordance)
            setPendingAnchor({
              type: "image",
              asset_id: lightbox.assetId,
            });
            closeLightbox();
            // the modal took the interaction: drop the hover/selection holds
            // so the next affordance is not suppressed by a stale pin
            affordance.release();
          }}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
}
