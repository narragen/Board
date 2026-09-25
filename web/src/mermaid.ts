// Mermaid renders client-side in the host chrome (D12): the daemon leaves
// fences in the stored document as <pre class="mermaid"> source and the app
// draws them here.
//
// Both board formats render (D26). Markdown boards get their pre.mermaid from
// the publish pipeline; an html board writes the element itself. The html case
// is the reason this is a module and not an effect body: an html board's
// content is injected asynchronously (external scripts are awaited in document
// order), so rendering has to be chained onto that mount rather than run
// alongside it — an effect firing in parallel finds zero nodes and silently
// renders nothing, which is what made html boards show raw diagram source.
//
// Already-rendered blocks are skipped: mermaid marks a node data-processed and
// re-running over one throws.
export async function renderMermaidBlocks(
  root: HTMLElement,
  isCancelled: () => boolean,
): Promise<void> {
  const nodes = [
    ...root.querySelectorAll("pre.mermaid:not([data-processed])"),
  ] as HTMLElement[];
  if (nodes.length === 0) {
    return;
  }
  try {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ securityLevel: "strict", startOnLoad: false });
    if (isCancelled()) {
      return;
    }
    await mermaid.run({ nodes });
  } catch {
    // a bad diagram degrades to its source text — never breaks the page
  }
}
