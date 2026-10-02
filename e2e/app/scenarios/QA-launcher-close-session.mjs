#!/usr/bin/env node
// QA-launcher-close-session (SOLO-14): a session can be ended with the
// keyboard alone, through the usual close checks: the command palette has
// "Close Session" (with its shortcut) and "Close Session and Remove
// Worktree…", and Session > Close Session (⌘⇧W / Ctrl+Shift+Q) does the same.
//
// Negative control: a build before the fix has no such command; ⌘W only
// closes the pane and the session keeps running.

import { join } from "node:path";
import { openLauncher, pressKeyOnFocus, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

async function launchOne(bridge, task) {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", task);
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
}

const sessionCount = (bridge) => bridge.eval(`return e2e.all(".session-item").length;`);

await runLauncherQa("QA-launcher-close-session", async ({ bridge, log, check, evidenceDir }) => {
  await launchOne(bridge, "Explain this error");
  await launchOne(bridge, "Second task");
  await bridge.waitFor("two sessions", `return e2e.all(".session-item").length === 2;`, { timeoutMs: 30_000 });

  await menuAction(bridge, "view.command-palette");
  await bridge.waitFor("the palette", `return !!e2e.first(".command-palette-input");`);
  await typeInto(bridge, ".command-palette-input", "close");
  await sleep(300);
  const hits = await bridge.eval(`return e2e.all(".command-palette-item").map((e) => e2e.norm(e.innerText));`);
  log(`  palette "close": ${JSON.stringify(hits)}`);
  check(hits.some((h) => /^Close Session/.test(h) && /(⌘⇧W|Ctrl\+Shift\+Q)/.test(h)), "the palette has Close Session, with its shortcut");
  check(hits.some((h) => /Close Session and Remove Worktree/.test(h)), "and Close Session and Remove Worktree…");
  await pressKeyOnFocus(bridge, "Enter");
  await sleep(800);
  if (await bridge.exists(".close-dialog")) {
    log("  the usual close question");
    await bridge.screenshot(join(evidenceDir, "01-close-question.png"));
    await bridge.click(".close-dialog .close-dialog-btn-confirm");
  }
  await bridge.waitFor("one session left", `return e2e.all(".session-item").length === 1;`, { timeoutMs: 20_000 }).catch(() => {});
  check((await sessionCount(bridge)) === 1, "Close Session from the palette ends the session in view");

  await menuAction(bridge, "session.close-session");
  await sleep(800);
  if (await bridge.exists(".close-dialog")) await bridge.click(".close-dialog .close-dialog-btn-confirm");
  await bridge.waitFor("no session left", `return e2e.all(".session-item").length === 0;`, { timeoutMs: 20_000 }).catch(() => {});
  check((await sessionCount(bridge)) === 0, "Session > Close Session ends it too");
});
