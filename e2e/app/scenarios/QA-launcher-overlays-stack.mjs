#!/usr/bin/env node
// QA-launcher-overlays-stack (CHAOS-12): one overlay at a time also for
// Settings, Keyboard Shortcuts and the classic New Session dialog. Opening
// one closes the others; the one in front has the keyboard (never the
// terminal behind it); Esc closes the one in front only. The launcher keeps
// its draft when another overlay takes its place.
//
// Negative control: a build before the fix opens Keyboard Shortcuts behind
// Settings with the keyboard left in the hidden terminal.

import { join } from "node:path";
import { launcherState, openLauncher, typeInto } from "../launcher-steps.mjs";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

const SEL = { settings: ".settings-panel", palette: ".command-palette", shortcuts: ".shortcuts-panel", launcher: ".task-launcher-sheet", creator: ".session-creator" };

await runLauncherQa("QA-launcher-overlays-stack", async ({ bridge, log, check, evidenceDir }) => {
  const state = () =>
    bridge.eval(`
      const sel = ${JSON.stringify(SEL)};
      const open = Object.entries(sel).filter(([, s]) => !!e2e.first(s)).map(([k]) => k);
      const f = document.activeElement;
      const focusIn = Object.entries(sel).find(([, s]) => f && f.closest && f.closest(s))?.[0] || (f ? f.tagName.toLowerCase() + "." + String(f.className).split(" ")[0] : null);
      return { open, focusIn };`);
  await menuAction(bridge, "file.new-session-tab");
  await bridge.waitFor("a plain shell", `return window.__HERMES_E2E__.terminalIds().length === 1;`, { timeoutMs: 30_000 });
  await sleep(1500);

  await menuAction(bridge, "hermes.settings");
  await sleep(800);
  await menuAction(bridge, "view.shortcuts");
  await sleep(900);
  let s = await state();
  log(`  Settings, then Keyboard Shortcuts: ${JSON.stringify(s)}`);
  await bridge.screenshot(join(evidenceDir, "01-settings-then-shortcuts.png"));
  check(JSON.stringify(s.open) === JSON.stringify(["shortcuts"]), "Keyboard Shortcuts replaces Settings");
  check(s.focusIn === "shortcuts", "and has the keyboard (not the terminal behind)");

  await menuAction(bridge, "view.command-palette");
  await sleep(800);
  s = await state();
  log(`  then the palette: ${JSON.stringify(s)}`);
  check(JSON.stringify(s.open) === JSON.stringify(["palette"]) && s.focusIn === "palette", "the palette replaces it and has the keyboard");

  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Draft that must survive");
  await menuAction(bridge, "hermes.settings");
  await sleep(1000);
  s = await state();
  log(`  the launcher, then Settings: ${JSON.stringify(s)}`);
  check(JSON.stringify(s.open) === JSON.stringify(["settings"]), "Settings replaces the launcher");
  await bridge.eval(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
  await sleep(1000);
  s = await state();
  log(`  Esc: ${JSON.stringify(s)}`);
  check(!s.open.includes("settings"), "Esc closes Settings");
  await openLauncher(bridge, { draft: "keep" });
  const st = await launcherState(bridge);
  check(st.task === "Draft that must survive", "the launcher kept its draft");

  await menuAction(bridge, "view.split-horizontal");
  await sleep(800);
  s = await state();
  check(!s.open.includes("creator"), "a split asked for behind the launcher opens no New Session dialog on top of it");
  await bridge.screenshot(join(evidenceDir, "02-end.png"));
});
