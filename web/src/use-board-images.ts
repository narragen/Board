import { type RefObject, useCallback, useEffect, useState } from "react";
import type { Version } from "../../server/src/domain.ts";
import type { BoardWithVersions } from "./api.ts";
import { assetIdFromSrc } from "./image.ts";

// The board images inside `containerRef`: each asset image gets a positioned
// wrap (the portal target for its badge and hover overlay) and a delegated
// click that opens the review lightbox. Both formats are treated alike.
//
// `version` + `data` are the mounted content's identity — the wraps and the
// listener are rebuilt when the content DOM is replaced — so call this AFTER
// useBoardDocument, whose mount puts that DOM in place.
export function useBoardImages(
  containerRef: RefObject<HTMLDivElement | null>,
  version: Version | null,
  data: BoardWithVersions | null,
): {
  imageTargets: Record<string, HTMLElement>;
  lightbox: { assetId: string } | null;
  openLightbox: (assetId: string) => void;
  closeLightbox: () => void;
} {
  const [imageTargets, setImageTargets] = useState<Record<string, HTMLElement>>(
    {},
  );
  // the image lightbox: the asset whose review modal is open (one modal at a
  // time — a single value, replaced on each open)
  const [lightbox, setLightbox] = useState<{ assetId: string } | null>(null);

  // Board images (markdown embeds and agent html alike) get wrapped so
  // badges and hover overlays can portal into a positioned box hugging the
  // image. Runs after content injection (markdown innerHTML commits during
  // render; the html mount's synchronous prefix appends body children before
  // its first await). The wrap span is ours — React only replaces the
  // container wholesale on version change, and the effect re-runs on that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version/data are intentional re-run triggers — the listeners rebind when the content DOM is replaced
  useEffect(() => {
    const root = containerRef.current;
    if (root === null || version === null) {
      return;
    }
    const targets: Record<string, HTMLElement> = {};
    for (const img of [...root.querySelectorAll("img")]) {
      const assetId = assetIdFromSrc(img.getAttribute("src") ?? "");
      if (assetId === null) {
        continue;
      }
      let wrap = img.parentElement;
      if (wrap === null || !wrap.classList.contains("image-anchor-wrap")) {
        wrap = root.ownerDocument.createElement("span");
        wrap.className = "image-anchor-wrap";
        img.replaceWith(wrap);
        wrap.append(img);
      }
      targets[assetId] = wrap;
    }
    setImageTargets(targets);
  }, [containerRef, version, data]);

  // Lightbox entry (dogfooded ask [163]: "click the image and have it open in
  // a modal, so that I can further review and annotate"): a delegated click on
  // any board image whose src is a served asset — both formats, since the wrap
  // effect above treats them alike. preventDefault so an asset img nested in a
  // markdown link cannot half-navigate while the modal opens: for asset images
  // the lightbox IS the click's action.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version/data are intentional re-run triggers — the listeners rebind when the content DOM is replaced
  useEffect(() => {
    const root = containerRef.current;
    if (root === null || version === null) {
      return;
    }
    const onClick = (event: Event): void => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") {
        return;
      }
      const img = target.closest("img");
      if (img === null) {
        return;
      }
      const assetId = assetIdFromSrc(img.getAttribute("src") ?? "");
      if (assetId !== null) {
        event.preventDefault();
        setLightbox({ assetId });
      }
    };
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("click", onClick);
    };
  }, [containerRef, version, data]);

  const openLightbox = useCallback((assetId: string): void => {
    setLightbox({ assetId });
  }, []);
  const closeLightbox = useCallback((): void => {
    setLightbox(null);
  }, []);

  return { imageTargets, lightbox, openLightbox, closeLightbox };
}
