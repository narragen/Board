import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createComponentHarness, installDom } from "../test-dom.ts";
import { BoardList } from "./BoardList.tsx";
import { installApiMock, listBoardsFailure } from "./test-api.ts";

installDom();
installApiMock();

const { render, cleanup } = createComponentHarness();
afterEach(cleanup);
afterEach(() => {
  listBoardsFailure.thrown = null;
});

describe("BoardList", () => {
  test("renders boards with status, author, tags, and unresolved counts", async () => {
    const container = render(<BoardList />);
    await act(async () => {});
    expect(container.innerHTML).toContain("Decision brief");
    expect(container.innerHTML).toContain("open");
    expect(container.innerHTML).toContain("agent-1");
    expect(container.innerHTML).toContain("plan");
    expect(container.innerHTML).toContain("2 unresolved");
    expect(container.querySelector("a.board-card")?.getAttribute("href")).toBe(
      "#/boards/b1",
    );
  });

  // Regression: the load error text. A rejection carrying no message of its own
  // must still say WHICH load failed — `errText(err, fallback)` and useLoad's
  // fallbackMessage exist for exactly this, and collapsing them to String(err)
  // renders "[object Object]" at the user. One representative site: this covers
  // the useLoad path all three read-only panels share.
  test("load errors: an Error shows its message, a non-Error the domain fallback", async () => {
    listBoardsFailure.thrown = new Error("session expired — run make open");
    const withError = render(<BoardList />);
    await act(async () => {});
    expect(withError.querySelector(".error")?.textContent).toBe(
      "session expired — run make open",
    );

    listBoardsFailure.thrown = { code: "not_an_error" };
    const withNonError = render(<BoardList />);
    await act(async () => {});
    expect(withNonError.querySelector(".error")?.textContent).toBe(
      "failed to load boards",
    );
  });

  test("renders the subscriber count and the audit entry link", async () => {
    const container = render(<BoardList />);
    await act(async () => {});
    expect(container.innerHTML).toContain("3 subs");
    const auditLink = container.querySelector("a.audit-link");
    expect(auditLink?.getAttribute("href")).toBe("#/audit");
  });
});
