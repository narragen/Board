// The publish render pipeline: markdown/html input → the one stored HTML
// document, with `data-ba` anchor ids injected (docs/anchors.md).
//
// Read this first: everything up to `patchCreateNodeIterator` below is
// happy-dom compatibility shimming for DOMPurify (D11) — not pipeline logic.
// The pipeline itself starts at `renderMarkdownDocument`.
import type { Config } from "dompurify";
import createDOMPurify from "dompurify";
import type { Document, Element, Node, Text } from "happy-dom";
import { Window } from "happy-dom";
import katex from "katex";
import { marked } from "marked";
import { codeToHtml } from "shiki";
import type { ExtractedAnchor } from "./domain.ts";
import { SHORT_ID_LENGTH } from "./ids.ts";

const window = new Window();

// happy-dom's Node.prototype.nodeName getter returns "" unconditionally (real
// names come from per-subclass getters), but dompurify caches exactly that base
// getter for its clobber-safe node-name reads — every element would classify as
// tagName "" and get stripped. Redefine the base getter to be receiver-correct
// (spec nodeType dispatch); subclasses still shadow it.
interface NodeNameLike {
  nodeType: number;
  tagName?: string;
  name?: string;
  target?: string;
}

function specNodeName(this: NodeNameLike): string {
  switch (this.nodeType) {
    case 1:
      return this.tagName ?? "";
    case 2:
      return this.name ?? "";
    case 3:
      return "#text";
    case 4:
      return "#cdata-section";
    case 7:
      return this.target ?? "";
    case 8:
      return "#comment";
    case 9:
      return "#document";
    case 10:
      return this.name ?? "";
    case 11:
      return "#document-fragment";
    default:
      return "";
  }
}

Object.defineProperty(window.Node.prototype, "nodeName", {
  configurable: true,
  get: specNodeName,
});

// happy-dom's NodeIterator stops returning nodes as soon as the walk removes
// one, but DOMPurify's whole design is "iterate + remove inline" — everything
// after the first removal would survive unsanitized — invariant 5 (markdown
// through DOMPurify), docs/security.md "Content rules". Replace
// createNodeIterator on the exact document dompurify caches it from with a
// removal-robust pre-order iterator.
function withinRoot(root: Node, node: Node): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (current === root) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

function preorderSuccessor(node: Node, root: Node): Node | null {
  if (node.firstChild !== null) {
    return node.firstChild;
  }
  let current: Node | null = node;
  while (current !== null && current !== root) {
    if (current.nextSibling !== null) {
      return current.nextSibling;
    }
    current = current.parentNode;
  }
  return null;
}

interface RobustNodeIterator {
  nextNode(): Node | null;
}

function createRobustNodeIterator(
  root: Node,
  whatToShow: number,
): RobustNodeIterator {
  const visited = new Set<Node>();
  let last: Node | null = null;
  let lastConnected: Node | null = null;
  const shows = (node: Node): boolean =>
    ((whatToShow >>> (node.nodeType - 1)) & 1) === 1;
  return {
    nextNode(): Node | null {
      let candidate: Node | null;
      if (last === null) {
        candidate = root;
      } else if (withinRoot(root, last)) {
        candidate = preorderSuccessor(last, root);
      } else if (lastConnected !== null && withinRoot(root, lastConnected)) {
        // last was removed by the walk: resume after the last surviving node —
        // hoisted children of the removed node sit right there
        candidate = preorderSuccessor(lastConnected, root);
      } else {
        candidate = root;
      }
      while (candidate !== null) {
        if (shows(candidate) && !visited.has(candidate)) {
          visited.add(candidate);
          last = candidate;
          lastConnected = candidate;
          return candidate;
        }
        candidate = preorderSuccessor(candidate, root);
      }
      return null;
    },
  };
}

function patchCreateNodeIterator(targetWindow: Window): void {
  // mirror dompurify's factory: it caches createNodeIterator from the template
  // contents owner document when the platform supports <template>
  const template = targetWindow.document.createElement("template");
  const doc =
    template.content?.ownerDocument ?? (targetWindow.document as Document);
  doc.createNodeIterator =
    createRobustNodeIterator as Document["createNodeIterator"];
}

patchCreateNodeIterator(window);

// dompurify v3 factory pattern: bind to our happy-dom window. Markdown rendered
// for the host chrome passes through DOMPurify, always (invariant 5,
// docs/security.md "Content rules").
const purifier = createDOMPurify(
  window as unknown as Parameters<typeof createDOMPurify>[0],
);

// script removal is DOMPurify default; the rest are the board-content forbid
// list (docs/plan.md "one document model").
const SANITIZE_CONFIG: Config = {
  FORBID_TAGS: ["script", "iframe", "object", "embed", "noscript"],
};

// SVG assets are sanitized at ingest with an SVG-only profile — invariant 6
// (verified asset ingest), docs/security.md "Assets": event handlers are never in any profile's allow
// list; script + foreignObject are in the svg profile by default and are
// explicitly forbidden; and the URI allowlist narrows to same-document
// fragment references so no external beacon can ride an asset. xmlns
// declarations are exempt from that narrowing — without them the served
// image/svg+xml document would not parse as SVG.
const SVG_SANITIZE_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ["script", "foreignobject"],
  // DOMPurify checks ALLOWED_URI_REGEXP against EVERY attribute value, not
  // just href/src — a bare /^#/ stripped all geometry (x, width, d, viewBox …;
  // only #-prefixed fills survived — dogfooded on the M5+M6 acceptance board).
  // This shape allows plain values and url(#fragment) refs while blocking
  // scheme-bearing URLs, protocol-relative //, and url(<non-#>) — the
  // external-reference classes docs/security.md "Assets" excludes.
  ALLOWED_URI_REGEXP:
    /^(?![a-z][a-z0-9+.-]*:)(?!\/\/)(?!url\(\s*['"]?\s*(?!#))/i,
  ADD_URI_SAFE_ATTR: ["xmlns", "xmlns:xlink"],
};

const MATH_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const CODE_HIGHLIGHT_THEME = "github-light";

// GFM task lists render `<input type="checkbox" disabled>` — honest markup for
// a published snapshot (boards are static versions, docs/plan.md), but a
// disabled input still LOOKS like an interactive control (dogfooded: "still
// has checkboxes"). Post-sanitize, the input is replaced outright with a glyph
// span: no control semantics left, checked state carried by the glyph
// character (☐ open / ☑ checked), the title kept as the one hint CSS cannot
// carry, and aria-hidden because the marker is decorative — the list item's
// own text carries the meaning. Runs AFTER sanitize, on already-sanitized
// nodes only, never by widening the sanitizer profile — invariant 5 (markdown
// through DOMPurify).
// Deliberately NOT applied to html boards (renderHtmlDocument): D18 scripts
// make their checkboxes genuinely interactive.
export const TASK_LIST_TITLE =
  "boards are published snapshots — comment instead";

function replaceTaskListCheckboxes(doc: Document, body: Element): void {
  for (const input of [...body.querySelectorAll('input[type="checkbox"]')]) {
    const glyph = doc.createElement("span");
    glyph.className = "task-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.setAttribute("title", TASK_LIST_TITLE);
    glyph.textContent = input.hasAttribute("checked") ? "☑" : "☐";
    input.replaceWith(glyph);
  }
}

interface RenderedDocument {
  html: string;
  anchors: ExtractedAnchor[];
}

// Step ORDER is load-bearing (docs/anchors.md "markdown"), and reordering
// breaks anchoring silently rather than loudly:
//   - sanitize before parsing into the document, so nothing downstream ever
//     walks unsanitized nodes — invariant 5 (markdown through DOMPurify);
//   - convertMermaidBlocks before highlightCodeBlocks, or mermaid fences are
//     still <code> when the highlighter reaches them and get syntax-coloured
//     into garbage;
//   - injectAnchorIds LAST, so positional ids land on the final structure —
//     any later transform would shift the blocks the ids were assigned to and
//     every stored comment anchor would point at the wrong element.
export async function renderMarkdownDocument(
  md: string,
): Promise<RenderedDocument> {
  const fragment = await marked.parse(md);
  const sanitized = purifier.sanitize(
    rewriteAssetUris(fragment),
    SANITIZE_CONFIG,
  );
  const doc = new window.DOMParser().parseFromString(sanitized, "text/html");
  const body = doc.body as unknown as Element;
  convertMermaidBlocks(doc, body);
  renderMath(doc, body);
  await highlightCodeBlocks(doc, body);
  replaceTaskListCheckboxes(doc, body);
  injectAnchorIds(body, false);
  return {
    html: wrapDocument(body.innerHTML),
    anchors: collectMarkdownAnchors(body),
  };
}

// Publish validation for asset embeds. Extends Error, not StoreError: the
// render pipeline runs INSIDE publishVersion (boards.ts imports render.ts), so
// subclassing StoreError would be a circular import — the ImportRejected
// precedent (bundle-import.ts) extends Error for the same reason. errors.ts maps
// this to 400 "invalid_asset_embed"; MCP surfaces err.message as the tool
// error text.
export class InvalidAssetEmbed extends Error {
  constructor(src: string) {
    // the message names the offending src so the agent can find it in their
    // publish payload — but a src can be arbitrarily long; cap the echo so
    // one hostile embed cannot produce a multiline error (kept ≤ 120 chars)
    const named = src.length > 64 ? `${src.slice(0, 61)}…` : src;
    super(`unknown asset embed "${named}"`);
    this.name = "InvalidAssetEmbed";
  }
}

// Asset embeds (M6): ![alt](asset:<id>) rewrites to /assets/<id> BEFORE
// sanitize — DOMPurify strips unknown uri schemes, so a post-sanitize rewrite
// would have nothing left to rewrite (and widening the sanitizer's URI scheme
// list for asset: is exactly what invariant 5 — markdown through DOMPurify —
// forbids).
//
// Decision update (dogfooded, live root-cause): an agent script interpolated
// an undefined variable into "asset:undefined", and the old behavior — keep
// the asset: URI, let DOMPurify strip it, ship a broken image — silently
// degraded the embed. Silent degrade was designed for robustness, but the
// live round showed agents need the actionable 400: a board that silently
// loses its images falsifies the document, while a rejected publish is
// recoverable (the agent fixes the src and retries). So a shape-invalid
// asset: src now throws InvalidAssetEmbed.
//
// Scope stays narrow: only asset:-prefixed srcs are validated here.
// Non-asset: images (external/relative markdown srcs) pass through DOMPurify
// below as always; unknown-but-shape-valid ids still rewrite and 404 at serve
// time (the id shape is right — the asset may be minted after the draft).
// html boards never reach this function (D18 — their markup is their own).
function rewriteAssetUris(fragment: string): string {
  const doc = new window.DOMParser().parseFromString(fragment, "text/html");
  for (const img of [...doc.body.querySelectorAll("img")]) {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith("asset:")) {
      continue;
    }
    const id = src.slice("asset:".length);
    if (!new RegExp(`^[0-9A-Za-z]{${SHORT_ID_LENGTH}}$`).test(id)) {
      throw new InvalidAssetEmbed(src);
    }
    img.setAttribute("src", `/assets/${id}`);
  }
  return doc.body.innerHTML;
}

// D18: html boards are derived documents too. The publish pipeline parses the
// full document, injects data-ba ids on unlabeled top-level blocks and table
// rows (opt-in data-ba markers are kept), and the INJECTED document is the
// stored version content. Deliberately NO DOMPurify here: agent scripts
// running in the host chrome is the explicit D18 decision — the owner's
// accepted risk, recorded in docs/decisions.md. Host-side exposure is bounded
// by the host CSP (daemon.ts), connect-src 'self' being the exfil kill-switch.
export function renderHtmlDocument(html: string): RenderedDocument {
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  const body = doc.body as unknown as Element;
  injectAnchorIds(body, true);
  return {
    html: `<!doctype html>${doc.documentElement.outerHTML}`,
    anchors: collectHtmlAnchors(body),
  };
}

function parseFragment(doc: Document, html: string): Element {
  const holder = doc.createElement("div");
  holder.innerHTML = html;
  return holder;
}

// Ingest-time SVG verification (M6): SVG has no magic bytes — parse-and-
// sanitize IS its verification (docs/security.md "Assets"). Runs on the same
// D11-patched window/purifier as markdown. Returns null when the sanitized
// output contains no svg element at all (the input was never an SVG document).
//
// Known happy-dom limitation, fail-closed: the HTML parser truncates an svg
// subtree at a content-bearing <script>/<style> (everything after it inside
// the svg is lost before DOMPurify ever sees it) — the attack payload is
// destroyed either way; the drawing simply does not survive such input.
export function sanitizeSvgDocument(svg: string): string | null {
  // happy-dom (the daemon's DOMPurify window, D11) truncates a parsed svg
  // subtree at a content-bearing <script>/<style> — everything after it is
  // lost before DOMPurify ever sees it. Stripping both blocks up front means
  // the parser never trips: attack payloads are removed deterministically and
  // benign STYLED drawings survive intact (their styles are dropped — an
  // honest, documented degradation, docs/security.md "Assets").
  const stripped = svg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<style\b[^>]*\/>/gi, "");
  const sanitized = purifier.sanitize(stripped, SVG_SANITIZE_CONFIG);
  const doc = new window.DOMParser().parseFromString(sanitized, "text/html");
  return doc.querySelector("svg") !== null ? sanitized : null;
}

// Mermaid renders client-side in the web UI later; here we only swap the
// fenced block for the pre.mermaid source container.
function convertMermaidBlocks(doc: Document, body: Element): void {
  for (const code of [...body.querySelectorAll("pre > code")]) {
    if (!code.classList.contains("language-mermaid")) {
      continue;
    }
    const pre = code.parentElement;
    if (pre === null) {
      continue;
    }
    const mermaidPre = doc.createElement("pre");
    mermaidPre.setAttribute("class", "mermaid");
    mermaidPre.textContent = code.textContent ?? "";
    pre.replaceWith(mermaidPre);
  }
}

// $ and $$ math only in prose text nodes — never inside code/pre (literal
// source) or already-rendered katex output; style/script literals with $ are
// likewise not math.
function collectMathTextNodes(root: Element): Text[] {
  const skipTags = new Set(["CODE", "PRE", "SCRIPT", "STYLE"]);
  const out: Text[] = [];
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        out.push(child as Text);
        continue;
      }
      if (child.nodeType !== 1) {
        continue;
      }
      const el = child as Element;
      if (
        skipTags.has(el.tagName) ||
        el.classList.contains("katex") ||
        el.classList.contains("katex-display")
      ) {
        continue;
      }
      walk(el);
    }
  };
  walk(root);
  return out;
}

function renderMath(doc: Document, body: Element): void {
  for (const textNode of collectMathTextNodes(body)) {
    const text = textNode.data;
    const matches = [...text.matchAll(MATH_RE)];
    if (matches.length === 0) {
      continue;
    }
    const parent = textNode.parentNode;
    if (parent === null) {
      continue;
    }
    let last = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      const before = text.slice(last, index);
      if (before.length > 0) {
        parent.insertBefore(doc.createTextNode(before), textNode);
      }
      const display = match[1] !== undefined;
      const tex = (display ? match[1] : match[2]) ?? "";
      let rendered: string | null = null;
      try {
        rendered = katex.renderToString(tex, {
          throwOnError: false,
          displayMode: display,
        });
      } catch {
        rendered = null;
      }
      if (rendered === null) {
        // leave the raw text in place when katex refuses the input
        parent.insertBefore(doc.createTextNode(match[0]), textNode);
      } else {
        const holder = parseFragment(doc, rendered);
        while (holder.firstChild !== null) {
          parent.insertBefore(holder.firstChild, textNode);
        }
      }
      last = index + match[0].length;
    }
    const tail = text.slice(last);
    if (tail.length > 0) {
      parent.insertBefore(doc.createTextNode(tail), textNode);
    }
    parent.removeChild(textNode);
  }
}

async function highlightCodeBlocks(
  doc: Document,
  body: Element,
): Promise<void> {
  for (const code of [...body.querySelectorAll("pre > code")]) {
    const lang = /language-(\S+)/.exec(code.className)?.[1];
    if (lang === undefined) {
      continue;
    }
    const pre = code.parentElement;
    if (pre === null) {
      continue;
    }
    let highlighted: string;
    try {
      highlighted = await codeToHtml(code.textContent ?? "", {
        lang,
        theme: CODE_HIGHLIGHT_THEME,
      });
    } catch {
      // unknown language: keep the plain pre/code block
      continue;
    }
    const holder = parseFragment(doc, highlighted);
    pre.replaceWith(...holder.childNodes);
  }
}

// data-ba scheme: b<i> for each top-level element (1-based, elements only);
// table rows get <table-id>r<j> (1-based across the whole table, header
// included). Deterministic: same input, same ids. This is the ONE injector
// shared by both formats: markdown passes keepExisting=false (sanitized input
// arrives data-ba-free, every id allocated fresh, positional); html passes
// keepExisting=true (D18) — opt-in data-ba markers are kept untouched and only
// the gaps are filled, skipping ids already present anywhere in the document.
function injectAnchorIds(body: Element, keepExisting: boolean): void {
  const used = new Set<string>();
  if (keepExisting) {
    for (const el of [...body.querySelectorAll("[data-ba]")]) {
      const id = el.getAttribute("data-ba") ?? "";
      if (id !== "") {
        used.add(id);
      }
    }
  }
  const allocate = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n++) {
      id = `${base}-${n}`;
    }
    used.add(id);
    return id;
  };
  let i = 0;
  for (const child of [...body.childNodes]) {
    if (child.nodeType !== 1) {
      continue;
    }
    const el = child as Element;
    i++;
    if (el.tagName === "SCRIPT") {
      // scripts are invisible, unhighlightable content — they never get
      // auto-injected ids (opt-in markers on them are still kept below);
      // markdown cannot reach here (the sanitizer strips scripts)
      continue;
    }
    const existing = keepExisting ? (el.getAttribute("data-ba") ?? "") : "";
    const id = existing !== "" ? existing : allocate(`b${i}`);
    el.setAttribute("data-ba", id);
    if (el.tagName === "TABLE") {
      let j = 0;
      for (const row of [...el.querySelectorAll("tr")]) {
        j++;
        const rowExisting = keepExisting
          ? (row.getAttribute("data-ba") ?? "")
          : "";
        row.setAttribute(
          "data-ba",
          rowExisting !== "" ? rowExisting : allocate(`${id}r${j}`),
        );
      }
    }
  }
}

// Markdown anchor list: kinds are derived from the element (headings carry
// their text as label — markdown has no label scheme of its own).
function collectMarkdownAnchors(body: Element): ExtractedAnchor[] {
  const anchors: ExtractedAnchor[] = [];
  for (const el of [...body.children]) {
    const id = el.getAttribute("data-ba") ?? "";
    if (el.tagName === "TABLE") {
      anchors.push({ id, kind: "block" });
      for (const row of [...el.querySelectorAll("tr")]) {
        anchors.push({ id: row.getAttribute("data-ba") ?? "", kind: "row" });
      }
    } else if (HEADING_TAGS.has(el.tagName)) {
      anchors.push({ id, kind: "heading", label: el.textContent ?? undefined });
    } else {
      anchors.push({ id, kind: "block" });
    }
  }
  return anchors;
}

// Html anchor list (over the injected document): every data-ba element in
// document order, labels only from the opt-in data-ba-label attribute.
function collectHtmlAnchors(body: Element): ExtractedAnchor[] {
  const anchors: ExtractedAnchor[] = [];
  for (const el of [...body.querySelectorAll("[data-ba]")]) {
    anchors.push({
      id: el.getAttribute("data-ba") ?? "",
      kind: el.tagName === "TR" ? "row" : "block",
      label: el.getAttribute("data-ba-label") || undefined,
    });
  }
  return anchors;
}

function wrapDocument(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${bodyHtml}</body></html>`;
}
