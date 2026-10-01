#!/usr/bin/env node
// QA-status-min-window — at the smallest window Hermes allows (600 × 400)
// every status-bar control is inside the window, in English and in German.
//
//   1. a terminal session; the window is set to 600 × 400
//   EXPECT: no control of the window lies outside it; the status bar drops
//   the folder name and the session's age first and folds Check for
//   updates, Report a Bug and Keyboard Shortcuts into a "⋯" menu, whose
//   items are all there and inside the window when it opens
//   2. the same in German (longer words)
//   3. back to 1200 × 800: the three controls are on the bar again
//
// Was broken: the version chip, Report a Bug and Keyboard Shortcuts sat
// outside the window and could not be reached.

import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { invoke, sleep, startApp } from "../qa-status-steps.mjs";

const offscreen = (bridge) =>
  bridge.eval(`
  return e2e.all("button, a, [role=button], [role=menuitem]").map((el) => ({ n: e2e.nameOf(el).slice(0, 40), r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 0 && (x.r.left < -1 || x.r.right > innerWidth + 1 || x.r.bottom > innerHeight + 1)).map((x) => x.n + " @x=" + Math.round(x.r.left) + ".." + Math.round(x.r.right));`);

const resize = async (bridge, width, height) => {
  await invoke(bridge, "plugin:window|set_size", { label: "main", value: { Logical: { width, height } } });
  await bridge.waitFor(`the window at ${width} px`, `return innerWidth <= ${width} + 2 && innerWidth >= ${width} - 40;`, { timeoutMs: 10_000 });
  await sleep(600);
};

await runScenario("QA-status-min-window", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { bridge } = await startApp("qa-minwin", evidenceDir, log, onCleanup, apps);
  await bridge.eval(`return await window.__HERMES_E2E__.newTerminal({ label: "shell" });`, { timeoutMs: 30_000 });
  await sleep(1500);

  for (const lang of ["en", "de"]) {
    if (lang !== "en") {
      await invoke(bridge, "set_setting", { key: "ui_language", value: lang });
      await bridge.eval(`localStorage.setItem("hermes.ui_language", ${JSON.stringify(lang)}); return true;`);
      await bridge.reload();
      await bridge.waitFor("the app after the reload", `return !!e2e.first(".status-bar");`, { timeoutMs: 30_000 });
      await sleep(1500);
    }
    await resize(bridge, 600, 400);
    const out = await offscreen(bridge);
    const bar = await bridge.eval(`return {
      folder: !!e2e.first(".status-bar-cwd"), age: !!e2e.first(".status-bar-elapsed"),
      chip: !!e2e.first(".status-version-chip"), bug: !!e2e.first(".status-bug-btn"), keys: !!e2e.first(".status-shortcuts-btn"),
      more: e2e.first(".status-more-btn") ? e2e.nameOf(e2e.first(".status-more-btn")) : null };`);
    log(`  [${lang}] outside the window: ${JSON.stringify(out)}; bar: ${JSON.stringify(bar)}`);
    await bridge.screenshot(join(evidenceDir, `01-min-${lang}.png`));
    assert(out.length === 0, `[${lang}] every control is inside the window at 600 × 400`);
    assert(!bar.folder && !bar.age, `[${lang}] the folder name and the age are dropped first`);
    assert(!bar.chip && !bar.bug && !bar.keys && bar.more, `[${lang}] the three controls fold into the "⋯" menu (${bar.more})`);
    await bridge.click(".status-more-btn");
    const items = await bridge.waitFor("the menu", `const m = e2e.all('[role="menuitem"]'); return m.length ? m.map((i) => e2e.norm(i.innerText)) : null;`);
    const outMenu = await offscreen(bridge);
    log(`  [${lang}] menu: ${JSON.stringify(items)}; outside: ${JSON.stringify(outMenu)}`);
    await bridge.screenshot(join(evidenceDir, `02-menu-${lang}.png`));
    const expected = lang === "en" ? ["Check for updates", "Report a Bug", "Keyboard Shortcuts"] : ["Nach Updates suchen", "Fehler melden", "Tastenkürzel"];
    assert(expected.every((e) => items.some((i) => i.startsWith(e))), `[${lang}] the menu has ${expected.join(", ")}`);
    assert(outMenu.length === 0, `[${lang}] the open menu is inside the window`);
    await bridge.eval(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
    await sleep(300);
  }

  await resize(bridge, 1200, 800);
  const wide = await bridge.eval(`return { chip: !!e2e.first(".status-version-chip"), bug: !!e2e.first(".status-bug-btn"), keys: !!e2e.first(".status-shortcuts-btn"), more: !!e2e.first(".status-more-btn") };`);
  log(`  at 1200 px: ${JSON.stringify(wide)}`);
  assert(wide.chip && wide.bug && wide.keys && !wide.more, "at a normal width the controls are on the bar again");
});
