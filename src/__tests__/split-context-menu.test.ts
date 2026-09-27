/**
 * Regression tests for #299 — "Split Right/Down" from the terminal / pane
 * header context menu must open a NEW session in the new pane (same flow
 * as the menu bar and Cmd+D), not re-use the current pane's session.
 *
 * Re-using the session put the same pooled xterm in two panes: the
 * terminal was re-parented into one of them and the other stayed blank
 * with no prompt.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { registerMenuBarHandler, triggerMenuBarAction } from "../hooks/nativeMenuBridge";

const splitPaneSrc = readFileSync(resolve(__dirname, "../components/SplitPane.tsx"), "utf-8");

function caseBody(actionId: string): string {
  const start = splitPaneSrc.indexOf(`case "${actionId}":`);
  expect(start).toBeGreaterThan(-1);
  const end = splitPaneSrc.indexOf("break;", start);
  return splitPaneSrc.slice(start, end);
}

describe("context-menu split (#299)", () => {
  it.each([
    ["terminal.split-right", "view.split-horizontal"],
    ["terminal.split-down", "view.split-vertical"],
    ["pane.split-right", "view.split-horizontal"],
    ["pane.split-down", "view.split-vertical"],
  ])("%s routes to the menu bar %s flow instead of splitting with the same session", (ctxAction, menuAction) => {
    const body = caseBody(ctxAction);
    expect(body).not.toContain("SPLIT_PANE");
    expect(body).toContain(`triggerMenuBarAction("${menuAction}")`);
  });

  it("triggerMenuBarAction invokes the registered menu bar handler", () => {
    const handler = vi.fn();
    const cleanup = registerMenuBarHandler(handler);
    triggerMenuBarAction("view.split-horizontal");
    expect(handler).toHaveBeenCalledWith("view.split-horizontal");
    cleanup();
    triggerMenuBarAction("view.split-vertical");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
