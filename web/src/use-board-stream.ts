import { useEffect, useState } from "react";
import { type BoardWithVersions, getBoard, streamUrl } from "./api.ts";
import { BoardStream } from "./sse.ts";

// Live updates (SSE) for one board: any event for this board bumps the returned
// counter (the comment sidebar refetches on it); board lifecycle events also
// refresh the board meta through `onBoardMeta`. Reconnect is EventSource's.
//
// `onBoardMeta` is a dependency of the subscription, so pass a stable
// reference — a useState setter is one. A fresh closure per render would close
// and re-open the EventSource on every render.
export function useBoardStream(
  boardId: string,
  onBoardMeta: (board: BoardWithVersions) => void,
): number {
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const url = streamUrl();
    if (url === "") {
      return;
    }
    const stream = new BoardStream(url, (ev) => {
      if (ev.board_id !== boardId) {
        return;
      }
      setRefreshKey((key) => key + 1);
      if (ev.type.startsWith("board.")) {
        getBoard(boardId)
          .then((loaded) => {
            onBoardMeta(loaded);
          })
          .catch(() => {
            // a failed meta refresh just leaves the stale header
          });
      }
    });
    return () => {
      stream.close();
    };
  }, [boardId, onBoardMeta]);

  return refreshKey;
}
