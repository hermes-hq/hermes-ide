#!/usr/bin/env node
// Scenario QA-chrome-modal-keyboard (CHAOS-13): Settings, Keyboard Shortcuts
// and the Cost Dashboard, opened from the menu bar while a terminal has the
// keyboard, take the keyboard themselves. On the REAL app, plain shell.
//
// For each of the three, opened from its menu item (the Cost Dashboard
// with the fleet controls off, the only way it opens):
//   1. the keyboard is inside the dialog (Settings: on its selected tab);
//   2. letters typed then never reach the shell behind it;
//   3. Tab from the last control comes back to the first, Shift+Tab from
//      the first goes to the last (the keyboard never leaves the dialog);
//   4. the terminal behind cannot take the keyboard back while it is open;
//   5. Esc closes it and the keyboard is back in the terminal it came from.
//
// Keys are key events sent to whatever has the keyboard (the rig sends no
// OS input on macOS). Negative control (must end in RESULT: FAIL): a build
// of main before the fix (the keyboard stays in the terminal, "zzleak"
// reaches the shell, Esc leaves Settings open).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/QA-chrome-modal-keyboard.mjs

import { join } from "node:path";
import { E2E_FLAG_DEFAULTS, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";

const DIALOGS = [
  { name: "Settings", action: "hermes.settings", panel: ".settings-panel", first: '.settings-tab[aria-selected="true"]' },
  { name: "Keyboard Shortcuts", action: "view.shortcuts", panel: ".shortcuts-panel", first: null },
  { name: "Cost Dashboard", action: "view.cost-dashboard", panel: ".cost-dashboard", first: null },
];

/** A key the way the keyboard sends it, to whatever has the keyboard. */
const press = (bridge, init) =>
  bridge.eval(`
    const t = document.activeElement || document.body;
    const d = { ...${JSON.stringify(init)}, bubbles: true, cancelable: true, composed: true, view: window };
    t.dispatchEvent(new KeyboardEvent("keydown", d));
    t.dispatchEvent(new KeyboardEvent("keyup", d));
    return true;
  `);

/** Letters typed into whatever has the keyboard (keydown, keypress, input as a browser does). */
const typeLetters = (bridge, text) =>
  bridge.eval(`
    const t = document.activeElement || document.body;
    for (const ch of ${JSON.stringify(text)}) {
      const d = { key: ch, code: "Key" + ch.toUpperCase(), bubbles: true, cancelable: true, composed: true, view: window };
      if (t.dispatchEvent(new KeyboardEvent("keydown", d))) t.dispatchEvent(new KeyboardEvent("keypress", { ...d, charCode: ch.charCodeAt(0) }));
      t.dispatchEvent(new KeyboardEvent("keyup", d));
    }
    return true;
  `);

const where = (bridge, panel, sessionId) =>
  bridge.eval(`
    const a = document.activeElement;
    const host = a?.closest?.("[data-session-id]");
    return {
      inDialog: !!a && !!a.closest(${JSON.stringify(panel)}),
      inTerminal: !!a?.closest?.(".xterm") && host?.dataset.sessionId === ${JSON.stringify(sessionId)},
      el: a ? a.tagName.toLowerCase() + "." + String(a.className).split(" ")[0] : null,
      selectedTab: a?.matches?.('.settings-tab[aria-selected="true"]') ?? false,
    };
  `);

await runScenario("QA-chrome-modal-keyboard", async ({ evidenceDir, log, apps }) => {
  const problems = [];
  const check = (ok, message) => {
    log(`  ${ok ? "ok" : "FAILED"} — ${message}`);
    if (!ok) problems.push(message);
  };
  // The Cost Dashboard opens only without the fleet controls (they show the
  // spend an agent reports instead), so they are off for this run.
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log, flagDefaults: { ...E2E_FLAG_DEFAULTS, fleetControls: false } });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);
  const sid = await createPlainTerminal(bridge, log);
  const leaked = async (word) => ((await bridge.readTerminal(sid)) ?? []).some((l) => l.includes(word));

  for (const [i, d] of DIALOGS.entries()) {
    log(`step ${i + 1}: ${d.name}, opened from the menu while the terminal has the keyboard`);
    await bridge.eval(`window.__HERMES_E2E__.focusTerminal(${JSON.stringify(sid)}); return true;`);
    await bridge.waitFor("the terminal to have the keyboard", `return !!document.activeElement?.closest?.(".xterm");`, { timeoutMs: 5_000 });
    await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: ${JSON.stringify(d.action)} } }); return true;`);
    await bridge.waitFor(`${d.name} to open`, `return !!e2e.first(${JSON.stringify(d.panel)});`, { timeoutMs: 15_000 });
    // The dialog takes the keyboard within a frame or two.
    const took = await bridge
      .waitFor(`${d.name} to have the keyboard`, `return !!document.activeElement?.closest?.(${JSON.stringify(d.panel)});`, { timeoutMs: 3_000 })
      .then(() => true)
      .catch(() => false);
    const at = await where(bridge, d.panel, sid);
    log(`  keyboard after opening: ${JSON.stringify(at)}`);
    check(took && at.inDialog, `${d.name} has the keyboard when it opens`);
    if (d.first) check(at.selectedTab, `${d.name} starts on its selected tab`);

    const word = `zzleak${i}`;
    await typeLetters(bridge, word);
    await sleep(700);
    check(!(await leaked(word)), `"${word}" typed while ${d.name} is open does not reach the shell behind it`);

    // Tab wraps inside the dialog (the trap moves the keyboard at the ends).
    const wrap = await bridge.eval(`
      const panel = e2e.first(${JSON.stringify(d.panel)});
      const sel = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
      const items = [...panel.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) return { count: 0 };
      const tab = (shift) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: shift, bubbles: true, cancelable: true }));
      items[items.length - 1].focus();
      tab(false);
      const afterTab = document.activeElement === items[0];
      items[0].focus();
      tab(true);
      const afterShiftTab = document.activeElement === items[items.length - 1];
      return { count: items.length, afterTab, afterShiftTab, inside: panel.contains(document.activeElement) };
    `);
    log(`  Tab at the ends: ${JSON.stringify(wrap)}`);
    check(wrap.count > 0 && wrap.afterTab && wrap.afterShiftTab && wrap.inside, `Tab and Shift+Tab stay inside ${d.name}`);

    // The terminal behind cannot take the keyboard back (xterm refocuses itself).
    await bridge.eval(`
      window.__HERMES_E2E__.focusTerminal(${JSON.stringify(sid)});
      document.querySelector('[data-session-id=${JSON.stringify(sid)}] .xterm-helper-textarea')?.focus();
      return true;
    `);
    await sleep(300);
    const stays = await where(bridge, d.panel, sid);
    check(stays.inDialog && !stays.inTerminal, `the terminal cannot take the keyboard while ${d.name} is open (${stays.el})`);
    await bridge.screenshot(join(evidenceDir, `0${i + 1}-${d.action}.png`));

    await press(bridge, { key: "Escape", code: "Escape", keyCode: 27 });
    const closed = await bridge
      .waitFor(`${d.name} to close`, `return !e2e.first(${JSON.stringify(d.panel)});`, { timeoutMs: 3_000 })
      .then(() => true)
      .catch(() => false);
    check(closed, `Esc closes ${d.name}`);
    if (closed) {
      const back = await bridge
        .waitFor("the keyboard back in the terminal", `const a = document.activeElement; return !!a?.closest?.(".xterm") && a.closest("[data-session-id]")?.dataset.sessionId === ${JSON.stringify(sid)};`, { timeoutMs: 3_000 })
        .then(() => true)
        .catch(() => false);
      check(back, `after ${d.name} closes, the keyboard is back in the terminal it came from`);
    } else {
      await bridge.eval(`e2e.first(".settings-close, .shortcuts-close, .cost-dashboard-close")?.click(); return true;`);
      await sleep(300);
    }
  }

  // Esc never reached the shell either (it would have cleared the line or
  // been echoed); every typed word stayed out of it.
  const lines = (await bridge.readTerminal(sid)) ?? [];
  check(!lines.some((l) => l.includes("zzleak")), "nothing typed while a dialog was open reached the shell");
  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
});
