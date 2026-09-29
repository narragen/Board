# Anchors

How comments point at content: the `data-ba` id scheme, the five comment-anchor variants, the image overlay schema, and how the web UI resolves each anchor back to a location. Sources of truth: `server/src/render.ts` (id injection + extraction), `server/src/validate.ts` + `server/src/comments.ts` (validation), `server/src/domain.ts` (types), `web/src/anchor.ts` + `web/src/image.ts` (resolution).

## The `data-ba` id scheme

Every annotatable element carries a `data-ba` attribute. Ids are injected at publish by the one shared injector (`injectAnchorIds` in `server/src/render.ts`):

- **Top-level body elements** get `b<i>` — `i` is 1-based over element children of `<body>` (text nodes skipped).
- **Table rows** get `<table-id>r<j>` — `j` is 1-based across ALL `<tr>` of the table, header included.
- Ids are **deterministic** (same input → same ids) and collision-free (a clash gets a `-2`, `-3`… suffix).
- `data-ba` elements are looked up by **iteration + attribute compare, never CSS-selector interpolation** — agent-supplied ids never touch a selector string (injection surface).

What gets ids, per version format (one document model, D18 — see [decisions.md](decisions.md) D18):

- **markdown**: the publish pipeline is marked GFM → `asset:` embed rewrite → DOMPurify → mermaid-block conversion → katex → shiki → task-list glyphs → id injection. DOMPurify strips scripts, so sanitized input arrives `data-ba`-free and every top-level block, heading, and table row gets a fresh positional id.
- **html**: the author's document, **unsanitized** (D18). The same injector runs with `keepExisting: true`: opt-in `data-ba="id"` markers (and `data-ba-label="…"` labels) are **kept verbatim**, only the gaps are filled — unlabeled top-level body children and their table rows. `<script>` elements never get auto-injected ids (invisible, unhighlightable content); an opt-in marker on one would still be kept. The **injected document is what gets stored** and later mounted into the host DOM; previously stored versions are never retro-injected.

The version's `anchors` column stores the extraction result — `ExtractedAnchor` = `{id, kind: "block" | "heading" | "row", label?}`:

- markdown: one entry per top-level element (`kind: "heading"` + label from the heading's text for H1–H6, `"block"` otherwise) plus one `"row"` entry per table row.
- html: one entry per `[data-ba]` element in document order — author-set markers at any depth appear; `kind: "row"` for `<tr>`, `"block"` otherwise; labels only from `data-ba-label`.

## Comment anchor schema

Anchors arrive on the wire as JSON, discriminated by `type` (`asAnchor` in `server/src/validate.ts`). Shape is validated at the boundary; **semantic** validity (does the section exist in that version? does the quote match? is the asset on this board?) is enforced by the comments store against the exact version the comment pins via `version_n` — a comment on missing content is a 400, never a silent dangling reference.

| Type | Fields | Points at |
|---|---|---|
| `board` | — | the whole board |
| `section` | `section_id` | one `data-ba` element (a `data-ba` id, usually `b<i>` from the current version) |
| `text` | `section_id`, `originalText`, `startOffset`, `endOffset` | a text range inside one section (plannotator's block+offset+quote model) |
| `row` | `section_id`, `row_id` | one table row: `section_id` = the **table's** `data-ba` id, `row_id` = the row's |
| `image` | `asset_id`, `overlay?` | an image asset on this board, optionally with drawn annotations |

A reply always inherits its parent's anchor + `version_n` — a thread stays pinned to one target.

### `board`

```json
{ "type": "board" }
```

### `section`

```json
{ "type": "section", "section_id": "b3" }
```

Server-side: `section_id` must resolve to an element with that `data-ba` in version `version_n`'s stored document, else 400 `invalid_anchor` ("section ... not found in vN").

### `text`

```json
{
  "type": "text",
  "section_id": "b5",
  "originalText": "roll out to 10% of traffic",
  "startOffset": 42,
  "endOffset": 69
}
```

- `originalText` is the exact quoted substring; `startOffset`/`endOffset` are character offsets within the **section's full `textContent`** (`endOffset` exclusive). The UI derives them as `sectionText.indexOf(selection)`.
- **The quote is the re-anchor truth; offsets are informational.** Server-side the section must *contain* `originalText`. Client-side, `highlightAnchor` re-locates the quote in the current document (quote-first, never blind offsets — after an edit, offsets would highlight whatever moved there); if the quote itself is gone the section is outlined and badged as moved (`anchor-moved`) rather than guessed at. Anchors surviving beyond quote re-match are a phase-2 item.

### `row`

```json
{ "type": "row", "section_id": "b4", "row_id": "b4r2" }
```

`row_id` must resolve to a `data-ba` element in the stored version (header rows carry ids too — `b4r1` is the header).

### `image`

```json
{ "type": "image", "asset_id": "aB3xY9kQ2m" }
```

The asset must exist **and belong to the comment's board** (cross-board asset refs are rejected). The UI resolves it by iterating `<img>` elements for `/assets/<id>` (never a selector built from the id), scrolling to and outlining the image.

## The overlay schema

`overlay` is optional on `image` anchors only — annotations drawn over the image, stored in the comment:

```json
{
  "type": "image",
  "asset_id": "aB3xY9kQ2m",
  "overlay": {
    "arrows": [{ "x1": 0.3, "y1": 0.4, "x2": 0.55, "y2": 0.4 }],
    "boxes": [{ "x": 0.6, "y": 0.38, "text": "this label overflows" }]
  }
}
```

- Coordinates are **normalized to 0..1 of the displayed image box** (not pixels): `x` = fraction across the width, `y` = fraction down the height, `(0,0)` = top-left — so a stored overlay scales with any layout. To compute from a local image: `x = pixel_x / width`, `y = pixel_y / height`.
- `arrows` — `{x1, y1, x2, y2}`: tail → head; **the head renders at `(x2, y2)`** (SVG line + a computed arrowhead triangle).
- `boxes` — `{x, y, text}`: positioned label; `(x, y)` is its top-left anchor point, `text` capped at **200 chars**.
- Caps (server-enforced, 400 `invalid_anchor`): **50 items max per list**, every coordinate in `[0, 1]`.
- The overlay may hold only arrows, only boxes, both, or be omitted (plain "on image" comment). Inverse rule: a **root** comment anchored to an image with ≥1 overlay item may post with an **empty body** — the overlay IS the payload; replies and all other anchors still require text.
- Overlay-only root comments render in the UI as the anchor affordance alone (no empty body block).

### Who produces and renders overlays

- **Editor** (`web/src/components/ImageOverlayEditor.tsx`): hand-rolled, no dependency — arrow = press-drag-release on the image, text = click to place + inline label entry, undo pops the last item. Coordinates are captured normalized to the displayed image box at gesture time.
- **Rendering** (`ImageOverlaySvg` / `ImageOverlayLayer`): the stored overlay is scaled to the **pixel space of the displayed image box** (`scaleOverlay`) and drawn as one absolutely-positioned SVG over the image; a measured zero box renders nothing until the first real measurement. The board view draws a thread's overlay on the board image when its chip is hovered; sidebar thumbnails carry the same layer; the **lightbox** (click a thumbnail) shows the full image with **every image-anchored thread's overlay stacked**, one layer per comment, plus the annotate button.

## How html boards anchor (the D18 story)

Agent HTML gets full anchoring with zero agent effort beyond `format: "html"`:

1. At publish, `renderHtmlDocument` parses the submitted document and runs the shared injector over `<body>`: top-level blocks and table rows receive `data-ba` ids unless already marked; opt-in `data-ba`/`data-ba-label` markers survive verbatim; scripts are left alone (they run in the host chrome — D18) and get no ids.
2. The **injected** document (`<!doctype html>` + serialized DOM) is the stored version content; extraction records every `[data-ba]` element.
3. At render, the web app mounts the document into the host DOM (head styles carried over, scripts re-created so they execute) — the same DOM the anchoring UX already covers: hover affordances on sections/rows, text-selection comments, highlight-on-click.
4. Semantic validation is identical to markdown: a `section`/`row`/`text` anchor must resolve against the stored version's `data-ba` elements, and a `text` anchor's quote must exist in the section's text content.

For an author who wants stable, meaningful anchor ids across republishes, set them explicitly:

```html
<table data-ba="rollout" data-ba-label="Rollout plan">
  <tr><th>stage</th><th>owner</th></tr>
  <tr><td>canary</td><td>agent</td></tr>
</table>
```

Rows become `rolloutr1` (header) and `rolloutr2`; a `{type: "row", section_id: "rollout", row_id: "rolloutr2"}` comment then survives re-publishes that keep the marker, even as positional `b<i>` ids shift.
