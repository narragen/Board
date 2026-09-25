import { useState } from "react";
import { errText } from "../../../server/src/err-text.ts";
import { listSessions, revokeSession } from "../api.ts";
import { formatDate } from "../format.ts";
import { useLoad } from "../use-load.ts";

export function SessionsPanel() {
  const {
    data: sessions,
    error,
    reload,
  } = useLoad(listSessions, "failed to load sessions");
  // Two-step revoke: the first click arms the confirm for exactly one row —
  // one click is too destructive for a credential.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The revoke's own failure slot, separate from the load's (BoardView's
  // restoreError does the same): a refetch clears a stale load error, and it
  // must not also erase the reason a revoke just failed.
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const revoke = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await revokeSession(id);
      setConfirming(null);
      setRevokeError(null);
      await reload();
    } catch (err) {
      setRevokeError(errText(err, "revoke failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="audit-panel" aria-label="Sessions">
      <header className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <span className="sidebar-count">
          {sessions === null ? "" : `${sessions.length} total`}
        </span>
      </header>
      {(error ?? revokeError) !== null && (
        <div className="error">{error ?? revokeError}</div>
      )}
      {sessions === null ? (
        <div className="status small">loading…</div>
      ) : sessions.length === 0 ? (
        <div className="empty small">No sessions.</div>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>session</th>
              <th>kind</th>
              <th>created</th>
              <th>last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td className="session-id">{session.id}</td>
                <td>
                  {/* The chip IS the leak-remediation signal: an unexchanged
                      exchange row means a one-time ?token= URL was minted but
                      never swapped — the credential is still out there, and
                      revoking it is exactly what the button is for
                      (routes/sessions.ts, docs/security.md "Audit view"). */}
                  {session.kind === "session" ? (
                    <span className="badge active">live</span>
                  ) : (
                    <span className="badge unexchanged">unexchanged</span>
                  )}
                </td>
                <td>{formatDate(session.created_at)}</td>
                <td>
                  {session.used_at === null ? "—" : formatDate(session.used_at)}
                </td>
                <td>
                  {confirming === session.id ? (
                    <span className="confirm-inline">
                      {/* Generic confirm for every row, deliberately: the SPA
                          holds only the bearer token, never its own session
                          row id (the server stores it hashed; the exchange
                          response is {token} alone), and guessing by
                          timestamps is not acceptable. A self-revocation
                          therefore lands in the existing 401 → gate flow
                          (api.ts onUnauthorized), which is the graceful
                          path the task allows for. */}
                      Revoke? Any browser using it is signed out.
                      <button
                        type="button"
                        className="pill"
                        disabled={busy}
                        onClick={() => {
                          void revoke(session.id);
                        }}
                      >
                        confirm revoke
                      </button>
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => {
                          setConfirming(null);
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
                        setConfirming(session.id);
                      }}
                    >
                      revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
