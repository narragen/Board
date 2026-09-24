import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

// A board's inline script shares ONE global scope with every other board
// opened in the same browser session: mountBoardDocument re-creates scripts in
// the host document, and published versions are immutable, so the app cannot
// retroactively isolate scripts that are already out there. A template that
// declares anything at top level therefore breaks the SECOND board a reviewer
// opens — the duplicate binding is a SyntaxError, the script never runs, and
// that board renders nothing at all. Dogfooded exactly that way:
// "Identifier 'BOARD_ID' has already been declared".
//
// This reproduces it rather than proxying for it: the same script is compiled
// twice into one context, which is what the browser does when two boards are
// visited in one session. Runtime errors are expected and ignored (there is no
// DOM here) — only a redeclaration SyntaxError fails the test.
function inlineScripts(html: string): string[] {
  return [
    ...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
  ]
    .map((match) => match[1])
    .filter((body) => body.trim().length > 0);
}

function redeclarationError(body: string): string | null {
  const context = createContext({});
  for (const pass of [1, 2]) {
    try {
      runInContext(body, context);
    } catch (err) {
      // Duck-typed on purpose: the error is constructed inside the vm's own
      // realm, so `err instanceof SyntaxError` is ALWAYS false here and a
      // guard written that way can never fail. (Dogfooded — this test was
      // written that way first, and passed against a template with the bug
      // deliberately reintroduced.)
      const thrown = err as { constructor?: { name?: string }; message?: string };
      if (thrown?.constructor?.name === "SyntaxError") {
        return `pass ${pass}: ${thrown.message}`;
      }
      // ReferenceError/TypeError from touching a DOM that is not here is the
      // expected outcome — the script compiled, which is all we are asserting.
    }
  }
  return null;
}

describe("shipped board templates keep their scripts out of global scope", () => {
  for (const name of ["interview-round.html", "dashboard.html"]) {
    test(`${name} can be loaded twice in one page session`, () => {
      const bodies = inlineScripts(
        readFileSync(join(import.meta.dir, name), "utf8"),
      );
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(redeclarationError(body)).toBeNull();
      }
    });
  }
});
