// window.boardChartTheme() — the one helper the app exposes to board scripts
// (D28, ruled A).
//
// Chart.js knows nothing about Board's theme: it draws with its own default
// grey-on-white palette, which has no relationship to the opencode tokens the
// rest of the page uses and is close to unreadable on the dark theme. Every
// agent that wanted a chart to look like it belonged had to hand-feed
// getComputedStyle values into Chart.defaults — a dozen lines of boilerplate
// nobody will think to write, so charts came out looking pasted in.
//
// Reading the tokens at call time rather than caching them is deliberate: the
// theme follows prefers-color-scheme, so a cached palette is wrong for any
// reader whose scheme differs from whoever loaded the page first.

// Semantic tokens, in the order a multi-series chart should consume them.
// Not a sequential scale — these are Board's own accents, so a chart reads as
// part of the app rather than as an embedded image.
const SERIES_TOKENS = [
  "--accent",
  "--primary",
  "--secondary",
  "--info",
  "--success",
  "--warning",
  "--error",
] as const;

interface ChartDefaults {
  color?: string;
  borderColor?: string;
  font?: { family?: string };
  scale?: { grid?: { color?: string }; ticks?: { color?: string } };
  plugins?: { legend?: { labels?: { color?: string } } };
}

export function boardChartTheme(
  scope: typeof globalThis = globalThis,
): string[] {
  const doc = (scope as unknown as { document?: Document }).document;
  // Through the document's own view, not a bare global: that is what makes
  // this work in any realm the app is mounted in, tests included.
  const view = doc?.defaultView;
  if (doc === undefined || view === null || view === undefined) {
    throw new Error("boardChartTheme(): no document");
  }
  const css = view.getComputedStyle(doc.documentElement);
  const token = (name: string): string => css.getPropertyValue(name).trim();
  const palette = SERIES_TOKENS.map(token).filter((value) => value.length > 0);

  const chart = (scope as unknown as { Chart?: { defaults: ChartDefaults } })
    .Chart;
  if (chart === undefined) {
    // Fail loud. A silent no-op here surfaces later as an off-theme chart with
    // nothing to explain it — exactly the failure this helper exists to remove.
    throw new Error(
      "boardChartTheme(): Chart is not defined — load " +
        '<script src="/libs/chart-4.4.9.umd.min.js"></script> in <head> first',
    );
  }
  const defaults = chart.defaults;
  defaults.color = token("--fg-muted");
  defaults.borderColor = token("--border-subtle");
  defaults.font = { ...defaults.font, family: token("--font-sans") };
  defaults.scale = {
    ...defaults.scale,
    grid: { color: token("--border-subtle") },
    ticks: { color: token("--fg-muted") },
  };
  defaults.plugins = {
    ...defaults.plugins,
    legend: { labels: { color: token("--fg-muted") } },
  };
  return palette;
}

export function installBoardChartTheme(
  scope: typeof globalThis = globalThis,
): void {
  (scope as unknown as { boardChartTheme: () => string[] }).boardChartTheme =
    () => boardChartTheme(scope);
}
