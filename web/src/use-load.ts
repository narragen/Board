import { useCallback, useEffect, useRef, useState } from "react";
import { errText } from "../../server/src/err-text.ts";

// The one "load once on mount" shape for the read-only panels (BoardList,
// SessionsPanel, TokensPanel): fetch on mount, hand back `{data, error}`, and
// expose `reload` for the panels that mutate and refetch.
//
// It is shared because the unmount guard was not: three hand-rolled copies had
// three different guards — one correct, one absent (TokensPanel could setState
// after unmount), one carrying a deps-lint suppression for its render-scoped
// refresh closure.
//
// `fetcher` is a dependency of the mount load, so pass a stable reference (the
// module-level api.ts functions are) — an inline arrow would refetch on every
// render. `fallbackMessage` is what a human reads when the rejection is not an
// Error and so carries no message of its own.
export function useLoad<T>(
  fetcher: () => Promise<T>,
  fallbackMessage: string,
): {
  data: T | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each load carries the generation it started in and only the current
  // generation may write. A bare alive boolean covered the unmount but not the
  // supersede: the mount effect re-armed it, so a load the effect had already
  // torn down still passed the check and a slow first answer could overwrite a
  // fresh second one. (The unmount half has no observable symptom of its own —
  // React 19 makes that write a silent no-op — so the supersede is what
  // use-load.test.ts pins, and it is the same line either way.)
  const genRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const gen = genRef.current;
    try {
      const loaded = await fetcher();
      if (gen === genRef.current) {
        setData(loaded);
        setError(null);
      }
    } catch (err) {
      if (gen === genRef.current) {
        setError(errText(err, fallbackMessage));
      }
    }
  }, [fetcher, fallbackMessage]);

  useEffect(() => {
    void reload();
    return () => {
      // Teardown is exactly the moment whatever is in flight stops being
      // current — an unmount, or a new fetcher/message that has started its own
      // load. One bump covers both; nothing needs to re-arm on the way in,
      // because a load reads the generation when it starts, not at init.
      genRef.current += 1;
    };
  }, [reload]);

  return { data, error, reload };
}
