import { listTokens } from "../api.ts";
import { formatDate } from "../format.ts";
import { useLoad } from "../use-load.ts";

// Read-only token inventory. No values column, ever: token values are
// SHA-256 hashed server-side and never returned (invariant 7,
// docs/security.md) — this table is the audit surface, not a keyring.
export function TokensPanel() {
  const { data: tokens, error } = useLoad(listTokens, "failed to load tokens");

  return (
    <section className="audit-panel" aria-label="Tokens">
      <header className="sidebar-header">
        <span className="sidebar-title">Tokens</span>
        <span className="sidebar-count">
          {tokens === null ? "" : `${tokens.length} total`}
        </span>
      </header>
      {error !== null && <div className="error">{error}</div>}
      {tokens === null ? (
        <div className="status small">loading…</div>
      ) : tokens.length === 0 ? (
        <div className="empty small">No tokens.</div>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>name</th>
              <th>created</th>
              <th>last seen</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr
                key={token.name}
                className={token.revoked_at !== null ? "revoked-row" : ""}
              >
                <td className="token-name">{token.name}</td>
                <td>{formatDate(token.created_at)}</td>
                <td>
                  {token.last_seen === null || token.last_seen === undefined
                    ? "—"
                    : formatDate(token.last_seen)}
                </td>
                <td>
                  {token.revoked_at !== null &&
                  token.revoked_at !== undefined ? (
                    <span className="badge revoked">revoked</span>
                  ) : (
                    <span className="badge active">active</span>
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
