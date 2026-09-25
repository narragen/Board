import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import {
  createComponentHarness,
  installDom,
  StubEventSource,
} from "../test-dom.ts";
import { clearSessionToken, setSessionToken } from "../token.ts";
import { BoardView } from "./BoardView.tsx";
import {
  createdComments,
  installApiMock,
  restoreAttempts,
  restoredBoards,
  restoreFailures,
  uploadedAssets,
  versionCalls,
} from "./test-api.ts";

installDom();
installApiMock();

// BoardView injects the stored (server-sanitized) document; mermaid renders
// client-side — both are mocked at the module boundary so no network or real
// mermaid runs here. (bun 1.4.2 mock() exposes no call log — hand-rolled spy.)
const mermaidRunCalls: Array<{ nodes: HTMLElement[] }> = [];
const mermaidInitializeCalls: number[] = [];
mock.module("mermaid", () => ({
  default: {
    initialize: () => {
      mermaidInitializeCalls.push(0);
    },
    run: (args: { nodes: HTMLElement[] }) => {
      mermaidRunCalls.push(args);
      return Promise.resolve();
    },
  },
}));

const { render, cleanup } = createComponentHarness();
afterEach(cleanup);

describe("BoardView", () => {
  test("injects the sanitized document and runs mermaid on its blocks", async () => {
    versionCalls.length = 0;
    const mermaidBefore = mermaidRunCalls.length;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    expect(versionCalls).toEqual([["b1", 2]]);
    const content = container.querySelector("div.board-content");
    expect(content).not.toBe(null);
    expect(content?.innerHTML).toContain("Plan");
    expect(mermaidRunCalls.length - mermaidBefore).toBe(1);
    const nodes = mermaidRunCalls.at(-1)?.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes?.[0].className).toContain("mermaid");
  });

  test("version switcher fetches the selected version", async () => {
    versionCalls.length = 0;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    expect(versionCalls).toEqual([["b1", 2]]);
    const pills =
      container
        .querySelector("nav.version-switcher")
        ?.querySelectorAll("button.pill") ?? [];
    expect(pills).toHaveLength(2);
    expect(pills[1].textContent).toContain("after review");
    await act(async () => {
      (pills[0] as HTMLElement).click();
    });
    expect(versionCalls).toEqual([
      ["b1", 2],
      ["b1", 1],
    ]);
  });

  test("html board renders into .board-content — no iframe anywhere (D18)", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    expect(container.querySelector("iframe")).toBe(null);
    const content = container.querySelector("div.board-content");
    expect(content).not.toBe(null);
    // body children mounted, opt-in data-ba sections intact
    const section = content?.querySelector('[data-ba="s-header"]');
    expect(section?.getAttribute("data-ba-label")).toBe("Header");
    expect(section?.textContent).toBe("Dashboard v2");
    // head styles land in the container (board templates keep CSS in <head>)
    expect(content?.querySelector("style")?.textContent).toContain(
      ".dash-note",
    );
    // scripts re-created in document order — the external one is created and
    // awaited BEFORE the inline runs (dogfooded: "Chart is not defined"). In
    // tests script fetching is disabled, so the load event is dispatched by
    // hand to advance the sequence.
    let scripts = [...(content?.querySelectorAll("script") ?? [])];
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("src")).toBe("/libs/chart-4.4.9.umd.min.js");
    await act(async () => {
      scripts[0].dispatchEvent(new Event("load"));
    });
    scripts = [...(content?.querySelectorAll("script") ?? [])];
    expect(scripts).toHaveLength(2);
    expect(scripts[1].getAttribute("src")).toBe(null);
    expect(scripts[1].text).toContain("__dashMounted");
  });

  // D26: mermaid used to be skipped entirely for html boards, so a diagram on
  // one rendered as raw source. The ordering is the whole fix — rendering is
  // chained onto mountBoardDocument, because an effect running alongside the
  // mount finds zero nodes and silently draws nothing.
  test("html board renders mermaid, and only after the mount resolves", async () => {
    const before = mermaidRunCalls.length;
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    const content = container.querySelector("div.board-content");
    // the external script is still pending, so the mount has not resolved
    expect(mermaidRunCalls.length - before).toBe(0);
    const pending = [...(content?.querySelectorAll("script") ?? [])];
    await act(async () => {
      pending[0].dispatchEvent(new Event("load"));
    });
    expect(mermaidRunCalls.length - before).toBe(1);
    const nodes = mermaidRunCalls.at(-1)?.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes?.[0].className).toContain("mermaid");
    // the publish-injected anchor id survives rendering, so the diagram stays
    // commentable
    expect(nodes?.[0].getAttribute("data-ba")).toBe("b-diagram");
  });

  test("html board inline scripts actually run in the host DOM (D18)", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    const src = container.querySelector(
      "div.board-content script[src]",
    ) as HTMLScriptElement;
    await act(async () => {
      src.dispatchEvent(new Event("load"));
    });
    expect(
      (window as unknown as { __dashMounted?: boolean }).__dashMounted,
    ).toBe(true);
  });

  test("markdown boards render no iframe", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    expect(container.querySelector("iframe")).toBe(null);
    expect(container.querySelector("div.board-content")).not.toBe(null);
  });

  test("board content carries the board format class", async () => {
    // snapshot-only styling (static markdown task-list glyphs) must never
    // reach html boards, whose checkboxes may be interactive (D18)
    const md = render(<BoardView id="b1" />);
    await act(async () => {});
    expect(
      md.querySelector("div.board-content")?.classList.contains("markdown"),
    ).toBe(true);
    const html = render(<BoardView id="b-html" />);
    await act(async () => {});
    expect(
      html.querySelector("div.board-content")?.classList.contains("html"),
    ).toBe(true);
  });

  test("switching versions remounts the html document in place", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    expect(container.querySelector("div.board-content")?.textContent).toContain(
      "Dashboard v2",
    );
    const pill = container.querySelector(
      "nav.version-switcher button.pill",
    ) as HTMLElement;
    await act(async () => {
      pill.click();
    });
    expect(container.querySelector("div.board-content")?.textContent).toContain(
      "Dashboard v1",
    );
    expect(
      container.querySelectorAll("div.board-content section"),
    ).toHaveLength(1);
  });

  test("highlighting an html-board anchor outlines the section in the host DOM", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    const chip = container.querySelector(
      "button.anchor-chip.clickable",
    ) as HTMLElement;
    await act(async () => {
      chip.click();
    });
    expect(
      container
        .querySelector('[data-ba="s-header"]')
        ?.classList.contains("anchor-target"),
    ).toBe(true);
  });

  test("hover affordance works on html boards (the host DOM is the board)", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    const section = container.querySelector(
      '[data-ba="s-header"]',
    ) as HTMLElement;
    await act(async () => {
      section.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      );
    });
    const button = container.querySelector("button.floating-comment");
    expect(button?.textContent).toBe("Comment on section");
    await act(async () => {
      (button as HTMLElement).click();
    });
    expect(container.querySelector("div.composer")).not.toBe(null);
    expect(container.innerHTML).toContain("on section s-header");
  });

  test("selection affordance survives the pointer crossing sections and opens the composer", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const content = container.querySelector("div.board-content");
    expect(content).not.toBe(null);
    const para = content?.querySelector('[data-ba="b2"]');
    const text = para?.firstChild;
    if (text === undefined || text === null) {
      throw new Error("fixture missing text node");
    }
    // the flow under test is events → affordance state, not happy-dom's
    // Selection internals — stub getSelection (a real selection left on the
    // shared document poisons later React event tests)
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    const realGetSelection = window.getSelection.bind(window);
    window.getSelection = () =>
      ({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => range,
        removeAllRanges: () => {},
      }) as unknown as Selection;
    try {
      await act(async () => {
        document.dispatchEvent(new Event("mouseup"));
      });
      let button = container.querySelector("button.floating-comment");
      expect(button?.textContent).toBe("Comment on selection");
      // crossing another section toward the button must NOT swap the
      // affordance out mid-flight (the reported "clicking does nothing" bug)
      await act(async () => {
        const section = content?.querySelector('[data-ba="b1"]') as
          | HTMLElement
          | undefined;
        section?.dispatchEvent(
          new window.MouseEvent("mouseover", { bubbles: true }),
        );
      });
      button = container.querySelector("button.floating-comment");
      expect(button?.textContent).toBe("Comment on selection");
      // clicking it opens the composer with the quoted text anchor
      await act(async () => {
        (button as HTMLElement).click();
      });
      expect(container.querySelector("div.composer")).not.toBe(null);
      expect(container.innerHTML).toContain("on text b2:");
      expect(container.innerHTML).toContain("“beta”");
    } finally {
      window.getSelection = realGetSelection;
    }
  });

  test("collapsing the selection dismisses the selection affordance", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const content = container.querySelector("div.board-content");
    const para = content?.querySelector('[data-ba="b2"]');
    const text = para?.firstChild;
    if (text === undefined || text === null) {
      throw new Error("fixture missing text node");
    }
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    const realGetSelection = window.getSelection.bind(window);
    let collapsed = false;
    window.getSelection = () =>
      ({
        get isCollapsed() {
          return collapsed;
        },
        rangeCount: collapsed ? 0 : 1,
        getRangeAt: () => range,
        removeAllRanges: () => {},
      }) as unknown as Selection;
    try {
      await act(async () => {
        document.dispatchEvent(new Event("mouseup"));
      });
      expect(container.querySelector("button.floating-comment")).not.toBe(null);
      collapsed = true;
      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
      });
      expect(container.querySelector("button.floating-comment")).toBe(null);
    } finally {
      window.getSelection = realGetSelection;
    }
  });

  test("hover affordance pins on the floating button and opens the composer", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const content = container.querySelector("div.board-content");
    expect(content).not.toBe(null);
    const heading = content?.querySelector('[data-ba="b1"]') as HTMLElement;
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      );
    });
    let button = container.querySelector("button.floating-comment");
    expect(button?.textContent).toBe("Comment on section");
    // leaving the section TOWARD the button must keep it alive — React
    // synthesizes the button's mouseenter from this very event (the pin)
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: button ?? undefined,
        }),
      );
    });
    expect(container.querySelector("button.floating-comment")).not.toBe(null);
    // leaving the BUTTON (to nowhere) unpins and clears the affordance
    await act(async () => {
      (button as HTMLElement).dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: null,
        }),
      );
    });
    expect(container.querySelector("button.floating-comment")).toBe(null);
    // re-hover; leaving the section to nowhere (never pinned) clears too
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      );
    });
    expect(container.querySelector("button.floating-comment")).not.toBe(null);
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: null,
        }),
      );
    });
    expect(container.querySelector("button.floating-comment")).toBe(null);
    // hover once more and click — the composer opens with a section anchor
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      );
    });
    button = container.querySelector("button.floating-comment");
    await act(async () => {
      (button as HTMLElement).click();
    });
    expect(container.querySelector("div.composer")).not.toBe(null);
    expect(container.innerHTML).toContain("on section b1");
  });
});

describe("BoardView image annotation", () => {
  test("hovering a board image offers annotate; clicking opens an image-anchor composer", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    expect(img).not.toBe(null);
    await act(async () => {
      img.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    });
    const button = container.querySelector("button.floating-comment");
    expect(button?.textContent).toBe("annotate image");
    await act(async () => {
      (button as HTMLElement).click();
    });
    expect(container.querySelector("div.composer")).not.toBe(null);
    expect(container.innerHTML).toContain("on image assetImg01");
    // the composer offers the editor on the already-published asset
    expect(container.innerHTML).toContain("annotate");
  });

  test("image-anchored threads badge their image and hover-preview the overlay as svg", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    // badge on the wrapped image (one unresolved image thread)
    expect(container.querySelector(".image-anchor-badge")?.textContent).toBe(
      "1",
    );
    // hovering the thread's chip mounts the overlay layer on the image
    const chip = [...container.querySelectorAll("button.anchor-chip")].find(
      (button) => button.textContent === "image assetImg01",
    ) as HTMLElement;
    await act(async () => {
      chip.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    });
    const layer = container.querySelector(
      ".image-overlay-layer",
    ) as HTMLElement;
    expect(layer).not.toBe(null);
    // measure with a known image box → the svg renders in scaled pixel space
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 400 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const svg = container.querySelector("svg.image-overlay-svg");
    expect(svg?.getAttribute("width")).toBe("800");
    expect(svg?.getAttribute("height")).toBe("400");
    const line = svg?.querySelector("line");
    // arrow (0.25, 0.5) → (0.75, 0.5) scaled to the 800×400 box
    expect(line?.getAttribute("x1")).toBe("200");
    expect(line?.getAttribute("y1")).toBe("200");
    expect(line?.getAttribute("x2")).toBe("600");
    expect(line?.getAttribute("y2")).toBe("200");
    const text = svg?.querySelector("text");
    expect(text?.getAttribute("x")).toBe("400");
    expect(text?.getAttribute("y")).toBe("40");
    expect(text?.textContent).toBe("watch this");
    // leaving the chip unmounts the overlay ON THE BOARD IMAGE (the
    // thumbnail's own scaled overlay from the thread is independent of chip
    // hover and stays)
    await act(async () => {
      chip.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: null,
        }),
      );
    });
    expect(
      container.querySelector(".image-anchor-wrap .image-overlay-layer"),
    ).toBe(null);
    expect(
      container.querySelector(".comment-thumb .image-overlay-layer"),
    ).not.toBe(null);
  });

  test("an image thread chip click highlights the board image (anchor-target parity)", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const chip = [...container.querySelectorAll("button.anchor-chip")].find(
      (button) => button.textContent === "image assetImg01",
    ) as HTMLElement;
    await act(async () => {
      chip.click();
    });
    const img = container.querySelector(".image-anchor-wrap img");
    expect(img?.classList.contains("anchor-target")).toBe(true);
  });

  test("clicking a board image opens the lightbox with the asset's overlays", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    await act(async () => {
      img.click();
    });
    const backdrop = container.querySelector(".lightbox-backdrop");
    expect(backdrop).not.toBe(null);
    const stage = container.querySelector(".lightbox-stage") as HTMLElement;
    const lightImg = stage.querySelector("img") as HTMLImageElement;
    expect(lightImg.getAttribute("src")).toBe("/assets/assetImg01");
    // every image-anchored thread's overlay for this asset renders in the
    // modal — measured against the stage box, the shared renderer
    const layer = stage.querySelector(".image-overlay-layer") as HTMLElement;
    expect(layer).not.toBe(null);
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 400 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const svg = stage.querySelector("svg.image-overlay-svg");
    expect(svg?.getAttribute("width")).toBe("800");
    expect(svg?.getAttribute("height")).toBe("400");
    // arrow (0.25, 0.5) → (0.75, 0.5) scaled to the 800×400 box
    const line = svg?.querySelector("line");
    expect(line?.getAttribute("x2")).toBe("600");
    const text = svg?.querySelector("text");
    expect(text?.textContent).toBe("watch this");
    expect(stage.querySelectorAll(".image-overlay-layer")).toHaveLength(1);
  });

  test("lightbox annotate routes through the existing composer → editor flow", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    await act(async () => {
      img.click();
    });
    const annotate = [
      ...container.querySelectorAll(".lightbox-toolbar button"),
    ].find((button) => button.textContent === "annotate") as HTMLElement;
    await act(async () => {
      annotate.click();
    });
    // the modal closed; the composer holds the image anchor — the floating
    // "annotate image" button's exact flow (pendingAnchor → composer)
    expect(container.querySelector(".lightbox-backdrop")).toBe(null);
    expect(container.innerHTML).toContain("on image assetImg01");
    // and the composer's annotate affordance mounts the existing editor
    const composerAnnotate = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "annotate",
    ) as HTMLElement;
    await act(async () => {
      composerAnnotate.click();
    });
    expect(container.querySelector(".overlay-editor")).not.toBe(null);
    expect(
      container.querySelector(".overlay-editor-stage img")?.getAttribute("src"),
    ).toBe("/assets/assetImg01");
  });

  test("lightbox → annotate → editor captures drawn items in the posted anchor (regression)", async () => {
    // owner report: a second annotation entered from the lightbox arrived
    // with overlay {arrows:[], boxes:[]}. Drives the FULL path — lightbox
    // annotate button → pendingAnchor → composer → editor → one arrow +
    // one textbox → done → post with an EMPTY body (the overlay is the
    // payload) — and asserts both items survive into the posted anchor.
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    // 1. enter from the LIGHTBOX: click the board image → review modal
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    await act(async () => {
      img.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).not.toBe(null);
    // 2. the lightbox annotate button stages the pending image anchor
    const annotate = [
      ...container.querySelectorAll(".lightbox-toolbar button"),
    ].find((button) => button.textContent === "annotate") as HTMLElement;
    await act(async () => {
      annotate.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).toBe(null);
    expect(container.innerHTML).toContain("on image assetImg01");
    // 3. the composer's annotate affordance opens the shared editor
    const composerAnnotate = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "annotate",
    ) as HTMLElement;
    await act(async () => {
      composerAnnotate.click();
    });
    const editor = container.querySelector(".overlay-editor");
    expect(editor).not.toBe(null);
    // 4. draw one arrow (press-drag-release) in the editor's canvas
    const stage = container.querySelector(
      ".overlay-editor-stage",
    ) as HTMLElement;
    stage.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 800, height: 400 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const canvas = container.querySelector(
      ".overlay-editor-canvas",
    ) as HTMLElement;
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mousedown", {
          bubbles: true,
          clientX: 210,
          clientY: 220,
        }),
      );
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: 610,
          clientY: 220,
        }),
      );
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mouseup", {
          bubbles: true,
          clientX: 610,
          clientY: 220,
        }),
      );
    });
    // 5. draw one textbox: place a label and commit its text with Enter
    const textPill = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "text",
    ) as HTMLElement;
    await act(async () => {
      textPill.click();
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
          clientX: 410,
          clientY: 60,
        }),
      );
    });
    const input = container.querySelector(
      ".overlay-editor-input",
    ) as HTMLInputElement;
    expect(input).not.toBe(null);
    input.value = "hold this";
    await act(async () => {
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    // 6. Done — the editor hands its overlay to the composer's anchor
    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "done",
    ) as HTMLElement;
    await act(async () => {
      done.click();
    });
    expect(container.querySelector(".overlay-editor")).toBe(null);
    // 7. post with an EMPTY body via Enter — the composer must submit
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    const textarea = container.querySelector("textarea") as HTMLElement;
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
    });
    await act(async () => {});
    // the posted anchor carries BOTH drawn items — no state reset, no
    // overlay dropped between the editor's Done and the POST body
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0].input.body).toBe("");
    expect(createdComments[0].input.anchor).toEqual({
      type: "image",
      asset_id: "assetImg01",
      overlay: {
        arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
        boxes: [{ x: 0.5, y: 0.1, text: "hold this" }],
      },
    });
  });

  test("Escape and a backdrop click close the lightbox; a click on the image box does not", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    const open = async (): Promise<void> => {
      await act(async () => {
        img.click();
      });
    };
    await open();
    expect(container.querySelector(".lightbox-backdrop")).not.toBe(null);
    await act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(container.querySelector(".lightbox-backdrop")).toBe(null);
    await open();
    const backdrop = container.querySelector(
      ".lightbox-backdrop",
    ) as HTMLElement;
    await act(async () => {
      backdrop.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).toBe(null);
    await open();
    // a click inside the image box is not a backdrop click (event.target vs
    // currentTarget) — reviewing stays put
    const stage = container.querySelector(".lightbox-stage") as HTMLElement;
    await act(async () => {
      stage.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).not.toBe(null);
  });

  test("clicking a thread thumbnail opens the lightbox for that asset", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const thumb = container.querySelector(
      "button.comment-thumb",
    ) as HTMLElement;
    expect(thumb).not.toBe(null);
    await act(async () => {
      thumb.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).not.toBe(null);
    const lightImg = container.querySelector(
      ".lightbox-stage img",
    ) as HTMLImageElement;
    expect(lightImg.getAttribute("src")).toBe("/assets/assetImg01");
  });
});

describe("BoardView restore-to-version", () => {
  // click the n-th version pill (0-based) — the switcher's only interactive
  // children are the pills
  const pill = (container: HTMLElement, n: number): HTMLElement => {
    const el = container.querySelectorAll("nav.version-switcher button.pill")[
      n
    ];
    if (!(el instanceof HTMLElement)) {
      throw new Error("pill missing");
    }
    return el;
  };
  const barButton = (
    container: HTMLElement,
    label: string,
  ): HTMLElement | null =>
    ([...container.querySelectorAll(".restore-bar button")].find(
      (button) => button.textContent === label,
    ) as HTMLElement | undefined) ?? null;

  test("a past version of an open board offers restore; the current version does not", async () => {
    restoredBoards.length = 0;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    // landed on current (v2) — nothing to restore
    expect(container.querySelector(".restore-bar")).toBe(null);
    await act(async () => {
      pill(container, 0).click();
    });
    // viewing v1 of a board at v2 — the affordance is up
    expect(container.querySelector(".restore-bar")?.textContent).toContain(
      "Restore this version",
    );
  });

  test("ended boards offer no restore affordance (the sidebar's read-only treatment)", async () => {
    restoredBoards.length = 0;
    const container = render(<BoardView id="b-ended" />);
    await act(async () => {});
    await act(async () => {
      pill(container, 0).click();
    });
    expect(container.querySelector(".restore-bar")).toBe(null);
  });

  test("arm shows the what-happens copy; confirm posts from_n + expected_version and lands on the new current version", async () => {
    restoredBoards.length = 0;
    restoreFailures.error = null;
    versionCalls.length = 0;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    await act(async () => {
      pill(container, 0).click();
    });
    await act(async () => {
      (barButton(container, "Restore this version") as HTMLElement).click();
    });
    // the confirm copy says what happens (safe-but-surprising: append-only)
    expect(container.querySelector(".confirm-inline")?.textContent).toContain(
      "Publishes this version as a new version — history is kept",
    );
    await act(async () => {
      (barButton(container, "confirm restore") as HTMLElement).click();
    });
    // body mirrors routes/boards.ts exactly: from_n + expected_version
    expect(restoredBoards).toEqual([
      { boardId: "b1", fromN: 1, expectedVersion: 2 },
    ]);
    // the 201 body is the new current version — the view lands there
    expect(versionCalls.at(-1)).toEqual(["b1", 3]);
    expect(container.querySelector(".confirm-inline")).toBe(null);
  });

  test("cancel disarms without posting", async () => {
    restoredBoards.length = 0;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    await act(async () => {
      pill(container, 0).click();
    });
    await act(async () => {
      (barButton(container, "Restore this version") as HTMLElement).click();
    });
    await act(async () => {
      (barButton(container, "keep") as HTMLElement).click();
    });
    expect(restoredBoards).toEqual([]);
    expect(container.querySelector(".confirm-inline")).toBe(null);
    // still viewing the past version — the arm affordance is back
    expect(container.querySelector(".restore-bar")?.textContent).toContain(
      "Restore this version",
    );
  });

  test("success: the SSE board.restored event refreshes meta and the new pill is active", async () => {
    restoredBoards.length = 0;
    restoreFailures.error = null;
    setSessionToken("sess-ok");
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    await act(async () => {
      pill(container, 0).click();
    });
    await act(async () => {
      (barButton(container, "Restore this version") as HTMLElement).click();
    });
    await act(async () => {
      (barButton(container, "confirm restore") as HTMLElement).click();
    });
    // the stream delivers board.restored (store.ts restoreVersion's event) —
    // the meta refetch sees the new current version and its pill
    const source = StubEventSource.instances.at(-1);
    await act(async () => {
      source?.emit("board", {
        data: JSON.stringify({
          seq: 30,
          ts: "2026-09-15T19:30:00.000Z",
          actor: "human",
          type: "board.restored",
          board_id: "b1",
          payload: { from: 1, to: 3 },
        }),
      });
    });
    await act(async () => {});
    const pills = [
      ...container.querySelectorAll("nav.version-switcher button.pill"),
    ];
    expect(pills).toHaveLength(3);
    expect(pills[2].textContent).toContain("restore of v1");
    expect(pills[2].classList.contains("active")).toBe(true);
    clearSessionToken();
  });

  test("409 surfaces the error, disarms, and a retry posts fresh (no double-post)", async () => {
    restoredBoards.length = 0;
    restoreAttempts.length = 0;
    restoreFailures.error = new Error(
      'version conflict on board "b1": expected 2, current 3',
    );
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    await act(async () => {
      pill(container, 0).click();
    });
    await act(async () => {
      (barButton(container, "Restore this version") as HTMLElement).click();
    });
    await act(async () => {
      const confirm = barButton(container, "confirm restore") as HTMLElement;
      // same-tick double click — the ref guard must hold it to ONE post
      confirm.click();
      confirm.click();
    });
    expect(restoreAttempts).toHaveLength(1);
    expect(restoreAttempts[0]).toEqual({
      boardId: "b1",
      fromN: 1,
      expectedVersion: 2,
    });
    // the failure surfaced via the ApiError message pattern
    expect(container.querySelector("div.error")?.textContent).toContain(
      "version conflict",
    );
    // disarmed: the confirm collapsed back to the arm affordance
    expect(container.querySelector(".confirm-inline")).toBe(null);
    expect(container.querySelector(".restore-bar")?.textContent).toContain(
      "Restore this version",
    );
    // the reset is clean: with the failure cleared, a fresh arm + confirm posts
    restoreFailures.error = null;
    await act(async () => {
      (barButton(container, "Restore this version") as HTMLElement).click();
    });
    await act(async () => {
      (barButton(container, "confirm restore") as HTMLElement).click();
    });
    expect(restoreAttempts).toHaveLength(2);
    expect(restoredBoards).toEqual([
      { boardId: "b1", fromN: 1, expectedVersion: 2 },
    ]);
    expect(container.querySelector("div.error")).toBe(null);
  });
});
