#!/usr/bin/env node
// QA-launcher-tab-trap (SOLO-13): the launcher is a modal sheet for the
// keyboard too. Tab on its last control goes to its first, Shift+Tab on the
// first to the last, and nothing behind the sheet is a Tab stop (the app
// behind it is inert). The rig sends DOM key events, which cannot move focus
// by themselves, so this checks what a trap does: the Tab is handled
// (default prevented) and lands inside.
//
// Negative control: a build before the fix lets Tab walk into the title
// bar, the activity bar and the sidebar behind the sheet.

import { openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-tab-trap", async ({ bridge, log, check }) => {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Fix this test");
  await waitLaunchEnabled(bridge);
  const r = await bridge.eval(`
    const sheet = e2e.first(".task-launcher-sheet");
    const sel = "a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex='-1'])";
    const inside = [...sheet.querySelectorAll(sel)].filter((e) => e2e.visible(e) && e.tabIndex >= 0);
    const outside = [...document.querySelectorAll(sel)].filter((e) => e2e.visible(e) && e.tabIndex >= 0 && !sheet.contains(e) && !e.closest("[inert]"));
    const last = inside[inside.length - 1], first = inside[0];
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(tab);
    const afterTab = document.activeElement === first;
    first.focus();
    const back = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(back);
    return { last: e2e.nameOf(last), first: e2e.nameOf(first), tabHandled: tab.defaultPrevented, afterTab, shiftTabHandled: back.defaultPrevented, afterShiftTab: document.activeElement === last, outside: outside.length, outsideSample: outside.slice(0, 4).map((e) => e2e.nameOf(e).slice(0, 30)) };
  `);
  log(`  ${JSON.stringify(r)}`);
  check(r.tabHandled && r.afterTab, `Tab on the last control (${r.last}) wraps to the first (${r.first})`);
  check(r.shiftTabHandled && r.afterShiftTab, "Shift+Tab on the first control wraps to the last");
  check(r.outside === 0, `nothing behind the sheet is a Tab stop (${r.outside}: ${r.outsideSample.join(" | ")})`);
  await bridge.click(".task-launcher-cancel");
  await waitLauncherClosed(bridge);
  const after = await bridge.eval(`return document.querySelectorAll("[inert]").length;`);
  check(after === 0, "closing the sheet gives the app back (nothing left inert)");
});
