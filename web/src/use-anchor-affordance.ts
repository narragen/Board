import { type RefObject, useEffect, useRef, useState } from "react";
import type { Anchor, Version } from "../../server/src/domain.ts";
import { anchorForElement, anchorFromSelection } from "./anchor.ts";
import type { BoardWithVersions } from "./api.ts";
import { assetIdFromSrc } from "./image.ts";

// The floating "comment on this" button's target: which anchor it would create
// and where on screen it sits.
export interface Affordance {
  anchor: Anchor;
  top: number;
  left: number;
  label: string;
}

// What the board view needs to render and drive the floating button. The three
// mutators exist because the button itself participates in the hover/selection
// bookkeeping below — it is not a passive readout.
export interface AnchorAffordance {
  current: Affordance | null;
  // pointer entered the floating button: hold the affordance up
  pin: () => void;
  // pointer left the floating button: drop it unless a selection holds it
  unpin: () => void;
  // the button was acted on: hide it and drop both holds
  consume: () => void;
  // something else took over (the lightbox): drop both holds, leave what is
  // shown alone
  release: () => void;
}

// Offers one comment affordance at a time over the mounted board content: a
// button at a text selection, or one under the pointer for the hovered asset
// image / [data-ba] element.
//
// This owns three pieces of pointer bookkeeping that only make sense together,
// which is why the two effects and the button's handlers live in one hook —
// hover and selection compete for the same single affordance slot, and each of
// the refs below exists because a real bug was reported without it.
//
// `version` + `data` are the mounted content's identity: the delegated hover
// listeners rebind when the content DOM is replaced. Call this AFTER
// useBoardDocument so that DOM exists when they bind.
export function useAnchorAffordance(
  containerRef: RefObject<HTMLDivElement | null>,
  version: Version | null,
  data: BoardWithVersions | null,
): AnchorAffordance {
  const [affordance, setAffordance] = useState<Affordance | null>(null);
  const hoverTargetRef = useRef<Element | null>(null);
  // The floating button pins the affordance while the pointer is on it —
  // without the pin, leaving the section toward the button unmounts it
  // before the click lands (the reported "icon disappears" bug).
  const pinnedRef = useRef(false);
  // While a selection affordance is up, hover affordances are suppressed —
  // the pointer crosses other sections on the way to the button and would
  // swap it out mid-flight (the reported "clicking does nothing" bug).
  const selectionActiveRef = useRef(false);

  // Selection affordance: text selected inside the board content offers a
  // comment button at the selection (mouseup — the selection is done by
  // then). Dismissed when the selection collapses anywhere else.
  useEffect(() => {
    const onMouseUp = (): void => {
      if (pinnedRef.current) {
        return;
      }
      const sel = window.getSelection();
      const root = containerRef.current;
      if (
        sel === null ||
        root === null ||
        sel.isCollapsed ||
        sel.rangeCount === 0
      ) {
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        return;
      }
      const anchor = anchorFromSelection(sel, root);
      if (anchor === null) {
        return;
      }
      const rect = range.getBoundingClientRect();
      selectionActiveRef.current = true;
      setAffordance({
        anchor,
        top: rect.top - 34,
        left: rect.left + rect.width / 2,
        label: "Comment on selection",
      });
    };
    const onSelectionChange = (): void => {
      const sel = window.getSelection();
      if (selectionActiveRef.current && (sel === null || sel.isCollapsed)) {
        selectionActiveRef.current = false;
        if (!pinnedRef.current) {
          setAffordance(null);
        }
      }
    };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [containerRef]);

  // Hover affordance: one comment button under the pointer — asset images
  // get the annotate affordance (image anchors), other [data-ba] elements
  // get sections/rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version/data are intentional re-run triggers — the listeners rebind when the content DOM is replaced
  useEffect(() => {
    const root = containerRef.current;
    if (root === null) {
      return;
    }
    const closest = (
      event: Event,
    ): { anchor: Anchor; el: Element; label: string } | null => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") {
        return null;
      }
      // an asset image wins over its surrounding section: the annotation
      // targets the image itself
      const img = target.closest("img");
      if (img !== null) {
        const assetId = assetIdFromSrc(img.getAttribute("src") ?? "");
        if (assetId !== null) {
          return {
            anchor: { type: "image", asset_id: assetId },
            el: img,
            label: "annotate image",
          };
        }
      }
      const el = target.closest("[data-ba]");
      if (el === null) {
        return null;
      }
      return {
        anchor: anchorForElement(el),
        el,
        label: el.tagName === "TR" ? "Comment on row" : "Comment on section",
      };
    };
    const onMouseOver = (event: Event): void => {
      if (selectionActiveRef.current) {
        return;
      }
      const found = closest(event);
      const el = found?.el ?? null;
      if (el === hoverTargetRef.current) {
        return;
      }
      hoverTargetRef.current = el;
      if (found === null || !root.contains(found.el)) {
        if (!pinnedRef.current) {
          setAffordance(null);
        }
        return;
      }
      const rect = found.el.getBoundingClientRect();
      setAffordance({
        anchor: found.anchor,
        top: rect.top + 2,
        left: rect.right - 6,
        label: found.label,
      });
    };
    const onMouseOut = (event: MouseEvent): void => {
      // happy-dom reports an absent relatedTarget as undefined, not null —
      // normalize or every "left the content" event would hit contains(undefined)
      const to = event.relatedTarget ?? null;
      // moving onto the floating button (or while pinned) keeps the affordance
      const toButton =
        to !== null &&
        to instanceof Element &&
        to.classList.contains("floating-comment");
      if (pinnedRef.current || toButton) {
        return;
      }
      // still inside the content — the next mouseover replaces the affordance
      if (to !== null && to instanceof Node && root.contains(to)) {
        return;
      }
      hoverTargetRef.current = null;
      setAffordance(null);
    };
    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mouseout", onMouseOut as (event: Event) => void);
    return () => {
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener(
        "mouseout",
        onMouseOut as (event: Event) => void,
      );
    };
  }, [containerRef, version, data]);

  const release = (): void => {
    selectionActiveRef.current = false;
    pinnedRef.current = false;
  };

  return {
    current: affordance,
    pin: () => {
      pinnedRef.current = true;
    },
    unpin: () => {
      pinnedRef.current = false;
      hoverTargetRef.current = null;
      if (!selectionActiveRef.current) {
        setAffordance(null);
      }
    },
    consume: () => {
      setAffordance(null);
      release();
    },
    release,
  };
}
