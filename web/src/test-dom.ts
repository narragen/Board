import { Window } from "happy-dom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// Minimal EventSource test double: BoardStream only needs addEventListener +
// close, and tests need to fire frames and inspect instances.
export class StubEventSource {
  static instances: StubEventSource[] = [];

  readonly url: string;
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, callback: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const callback of this.listeners.get(type) ?? []) {
      callback(event);
    }
  }

  close(): void {
    this.listeners.clear();
  }
}

// happy-dom globals for the web tests (no browser, no jsdom): install exactly
// what the app + react-dom/client touch, nothing more. JavaScript evaluation
// is enabled so the D18 host-render path (mountBoardDocument re-creating
// board scripts) behaves like a real browser in tests — but external script
// FETCHING is disabled: happy-dom would really try to load src scripts (and
// fail with ECONNREFUSED noise), firing its own error events that race the
// tests' deterministic load dispatches. Production browsers fetch normally.
//
// Components under test read input values from refs and rely only on
// SimpleEventPlugin events (click/mouse/key) — React's input→onChange
// mapping is feature-detected at react-dom module init in an environment
// test files cannot control (bun evaluates module bodies in unobservable
// order), so controlled inputs are never driven in tests.
export function installDom(): Window {
  const window = new Window({
    url: "http://127.0.0.1:5173/",
    settings: {
      enableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
    },
  });
  StubEventSource.instances = [];
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    DOMParser: window.DOMParser,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    // test double, not the real SSE client (see StubEventSource above)
    EventSource: StubEventSource as unknown as typeof EventSource,
  });
  return window;
}

// Audit-view poll tests need document.visibilityState to flip (the component
// polls only while the tab is visible). happy-dom exposes it as a getter on
// Document.prototype, so the seam redefines it on the document instance and
// fires visibilitychange — the same signal the component listens for.
export function setVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

// Shared component-test harness: render into a fresh document container and
// unmount everything on cleanup. Each test file calls this at its top level
// and wires its own `afterEach(cleanup)` — hook registration must stay
// file-local, so the harness only owns the roots and the render/unmount pair.
//
// `rerender` re-renders the most recent root with new props, which is the only
// way to stage a prop CHANGE (a different board id, a different version) —
// `render` opens a fresh root, which is a mount, not a change.
export function createComponentHarness(): {
  render: (element: ReactElement) => HTMLElement;
  rerender: (element: ReactElement) => void;
  cleanup: () => Promise<void>;
} {
  const roots: Root[] = [];
  const render = (element: ReactElement): HTMLElement => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(element);
    });
    return container;
  };
  const rerender = (element: ReactElement): void => {
    const root = roots.at(-1);
    if (root === undefined) {
      throw new Error("rerender before render");
    }
    act(() => {
      root.render(element);
    });
  };
  const cleanup = async (): Promise<void> => {
    for (const root of roots.splice(0)) {
      await act(async () => {
        root.unmount();
      });
    }
  };
  return { render, rerender, cleanup };
}
