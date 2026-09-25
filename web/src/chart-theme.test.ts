import { beforeEach, describe, expect, test } from "bun:test";
import { boardChartTheme, installBoardChartTheme } from "./chart-theme.ts";
import { installDom } from "./test-dom.ts";

installDom();

function setTokens(values: Record<string, string>): void {
  const style = document.createElement("style");
  const body = Object.entries(values)
    .map(([name, value]) => `${name}: ${value};`)
    .join("");
  style.textContent = `:root{${body}}`;
  document.head.append(style);
}

const TOKENS = {
  "--accent": "#9d7cd8",
  "--primary": "#fab283",
  "--secondary": "#5c9cf5",
  "--info": "#56b6c2",
  "--success": "#7fd88f",
  "--warning": "#f5a742",
  "--error": "#e06c75",
  "--fg-muted": "#808080",
  "--border-subtle": "#323232",
  "--font-sans": "DM Sans",
};

describe("boardChartTheme", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    delete (globalThis as unknown as { Chart?: unknown }).Chart;
  });

  test("throws a fixable message when Chart.js was never loaded", () => {
    setTokens(TOKENS);
    expect(() => boardChartTheme()).toThrow(/Chart is not defined/);
    // the error names the exact tag to add, because the alternative failure
    // mode is a chart that silently renders in Chart.js's own palette
    expect(() => boardChartTheme()).toThrow(/chart-4\.4\.9\.umd\.min\.js/);
  });

  test("pushes Board's tokens into Chart.js defaults and returns the palette", () => {
    setTokens(TOKENS);
    const chart = { defaults: {} as Record<string, unknown> };
    (globalThis as unknown as { Chart: unknown }).Chart = chart;

    const palette = boardChartTheme();

    expect(palette[0]).toBe(TOKENS["--accent"]);
    expect(palette).toHaveLength(7);
    expect(chart.defaults.color).toBe(TOKENS["--fg-muted"]);
    expect(chart.defaults.borderColor).toBe(TOKENS["--border-subtle"]);
    expect((chart.defaults.font as { family: string }).family).toBe("DM Sans");
    expect(
      (chart.defaults.scale as { grid: { color: string } }).grid.color,
    ).toBe(TOKENS["--border-subtle"]);
  });

  // The theme follows prefers-color-scheme, so a palette captured once is
  // wrong for a reader on the other scheme. Re-reading per call is the fix.
  test("re-reads the tokens on every call", () => {
    setTokens(TOKENS);
    (globalThis as unknown as { Chart: unknown }).Chart = { defaults: {} };
    expect(boardChartTheme()[0]).toBe("#9d7cd8");

    setTokens({ ...TOKENS, "--accent": "#d68c27" });
    expect(boardChartTheme()[0]).toBe("#d68c27");
  });

  test("installs itself as a global board scripts can call", () => {
    setTokens(TOKENS);
    (globalThis as unknown as { Chart: unknown }).Chart = { defaults: {} };
    installBoardChartTheme();
    const fn = (globalThis as unknown as { boardChartTheme?: () => string[] })
      .boardChartTheme;
    expect(typeof fn).toBe("function");
    expect(fn?.()).toHaveLength(7);
  });
});
