import { useEffect, useRef, useState } from "react";
import type {
  Anchor,
  BoardStatus,
  Comment,
  ImageAnchor,
} from "../../../server/src/domain.ts";
import { errText } from "../../../server/src/err-text.ts";
import { threadRootOf } from "../../../server/src/feedback.ts";
import { anchorDescriptor, BOARD_ANCHOR } from "../anchor.ts";
import {
  createComment,
  getComments,
  replyComment,
  resolveComment,
  uploadAsset,
} from "../api.ts";
import { formatDate } from "../format.ts";
import { ImageOverlayEditor } from "./ImageOverlayEditor.tsx";
import { ImageOverlayLayer } from "./ImageOverlaySvg.tsx";

interface ComposerState {
  anchor: Anchor;
  replyTo: Comment | null;
}

interface CommentSidebarProps {
  boardId: string;
  boardStatus: BoardStatus;
  versionN: number | null;
  refreshKey: number;
  pendingAnchor: Anchor | null;
  onPendingAnchorConsumed(): void;
  onHighlight(anchor: Anchor): void;
  onSwitchVersion(n: number): void;
  // image-anchored threads stream up so the board view can badge their
  // images and render hover overlays (the sidebar owns the comment fetch)
  onCommentsChange(comments: Comment[]): void;
  // hovering an image thread's chip previews its overlay on the board image
  onImageHover(anchor: ImageAnchor | null): void;
  // clicking a thread's thumbnail asks the board view for its image lightbox
  // (the modal lives there, above the board content)
  onOpenImage(assetId: string): void;
}

function authorLabel(author: string): string {
  return author === "human" ? "you" : author;
}

export function CommentSidebar(props: CommentSidebarProps) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  // the body lives in the textarea (uncontrolled) — read at submit/clear.
  // React's input→onChange mapping is feature-detected at module init and
  // cannot be synthesized under happy-dom, so a controlled body would make
  // the submit path untestable with plain dispatched events; bodyEmpty only
  // drives the disabled state and resets via onInput
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [bodyEmpty, setBodyEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hideResolved, setHideResolved] = useState(false);
  // image annotation state: an open overlay editor + the upload affordances
  const [editor, setEditor] = useState<{ assetId: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);

  const boardOpen = props.boardStatus === "open";

  const refresh = async (): Promise<void> => {
    try {
      const page = await getComments(props.boardId);
      setComments(page.comments);
      props.onCommentsChange(page.comments);
      setError(null);
    } catch (err) {
      setError(errText(err, "failed to load comments"));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: boardId/refreshKey are the intentional triggers; refresh is a render-scoped closure whose identity would refetch every render
  useEffect(() => {
    void refresh();
  }, [props.boardId, props.refreshKey]);

  // Anchors opened from the document (selection / section / row buttons)
  // biome-ignore lint/correctness/useExhaustiveDependencies: consume-once on pendingAnchor changes; the callback is a stable parent setter
  useEffect(() => {
    if (props.pendingAnchor !== null) {
      openComposer({ anchor: props.pendingAnchor, replyTo: null });
      props.onPendingAnchorConsumed();
    }
  }, [props.pendingAnchor]);

  // Every composer open/swap remounts the textarea (key = composerKey) — the
  // uncontrolled body starts empty, matching the old controlled setBody("").
  const [composerKey, setComposerKey] = useState(0);
  const openComposer = (state: ComposerState): void => {
    setComposer(state);
    setComposerKey((key) => key + 1);
    setBodyEmpty(true);
  };

  const clearBody = (): void => {
    if (bodyRef.current !== null) {
      bodyRef.current.value = "";
    }
    setBodyEmpty(true);
  };

  // the composer's image anchor when a root comment is being written —
  // extracted so the annotate button's closure keeps the narrowed type
  const pendingImage =
    composer !== null &&
    composer.replyTo === null &&
    composer.anchor.type === "image"
      ? composer.anchor
      : null;
  // the overlay IS the payload (dogfooded: forcing a body produced "." posts)
  // — a pending image anchor with at least one drawn item may post with an
  // empty body; everything else (replies included) still requires text
  const overlayReady =
    pendingImage !== null &&
    pendingImage.overlay !== undefined &&
    pendingImage.overlay.arrows.length + pendingImage.overlay.boxes.length > 0;

  const submit = async (): Promise<void> => {
    const text = (bodyRef.current?.value ?? "").trim();
    if (
      composer === null ||
      busy ||
      props.versionN === null ||
      (text.length === 0 && !overlayReady)
    ) {
      return;
    }
    setBusy(true);
    try {
      if (composer.replyTo === null) {
        await createComment(props.boardId, {
          anchor: composer.anchor,
          body: text,
          version_n: props.versionN,
        });
      } else {
        await replyComment(composer.replyTo.id, text);
      }
      setComposer(null);
      clearBody();
      await refresh();
    } catch (err) {
      setError(errText(err, "comment failed"));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (commentId: string): Promise<void> => {
    try {
      await resolveComment(commentId);
      await refresh();
    } catch (err) {
      setError(errText(err, "resolve failed"));
    }
  };

  // Human image ingest (docs/plan.md: drag/drop in the UI): upload the file,
  // then open the overlay editor on the stored asset. Errors surface in the
  // composer like every other failure (non-image, over-cap → server 4xx).
  const uploadAndEdit = (file: File): void => {
    if (!boardOpen || uploading) {
      return;
    }
    setUploading(true);
    uploadAsset(props.boardId, file)
      .then((asset) => {
        setError(null);
        setEditor({ assetId: asset.id });
      })
      .catch((err) => {
        setError(errText(err, "upload failed"));
      })
      .finally(() => {
        setUploading(false);
      });
  };

  const onDrop = (event: React.DragEvent): void => {
    setDropping(false);
    if (!boardOpen) {
      return;
    }
    const file = [...event.dataTransfer.files].find((candidate) =>
      candidate.type.startsWith("image/"),
    );
    if (file !== undefined) {
      // the composer is not a drop target for anything but images
      event.preventDefault();
      uploadAndEdit(file);
    }
  };

  const threads =
    comments === null
      ? []
      : comments
          .filter((comment) => comment.in_reply_to === null)
          .sort((a, b) => a.seq - b.seq);
  // resolved threads fold away on request (dogfooded ask); counts stay honest
  const visibleThreads = hideResolved
    ? threads.filter((thread) => thread.resolved_at === null)
    : threads;
  const anyResolved = threads.some((thread) => thread.resolved_at !== null);
  const unresolved = threads.filter(
    (thread) => thread.resolved_at === null,
  ).length;
  // Same cycle-safe walk as the server's feedback serializer — imported (it
  // is pure), so the web UI and the feedback markdown can never disagree
  // about which thread a reply belongs to
  const rootOf = (comment: Comment): Comment | null =>
    threadRootOf(comments ?? [], comment);
  const repliesOf = (root: Comment): Comment[] =>
    (comments ?? [])
      .filter(
        (comment) =>
          comment.in_reply_to !== null && rootOf(comment)?.id === root.id,
      )
      .sort((a, b) => a.seq - b.seq);

  return (
    <aside
      className={`comment-sidebar${dropping ? " drop-target" : ""}`}
      onDragOver={(event) => {
        // preventDefault is what licenses the drop in a browser
        if (
          boardOpen &&
          [...event.dataTransfer.items].some((item) => item.kind === "file")
        ) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => {
        setDropping(false);
      }}
      onDrop={onDrop}
    >
      <header className="sidebar-header">
        <span className="sidebar-title">Comments</span>
        <span className="sidebar-count">
          {unresolved} unresolved / {threads.length} threads
        </span>
        {boardOpen && (
          <button
            type="button"
            className="pill"
            onClick={() => {
              openComposer({ anchor: BOARD_ANCHOR, replyTo: null });
            }}
          >
            + board
          </button>
        )}
        {anyResolved && (
          <button
            type="button"
            className="pill"
            onClick={() => {
              setHideResolved((value) => !value);
            }}
          >
            {hideResolved ? "show resolved" : "hide resolved"}
          </button>
        )}
      </header>
      {error !== null && <div className="error">{error}</div>}
      {!boardOpen && (
        <div className="notice small">Board ended — read-only.</div>
      )}
      {comments === null ? (
        <div className="status small">loading…</div>
      ) : threads.length === 0 ? (
        <div className="empty small">
          No comments yet. Select text or hover a section to comment.
        </div>
      ) : visibleThreads.length === 0 ? (
        <div className="empty small">
          All resolved threads hidden — toggle "show resolved" to see them.
        </div>
      ) : (
        <div className="thread-list">
          {visibleThreads.map((thread) => (
            <ThreadView
              key={thread.id}
              root={thread}
              replies={repliesOf(thread)}
              boardOpen={boardOpen}
              versionN={props.versionN}
              onHighlight={props.onHighlight}
              onSwitchVersion={props.onSwitchVersion}
              onResolve={(commentId) => {
                void resolve(commentId);
              }}
              onReply={(comment) => {
                openComposer({ anchor: comment.anchor, replyTo: comment });
              }}
              onImageHover={props.onImageHover}
              onOpenImage={props.onOpenImage}
            />
          ))}
        </div>
      )}
      {composer !== null && boardOpen && (
        <div className="composer">
          {composer.replyTo === null ? (
            <div className="anchor-chip">
              on {anchorDescriptor(composer.anchor)}
            </div>
          ) : (
            <div className="anchor-chip">
              reply to {authorLabel(composer.replyTo.author)}
            </div>
          )}
          {composer.anchor.type === "text" && (
            <blockquote className="quote">
              “{composer.anchor.originalText}”
            </blockquote>
          )}
          {pendingImage !== null && (
            <>
              {/* visual confirmation the attachment is held (dogfooded:
                  "I thought I attached an image, but I don't see it?") */}
              <img
                className="comment-image-thumb"
                src={`/assets/${pendingImage.asset_id}`}
                alt=""
                draggable={false}
              />
              <button
                type="button"
                className="pill"
                onClick={() => {
                  setEditor({ assetId: pendingImage.asset_id });
                }}
              >
                annotate
              </button>
            </>
          )}
          <textarea
            key={composerKey}
            ref={bodyRef}
            rows={3}
            defaultValue=""
            placeholder={composer.replyTo === null ? "comment…" : "reply…"}
            onInput={(event) => {
              setBodyEmpty(
                (event.target as HTMLTextAreaElement).value.trim().length === 0,
              );
            }}
            onKeyDown={(event) => {
              // Enter submits, Shift+Enter inserts a newline (GitHub-style
              // convention); flipping to literal Shift+Enter-submits is one line
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-actions">
            <button
              type="button"
              disabled={busy || (bodyEmpty && !overlayReady)}
              onClick={() => {
                void submit();
              }}
            >
              {busy ? "sending…" : "Comment"}
            </button>
            {/* click-path twin of drag/drop: same upload + editor flow */}
            <label className={`pill attach-image${uploading ? " busy" : ""}`}>
              {uploading ? "uploading…" : "attach image"}
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // reset so picking the same file twice re-fires change
                  event.target.value = "";
                  if (file !== undefined) {
                    uploadAndEdit(file);
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setComposer(null);
              }}
            >
              cancel
            </button>
          </div>
        </div>
      )}
      {editor !== null && boardOpen && (
        <ImageOverlayEditor
          assetId={editor.assetId}
          onDone={(overlay) => {
            // replies inherit the parent's anchor — a finished overlay always
            // lands as a root comment, replacing any open composer
            openComposer({
              anchor: { type: "image", asset_id: editor.assetId, overlay },
              replyTo: null,
            });
            setEditor(null);
          }}
          onCancel={() => {
            setEditor(null);
          }}
        />
      )}
    </aside>
  );
}

interface ThreadViewProps {
  root: Comment;
  replies: Comment[];
  boardOpen: boolean;
  versionN: number | null;
  onHighlight(anchor: Anchor): void;
  onSwitchVersion(version: number): void;
  onResolve(commentId: string): void;
  onReply(comment: Comment): void;
  onImageHover(anchor: ImageAnchor | null): void;
  onOpenImage(assetId: string): void;
}

function ThreadView(props: ThreadViewProps) {
  const { root } = props;
  // captured so the hover closures keep the narrowed ImageAnchor type
  const imageAnchor = root.anchor.type === "image" ? root.anchor : null;
  return (
    <div className={`thread${root.resolved_at !== null ? " resolved" : ""}`}>
      {imageAnchor !== null && (
        // the thumbnail is the lightbox entry (dogfooded ask [163]: review +
        // annotate without hunting the hover affordance) and shows the
        // comment's own overlay scaled onto it — the shared renderer, no
        // fork. The chip button below keeps the hover-preview and the
        // click-to-highlight (a11y: pointer-only affordances stay on
        // interactive elements).
        <button
          type="button"
          className="comment-thumb"
          aria-label="open image"
          onClick={() => {
            props.onOpenImage(imageAnchor.asset_id);
          }}
        >
          <img
            className="comment-image-thumb"
            src={`/assets/${imageAnchor.asset_id}`}
            alt=""
            draggable={false}
          />
          {imageAnchor.overlay !== undefined && (
            <ImageOverlayLayer overlay={imageAnchor.overlay} />
          )}
        </button>
      )}
      <button
        type="button"
        className="anchor-chip clickable"
        onClick={() => {
          props.onHighlight(root.anchor);
        }}
        onMouseEnter={
          imageAnchor === null
            ? undefined
            : () => {
                props.onImageHover(imageAnchor);
              }
        }
        onMouseLeave={
          imageAnchor === null
            ? undefined
            : () => {
                props.onImageHover(null);
              }
        }
      >
        {anchorDescriptor(root.anchor)}
      </button>
      {/* an overlay-only annotation (empty body, item 1) shows the anchor
          affordance alone — no empty body block */}
      {root.body.trim().length > 0 && (
        <div className="thread-body">{root.body}</div>
      )}
      <div className="thread-meta">
        <span
          className={`author-badge${root.author === "human" ? " human" : ""}`}
        >
          {authorLabel(root.author)}
        </span>
        <span>{formatDate(root.created_at)}</span>
        {/* a thread pinned to another version gets an escape hatch back to
            the version it was written against (both formats re-anchor in the
            host DOM — by quote match for text anchors) */}
        {props.versionN !== null && root.version_n !== props.versionN && (
          <button
            type="button"
            className="linklike"
            onClick={() => {
              props.onSwitchVersion(root.version_n);
            }}
          >
            on v{root.version_n}
          </button>
        )}
        {root.resolved_at !== null ? (
          <span className="resolved-mark">
            ✓ resolved by {authorLabel(root.resolved_by ?? "")}
          </span>
        ) : (
          props.boardOpen && (
            <>
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  props.onResolve(root.id);
                }}
              >
                resolve
              </button>
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  props.onReply(root);
                }}
              >
                reply
              </button>
            </>
          )
        )}
      </div>
      {props.replies.map((reply) => (
        <div className="thread-reply" key={reply.id}>
          <span
            className={`author-badge${reply.author === "human" ? " human" : ""}`}
          >
            {authorLabel(reply.author)}
          </span>
          <span className="reply-body">{reply.body}</span>
          <span className="reply-date">{formatDate(reply.created_at)}</span>
        </div>
      ))}
    </div>
  );
}
