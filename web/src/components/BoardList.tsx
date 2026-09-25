import { listBoards } from "../api.ts";
import { formatDate } from "../format.ts";
import { useLoad } from "../use-load.ts";

export function BoardList() {
  const { data: boards, error } = useLoad(listBoards, "failed to load boards");

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (boards === null) {
    return <div className="status">loading…</div>;
  }
  if (boards.length === 0) {
    return (
      <div className="empty">
        No boards yet — agents create them via the API.
      </div>
    );
  }
  return (
    <div className="board-list-view">
      <header className="board-list-header">
        <h1>boards</h1>
        <a className="audit-link" href="#/audit">
          audit
        </a>
      </header>
      <div className="board-list">
        {boards.map((board) => (
          <a
            key={board.id}
            className={`board-card${board.status === "ended" ? " ended" : ""}`}
            href={`#/boards/${board.id}`}
          >
            <div className="board-card-title">{board.title}</div>
            <div className="board-card-meta">
              <span className={`badge ${board.status}`}>{board.status}</span>
              <span>v{board.current_version}</span>
              <span>{board.created_by}</span>
              <span>{formatDate(board.created_at)}</span>
              <span>{board.subscriber_count} subs</span>
              {board.unresolved_comments > 0 && (
                <span className="unresolved-count">
                  {board.unresolved_comments} unresolved
                </span>
              )}
            </div>
            {board.tags.length > 0 && (
              <div className="board-card-tags">
                {board.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
