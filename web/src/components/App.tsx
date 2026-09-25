import { useEffect, useState } from "react";
import { errText } from "../../../server/src/err-text.ts";
import { completePasteExchange, exchange, onUnauthorized } from "../api.ts";
import { currentRoute, onRouteChange, type Route } from "../router.ts";
import {
  extractOneTimeToken,
  getSessionToken,
  setSessionToken,
} from "../token.ts";
import { AuditView } from "./AuditView.tsx";
import { BoardList } from "./BoardList.tsx";
import { BoardView } from "./BoardView.tsx";

type Phase = "booting" | "gate" | "ready";

// Single-flight boot: StrictMode double-invokes effects in dev and the
// exchange token is strictly one-time — the second call would burn it.
let bootPromise: Promise<boolean> | null = null;

function boot(): Promise<boolean> {
  if (bootPromise === null) {
    bootPromise = (async () => {
      const oneTime = extractOneTimeToken();
      if (oneTime !== null) {
        try {
          setSessionToken(await exchange(oneTime));
        } catch {
          return false;
        }
      }
      return getSessionToken() !== null;
    })();
  }
  return bootPromise;
}

export function App() {
  const [phase, setPhase] = useState<Phase>("booting");
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    let alive = true;
    void boot().then((ok) => {
      if (alive) {
        setPhase(ok ? "ready" : "gate");
      }
    });
    const offRoute = onRouteChange(() => {
      setRoute(currentRoute());
    });
    const offAuth = onUnauthorized(() => {
      if (alive) {
        setPhase("gate");
      }
    });
    return () => {
      alive = false;
      offRoute();
      offAuth();
    };
  }, []);

  if (phase === "booting") {
    return <div className="status">loading…</div>;
  }
  if (phase === "gate") {
    return <Gate onReady={() => setPhase("ready")} />;
  }
  return (
    <div className="container">
      {route.name === "board" && <BoardView id={route.id} />}
      {route.name === "audit" && <AuditView />}
      {route.name === "list" && <BoardList />}
    </div>
  );
}

export function Gate({ onReady }: { onReady: () => void }) {
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const token = paste.trim();
    if (token.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completePasteExchange(token);
      onReady();
    } catch (err) {
      setError(errText(err, "exchange failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <h1>board</h1>
      <p>
        Run <code>make open</code> in your terminal to open your board session.
      </p>
      <p className="gate-hint">
        Or paste a one-time token from <code>board open</code>:
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="password"
          value={paste}
          placeholder="one-time token"
          onChange={(event) => {
            setPaste(event.target.value);
          }}
        />
        <button type="submit" disabled={busy || paste.trim().length === 0}>
          {busy ? "opening…" : "open"}
        </button>
      </form>
      {error !== null && <div className="error">{error}</div>}
    </div>
  );
}
