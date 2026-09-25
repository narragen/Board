import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createComponentHarness, installDom } from "./test-dom.ts";
import { useLoad } from "./use-load.ts";

installDom();

const { render, rerender, cleanup } = createComponentHarness();
afterEach(cleanup);

// A fetch the test settles by hand. useLoad re-runs its mount load whenever the
// fetcher identity changes, so the returned `fetcher` is one stable closure —
// and holding the settle/fail handles is the only way to land a resolve on the
// far side of an unmount.
interface Deferred {
  fetcher: () => Promise<string>;
  settle: (value: string) => void;
  fail: (err: unknown) => void;
  calls: number;
}

function deferred(): Deferred {
  const d: Deferred = {
    calls: 0,
    settle: () => {},
    fail: () => {},
    // placeholder: the real fetcher closes over `d`, so it needs `d` to exist
    fetcher: () => Promise.resolve(""),
  };
  d.fetcher = () => {
    d.calls += 1;
    return new Promise<string>((resolve, reject) => {
      d.settle = resolve;
      d.fail = reject;
    });
  };
  return d;
}

// The smallest consumer of the hook: renders whichever of error/data it has,
// and a button for the reload path the mutating panels use.
function Probe({ fetcher }: { fetcher: () => Promise<string> }) {
  const { data, error, reload } = useLoad(fetcher, "failed to load probe");
  return createElement(
    "div",
    null,
    createElement("span", { className: "out" }, error ?? data ?? "loading…"),
    createElement(
      "button",
      {
        type: "button",
        className: "reload",
        onClick: () => {
          void reload();
        },
      },
      "reload",
    ),
  );
}

const out = (container: HTMLElement): string | undefined =>
  container.querySelector("span.out")?.textContent ?? undefined;

describe("useLoad", () => {
  test("the mount load lands in data", async () => {
    const d = deferred();
    const container = render(createElement(Probe, { fetcher: d.fetcher }));
    expect(out(container)).toBe("loading…");
    await act(async () => {
      d.settle("boards");
    });
    expect(d.calls).toBe(1);
    expect(out(container)).toBe("boards");
  });

  test("a rejected load lands in error", async () => {
    const d = deferred();
    const container = render(createElement(Probe, { fetcher: d.fetcher }));
    await act(async () => {
      d.fail(new Error("no daemon"));
    });
    expect(out(container)).toBe("no daemon");
  });

  test("a rejection that is not an Error reads as the fallback message", async () => {
    const d = deferred();
    const container = render(createElement(Probe, { fetcher: d.fetcher }));
    await act(async () => {
      d.fail({ status: 500 });
    });
    expect(out(container)).toBe("failed to load probe");
  });

  test("reload refetches and replaces the data", async () => {
    const d = deferred();
    const container = render(createElement(Probe, { fetcher: d.fetcher }));
    await act(async () => {
      d.settle("one board");
    });
    await act(async () => {
      (container.querySelector("button.reload") as HTMLElement).click();
    });
    expect(d.calls).toBe(2);
    await act(async () => {
      d.settle("two boards");
    });
    expect(out(container)).toBe("two boards");
  });

  test("a successful reload clears a previous error", async () => {
    const d = deferred();
    const container = render(createElement(Probe, { fetcher: d.fetcher }));
    await act(async () => {
      d.fail(new Error("no daemon"));
    });
    expect(out(container)).toBe("no daemon");
    await act(async () => {
      (container.querySelector("button.reload") as HTMLElement).click();
    });
    await act(async () => {
      d.settle("back up");
    });
    expect(out(container)).toBe("back up");
  });

  // The generation guard's visible half: a load the effect has already torn
  // down must not write, however late it answers. A bare alive boolean let this
  // through (it was re-armed by the re-run), so the stale value won.
  test("a superseded load never overwrites the current one", async () => {
    const first = deferred();
    const second = deferred();
    const container = render(createElement(Probe, { fetcher: first.fetcher }));
    await act(async () => {
      rerender(createElement(Probe, { fetcher: second.fetcher }));
    });
    await act(async () => {
      second.settle("current");
    });
    expect(out(container)).toBe("current");
    // the superseded load answers last — and loses
    await act(async () => {
      first.settle("stale");
    });
    expect(out(container)).toBe("current");
  });

  test("a superseded load's failure never lands either", async () => {
    const first = deferred();
    const second = deferred();
    const container = render(createElement(Probe, { fetcher: first.fetcher }));
    await act(async () => {
      rerender(createElement(Probe, { fetcher: second.fetcher }));
    });
    await act(async () => {
      second.settle("current");
    });
    await act(async () => {
      first.fail(new Error("stale failure"));
    });
    // an error slot is as damaging as a data slot: a dead load must not put a
    // message on a panel that loaded fine
    expect(out(container)).toBe("current");
  });

  // The unmount half of the same guard has no black-box signature under React
  // 19: a state update on an unmounted component is a silent no-op. So this
  // test pins what IS observable about a late settle — it neither throws nor
  // provokes a second fetch, and nothing renders back into the torn-down
  // container. The guard's line is asserted by the supersede tests above.
  test("a load that settles after unmount is inert", async () => {
    const d = deferred();
    const container = render(createElement(Probe, { fetcher: d.fetcher }));
    await cleanup();
    expect(container.textContent).toBe("");
    await act(async () => {
      d.settle("late");
    });
    expect(container.textContent).toBe("");
    expect(d.calls).toBe(1);
  });

  // The caller contract the three panels obey: the fetcher is the mount load's
  // dependency, so a NEW identity is a new load. An inline arrow would hand the
  // hook a fresh identity every render — a refetch loop.
  test("a new fetcher identity loads again", async () => {
    const first = deferred();
    const second = deferred();
    const container = render(createElement(Probe, { fetcher: first.fetcher }));
    await act(async () => {
      first.settle("one");
    });
    expect(out(container)).toBe("one");
    await act(async () => {
      rerender(createElement(Probe, { fetcher: second.fetcher }));
    });
    expect(second.calls).toBe(1);
    await act(async () => {
      second.settle("two");
    });
    expect(out(container)).toBe("two");
  });

  // StrictMode mounts, tears down and re-mounts the effect: the re-arm at the
  // top of the mount effect is what keeps the load from being dropped by its
  // own first cleanup.
  test("survives a StrictMode double mount", async () => {
    const d = deferred();
    const container = render(
      createElement(
        StrictMode,
        null,
        createElement(Probe, { fetcher: d.fetcher }),
      ),
    );
    await act(async () => {
      d.settle("boards");
    });
    expect(out(container)).toBe("boards");
  });
});
