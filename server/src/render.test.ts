import { describe, expect, test } from "bun:test";
import type { Element } from "happy-dom";
import { Window } from "happy-dom";
import {
  InvalidAssetEmbed,
  renderHtmlDocument,
  renderMarkdownDocument,
  TASK_LIST_TITLE,
} from "./render.ts";

// Code fences in plain double-quoted strings — no escaping needed there.
const DOC = [
  "# Board Title",
  "",
  "Intro paragraph with $x^2$ inline math.",
  "",
  "| Col A | Col B |",
  "| --- | --- |",
  "| a1 | b1 |",
  "| a2 | b2 |",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "```mermaid",
  "graph TD; A-->B;",
  "```",
  "",
].join("\n");

// Frozen expected output — same input must always produce this exact document.
const GOLDEN = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1 data-ba="b1">Board Title</h1>
<p data-ba="b2">Intro paragraph with <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="katex-base"><span class="katex-strut" style="height:0.8141em;"></span><span class="mord"><span class="mord mathnormal">x</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist" style="height:0.8141em;"><span style="top:-3.063em;margin-right:0.05em;"><span class="pstrut" style="height:2.7em;"></span><span class="katex-sizing reset-size6 size3 mtight"><span class="mord mtight">2</span></span></span></span></span></span></span></span></span></span></span> inline math.</p>
<table data-ba="b3">
<thead>
<tr data-ba="b3r1">
<th>Col A</th>
<th>Col B</th>
</tr>
</thead>
<tbody><tr data-ba="b3r2">
<td>a1</td>
<td>b1</td>
</tr>
<tr data-ba="b3r3">
<td>a2</td>
<td>b2</td>
</tr>
</tbody></table>
<pre class="shiki github-light" style="background-color:#fff;color:#24292e" tabindex="0" data-ba="b4"><code><span class="line"><span style="color:#D73A49">const</span><span style="color:#005CC5"> x</span><span style="color:#D73A49">:</span><span style="color:#005CC5"> number</span><span style="color:#D73A49"> =</span><span style="color:#005CC5"> 1</span><span style="color:#24292E">;</span></span>
<span class="line"></span></code></pre>
<pre class="mermaid" data-ba="b5">graph TD; A--&gt;B;
</pre>
</body></html>`;

const window = new Window();

function parseBody(html: string): Element {
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  return doc.body as unknown as Element;
}

describe("renderMarkdownDocument", () => {
  test("produces the exact golden document", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html).toBe(GOLDEN);
  });

  test("is deterministic across runs", async () => {
    const first = await renderMarkdownDocument(DOC);
    const second = await renderMarkdownDocument(DOC);
    expect(second.html).toBe(first.html);
    expect(second.anchors).toEqual(first.anchors);
  });

  test("wraps the body in a full html document with charset meta", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("</head><body>");
    expect(html.endsWith("</body></html>")).toBe(true);
  });

  test("extracts the anchor set: heading, blocks, table + rows", async () => {
    const { anchors } = await renderMarkdownDocument(DOC);
    expect(anchors).toEqual([
      { id: "b1", kind: "heading", label: "Board Title" },
      { id: "b2", kind: "block" },
      { id: "b3", kind: "block" },
      { id: "b3r1", kind: "row" },
      { id: "b3r2", kind: "row" },
      { id: "b3r3", kind: "row" },
      { id: "b4", kind: "block" },
      { id: "b5", kind: "block" },
    ]);
  });

  test("every top-level element carries a data-ba id", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    const body = parseBody(html);
    const elements = [...body.children];
    expect(elements.length).toBe(5);
    for (const [index, el] of elements.entries()) {
      expect(el.getAttribute("data-ba")).toBe(`b${index + 1}`);
    }
  });

  test("table rows carry b3r<j> data-ba ids, header included", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    const table = parseBody(html).querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.getAttribute("data-ba")).toBe("b3");
    const rows = [...(table?.querySelectorAll("tr") ?? [])];
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      expect(row.getAttribute("data-ba")).toBe(`b3r${index + 1}`);
    }
  });

  test("inline math becomes katex markup", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html).toContain('class="katex');
    expect(html).not.toContain("$x^2$");
  });

  test("mermaid fences become pre.mermaid with the raw source", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html).toContain('class="mermaid"');
    expect(html).toContain("graph TD; A--&gt;B;");
    expect(html).not.toContain("language-mermaid");
  });

  test("ts fences are shiki-highlighted", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html).toContain("shiki");
    expect(html).toContain("github-light");
  });

  test("script tags in markdown input are gone", async () => {
    const md = ["before", "", "<script>alert(1)</script>", "", "after"].join(
      "\n",
    );
    const { html } = await renderMarkdownDocument(md);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  test("iframe/object/embed/noscript are forbidden", async () => {
    const md = [
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object>',
      '<embed src="x" />',
      "<noscript>no</noscript>",
      "text",
    ].join("\n");
    const { html } = await renderMarkdownDocument(md);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("<noscript");
    expect(html).toContain("text");
  });

  test("display math $$...$$ renders in display mode", async () => {
    const { html } = await renderMarkdownDocument("$$x = y$$");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("$$x = y$$");
  });

  test("math inside code fences is left alone", async () => {
    const md = ["```ts", 'const s = "$x^2$";', "```"].join("\n");
    const { html } = await renderMarkdownDocument(md);
    expect(html).toContain("$x^2$");
    expect(html).not.toContain("katex");
  });

  test("invalid math does not throw and keeps the document", async () => {
    const { html } = await renderMarkdownDocument("costs $5 and $10 today");
    expect(html).toContain("costs");
    expect(html.endsWith("</body></html>")).toBe(true);
  });
});

// D18: html boards are derived documents too — the publish pipeline injects
// data-ba ids (opt-in markers kept) and stores the injected document. No
// DOMPurify: agent scripts surviving into the stored document IS the decision.
describe("renderHtmlDocument", () => {
  const INPUT = [
    "<!doctype html><html><head><title>Board</title></head><body>",
    '<section data-ba="s-header" data-ba-label="Header"><h1>Hi</h1></section>',
    "<p>unlabeled paragraph</p>",
    "<table><tr><td>cell</td></tr></table>",
    "</body></html>",
  ].join("");

  test("auto-injects ids on unlabeled top-level blocks and table rows, keeping opt-in markers", () => {
    const { html, anchors } = renderHtmlDocument(INPUT);
    expect(html).toBe(
      `<!doctype html><html><head><title>Board</title></head><body><section data-ba="s-header" data-ba-label="Header"><h1>Hi</h1></section><p data-ba="b2">unlabeled paragraph</p><table data-ba="b3"><tbody><tr data-ba="b3r1"><td>cell</td></tr></tbody></table></body></html>`,
    );
    expect(anchors).toEqual([
      { id: "s-header", kind: "block", label: "Header" },
      { id: "b2", kind: "block" },
      { id: "b3", kind: "block" },
      { id: "b3r1", kind: "row" },
    ]);
  });

  test("is deterministic across runs", () => {
    const first = renderHtmlDocument(INPUT);
    const second = renderHtmlDocument(INPUT);
    expect(second.html).toBe(first.html);
    expect(second.anchors).toEqual(first.anchors);
  });

  test("injects nothing when every top-level block and row already carries data-ba", () => {
    const html =
      '<body><section data-ba="s1" data-ba-label="One"></section><table data-ba="t1"><tr data-ba="t1r1"></tr></table></body>';
    const { html: out, anchors } = renderHtmlDocument(html);
    expect(out).toBe(
      `<!doctype html><html><head></head><body><section data-ba="s1" data-ba-label="One"></section><table data-ba="t1"><tbody><tr data-ba="t1r1"></tr></tbody></table></body></html>`,
    );
    expect(anchors).toEqual([
      { id: "s1", kind: "block", label: "One" },
      { id: "t1", kind: "block" },
      { id: "t1r1", kind: "row" },
    ]);
  });

  test("fills around opt-in ids without colliding with them", () => {
    const html =
      '<body><div data-ba="b2">taken</div><p>first</p><p>second</p></body>';
    const { html: out } = renderHtmlDocument(html);
    expect(out).toContain('<div data-ba="b2">taken</div>');
    expect(out).toContain('<p data-ba="b2-2">first</p>');
    expect(out).toContain('<p data-ba="b3">second</p>');
  });

  test("table rows without ids get positional ids under the table, opt-in rows kept", () => {
    const html =
      '<body><table><tr data-ba="kept-row"></tr><tr><td>x</td></tr></table></body>';
    const { anchors } = renderHtmlDocument(html);
    expect(anchors).toEqual([
      { id: "b1", kind: "block" },
      { id: "kept-row", kind: "row" },
      { id: "b1r2", kind: "row" },
    ]);
  });

  test("an empty data-ba-label attribute is treated as no label", () => {
    const { anchors } = renderHtmlDocument(
      '<body><div data-ba="a" data-ba-label=""></div></body>',
    );
    expect(anchors).toEqual([{ id: "a", kind: "block" }]);
  });

  test("scripts survive verbatim and get no anchor ids — no DOMPurify on html boards (D18)", () => {
    const html =
      "<body><p>x</p><script>alert(1)</script><script src='/libs/chart-4.4.9.umd.min.js'></script></body>";
    const { html: out, anchors } = renderHtmlDocument(html);
    expect(out).toContain("<script>alert(1)</script>");
    expect(out).toContain(
      `<script src="/libs/chart-4.4.9.umd.min.js"></script>`,
    );
    expect(anchors).toEqual([{ id: "b1", kind: "block" }]);
  });

  test("fragment input is wrapped as a full document", () => {
    const { html } = renderHtmlDocument("<p>plain</p>");
    expect(html).toBe(
      `<!doctype html><html><head></head><body><p data-ba="b1">plain</p></body></html>`,
    );
    expect(html.startsWith("<!doctype html><html>")).toBe(true);
  });

  // Unpatched happy-dom re-emits the text before a stray `-->` (A --> B
  // became A A --> B), breaking every mermaid arrow on an html board.
  // Fixed by patches/happy-dom@20.14.5.patch; this fails if the patch stops applying.
  test("a stray --> in text survives parsing, while real comments and script bodies stay intact", () => {
    const { html } = renderHtmlDocument(
      [
        '<body><pre class="mermaid">flowchart LR\n A --> B\n B --> C</pre>',
        "<p>x --> y</p><p>a --!> b</p><textarea>c --> d</textarea>",
        "<!-- note --><script>if (a-->0) {}</script></body>",
      ].join(""),
    );
    expect(html).toBe(
      [
        '<!doctype html><html><head></head><body><pre class="mermaid" data-ba="b1">flowchart LR\n A --&gt; B\n B --&gt; C</pre>',
        '<p data-ba="b2">x --&gt; y</p><p data-ba="b3">a --!&gt; b</p><textarea data-ba="b4">c --&gt; d</textarea>',
        "<!-- note --><script>if (a-->0) {}</script></body></html>",
      ].join(""),
    );
  });
});

// Task lists are a static-snapshot affordance: the GFM checkbox input is
// replaced with a glyph span post-sanitize (a disabled input still read as an
// interactive control, dogfooded). The look is CSS (styles.css, scoped to
// .board-content.markdown); these assert the DOM shape the CSS keys off.
describe("task list glyphs", () => {
  test("checkbox inputs are replaced with glyph spans carrying the snapshot title", async () => {
    const { html } = await renderMarkdownDocument(
      "- [ ] unchecked thing\n- [x] checked thing\n",
    );
    const body = parseBody(html);
    // no control semantics left anywhere in the document
    expect(body.querySelectorAll("input")).toHaveLength(0);
    const glyphs = [...body.querySelectorAll("span.task-glyph")];
    expect(glyphs).toHaveLength(2);
    // both states get the why-hint (the one thing CSS cannot carry)
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("title")).toBe(TASK_LIST_TITLE);
      // decorative marker: the list text carries the meaning
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
    }
    // checked state is clearly distinct: ☐ open, ☑ checked
    expect(glyphs[0].textContent).toBe("☐");
    expect(glyphs[1].textContent).toBe("☑");
  });

  test("html boards keep their checkbox inputs — glyphs are markdown-only (D18)", () => {
    const { html } = renderHtmlDocument(
      '<body><form><input type="checkbox"></form></body>',
    );
    expect(html).not.toContain(TASK_LIST_TITLE);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("task-glyph");
  });
});

// Publish-time guard (dogfooded, live root-cause): an agent script wrote
// "asset:undefined" into a board and the embed silently degraded. Now the
// publish fails with InvalidAssetEmbed (→ 400 invalid_asset_embed at the
// route); only shape-valid ids rewrite.
describe("asset embed rewriting", () => {
  test("shape-valid ids rewrite to the asset route before sanitize", async () => {
    const { html } = await renderMarkdownDocument("![shot](asset:AbCdEf1234)");
    expect(html).toContain('src="/assets/AbCdEf1234"');
    expect(html).not.toContain("asset:");
  });

  test("shape-invalid asset: srcs fail the publish, naming the src", async () => {
    for (const src of ["asset:undefined", "asset:abc"]) {
      let err: unknown;
      await renderMarkdownDocument(`![gone](${src})`).catch((caught) => {
        err = caught;
      });
      expect(err).toBeInstanceOf(InvalidAssetEmbed);
      expect((err as Error).message).toBe(`unknown asset embed "${src}"`);
    }
  });

  test("a long src is echoed capped — the message stays under ~120 chars", async () => {
    let err: unknown;
    await renderMarkdownDocument(`![x](asset:${"x".repeat(500)})`).catch(
      (caught) => {
        err = caught;
      },
    );
    expect(err).toBeInstanceOf(InvalidAssetEmbed);
    const message = (err as Error).message;
    expect(message.length).toBeLessThanOrEqual(120);
    expect(message.startsWith('unknown asset embed "asset:xxx')).toBe(true);
  });

  test("non-asset images are not validated — relative and external srcs publish", async () => {
    const { html } = await renderMarkdownDocument(
      "![rel](foo.png)\n\n![ext](https://example.com/pic.png)",
    );
    expect(html).toContain('<img src="foo.png"');
    expect(html).toContain('<img src="https://example.com/pic.png"');
  });
});
