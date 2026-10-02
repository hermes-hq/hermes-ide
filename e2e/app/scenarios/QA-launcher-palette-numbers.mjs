#!/usr/bin/env node
// QA-launcher-palette-numbers (SOLO-08): with a session in a named group
// (the sidebar lists named groups first), the command palette's ⌘1–⌘9
// labels follow the same order as the sidebar and the ⌘1–⌘9 keys: the row
// labelled ⌘n is the session ⌘n switches to.
//
// Negative control: a build before the fix labels the palette rows in
// creation order while ⌘n follows the sidebar.

import { invoke, MOD, openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

async function launchOne(bridge, task) {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", task);
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
}

await runLauncherQa("QA-launcher-palette-numbers", async ({ bridge, log, check }) => {
  for (const task of ["First task", "Second task", "Third task"]) await launchOne(bridge, task);
  await bridge.waitFor("three sessions", `return e2e.all(".session-item").length === 3;`, { timeoutMs: 30_000 });
  const sessions = await invoke(bridge, "get_sessions");
  const third = sessions.find((s) => s.label === "Third task");
  await invoke(bridge, "update_session_group", { sessionId: third.id, group: "app" });
  await bridge.waitFor("the sidebar group first", `return e2e.all(".session-item").length === 3 && /Third task/.test(e2e.first(".session-item").innerText);`, { timeoutMs: 10_000 });
  await menuAction(bridge, "view.command-palette");
  await bridge.waitFor("the palette", `return !!e2e.first(".command-palette");`);
  const hints = await bridge.eval(`
    const out = {};
    for (const r of e2e.all(".command-palette-item")) {
      const k = e2e.norm(r.querySelector(".command-palette-shortcut")?.innerText ?? "");
      const label = e2e.norm(r.querySelector(".command-palette-label")?.innerText ?? "");
      const m = k.match(/^(?:⌘|Ctrl\\+)([1-9])$/);
      if (m && /task$/.test(label)) out[m[1]] = label;
    }
    return out;`);
  log(`  the palette says: ${JSON.stringify(hints)}`);
  await bridge.eval(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
  await sleep(400);
  for (const n of ["1", "2", "3"]) {
    await bridge.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "${n}", code: "Digit${n}", bubbles: true, cancelable: true, ...${JSON.stringify(MOD)} })); return true;`);
    await sleep(500);
    const shown = await bridge.eval(`return e2e.norm(e2e.first(".split-pane-label")?.innerText ?? "");`);
    log(`  ⌘${n} shows: ${shown}`);
    check(!!hints[n] && shown.startsWith(hints[n]), `the palette's ⌘${n} (${hints[n]}) is the session ⌘${n} opens (${shown})`);
  }
});
