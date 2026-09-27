#!/usr/bin/env node
// Scenario: the keyboard shortcuts the app shows are exactly the ones it has.
//
//   - The Shortcuts panel lists every row generated from the native menu
//     (src-tauri/src/menu/mod.rs) and the app-handled bindings
//     (src/shortcuts/app-shortcuts.json) — compared row by row against what
//     scripts/generate-shortcuts.mjs extracts from those files right now, so a
//     dropped, extra or stale row fails.
//   - An app-handled binding from that list really works: ⌘⇧P / Ctrl+Shift+P
//     toggles the command palette through App.tsx's keydown handler.
//   - The panel and Settings > Shortcuts are localized: after switching the
//     interface language to Português (Brasil), rows read "Nova sessão", etc.
//
// Runs against the REAL app, hands-free.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N23-shortcuts-panel.mjs

import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { MAC_SYMBOLS, PC_SYMBOLS, loadShortcutGroups, renderKeys } from "../../../scripts/generate-shortcuts.mjs";

const SCENARIO = "N23-shortcuts-panel";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
const log = createLogger(logFile);
const MAC = platform() === "darwin";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// What the panel must show on this platform, straight from the sources (the
// menu, src/utils/keymap.json when it exists, and app-shortcuts.json).
const EXPECTED_GROUPS = loadShortcutGroups()
  .map((g) => ({ ...g, shortcuts: g.shortcuts.filter((s) => !s.platform || (s.platform === "macos") === MAC) }))
  .filter((g) => g.shortcuts.length > 0);
const EXPECTED_ROWS = EXPECTED_GROUPS.flatMap((g) =>
  g.shortcuts.map((s) => ({ action: s.label, keys: MAC ? renderKeys(s.keys, MAC_SYMBOLS) : renderKeys(s.pcKeys ?? s.keys, PC_SYMBOLS) })),
);

/** The keys the generated table gives a row on this platform. */
const expectedKeys = (label) => EXPECTED_ROWS.find((r) => r.action === label)?.keys;

/** Dispatch a real keydown on the focused element, as a key press would. */
function pressScript({ key, shift = false, alt = false }) {
  return `
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
      metaKey: ${MAC}, ctrlKey: ${!MAC}, shiftKey: ${shift}, altKey: ${alt},
    }));
    return true;
  `;
}

const READ_PANEL = `
  return {
    groups: e2e.all(".shortcuts-group-label").map((el) => e2e.norm(el.textContent)),
    rows: e2e.all(".shortcuts-row").map((row) => ({
      action: e2e.norm(e2e.first(".shortcuts-action", row)?.textContent),
      keys: e2e.norm(e2e.first(".shortcuts-kbd", row)?.textContent),
    })),
  };
`;

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  log(`  expected from the menu + app-shortcuts.json: ${EXPECTED_ROWS.length} row(s) in ${EXPECTED_GROUPS.length} group(s)`);

  // ── 1. Launch and get through first-launch onboarding ────────────
  log("step 1: launch the test app and dismiss onboarding");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  const { bridge } = app;
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const screen of ["welcome", "theme", "AI tools"]) {
    const clicked = await bridge.click(".onboarding-actions .onboarding-btn-primary");
    log(`  ${screen}: clicked "${clicked.clicked}"`);
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return true;
  `);
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }

  // ── 2. An app-handled shortcut from app-shortcuts.json works ──────
  log(`step 2: press ${MAC ? "⌘⇧P" : "Ctrl+Shift+P"} (declared in app-shortcuts.json, handled by App.tsx)`);
  assert(!(await bridge.exists(".command-palette")), "the command palette starts closed");
  await bridge.eval(pressScript({ key: "P", shift: true, alt: true }));
  await sleep(300);
  assert(!(await bridge.exists(".command-palette")), "with Alt added (not a declared binding) nothing opens");
  await bridge.eval(pressScript({ key: "P", shift: true }));
  await bridge.waitFor("the command palette to open", `return !!e2e.first(".command-palette");`);
  assert(true, "the declared binding opens the command palette");
  await bridge.eval(pressScript({ key: "P", shift: true }));
  await bridge.waitFor("the command palette to close", `return !e2e.first(".command-palette");`);
  assert(true, "pressing it again closes it (it toggles)");

  // ── 3. The Shortcuts panel lists exactly the generated rows ───────
  log("step 3: open the Shortcuts panel from the status bar");
  await bridge.click(".status-shortcuts-btn");
  await bridge.waitFor("the Shortcuts panel", `return !!e2e.first(".shortcuts-panel");`);
  await sleep(300);
  await bridge.screenshot(join(evidenceDir, "01-shortcuts-panel-en.png"));
  let panel = await bridge.eval(READ_PANEL);
  log(`  groups shown: ${panel.groups.join(", ")}`);
  log(`  ${panel.rows.length} row(s): ${JSON.stringify(panel.rows)}`);
  assert(
    JSON.stringify(panel.groups) === JSON.stringify(EXPECTED_GROUPS.map((g) => g.group)),
    `the groups are the menu's, in order: ${EXPECTED_GROUPS.map((g) => g.group).join(", ")}`,
  );
  const diff = (a, b) => a.filter((x) => !b.some((y) => y.action === x.action && y.keys === x.keys));
  const missing = diff(EXPECTED_ROWS, panel.rows);
  const extra = diff(panel.rows, EXPECTED_ROWS);
  assert(missing.length === 0, `no generated row is missing from the panel${missing.length ? `: ${JSON.stringify(missing)}` : ""}`);
  assert(extra.length === 0, `the panel has no row the sources don't define${extra.length ? `: ${JSON.stringify(extra)}` : ""}`);
  assert(JSON.stringify(panel.rows) === JSON.stringify(EXPECTED_ROWS), `all ${EXPECTED_ROWS.length} rows match, in order`);
  const find = (action) => panel.rows.find((r) => r.action === action);
  assert(!!expectedKeys("New Tab") && find("New Tab")?.keys === expectedKeys("New Tab"), `"New Tab" shows ${expectedKeys("New Tab")} (not the stale "Toggle Timeline")`);
  assert(!find("Toggle Timeline"), 'no "Toggle Timeline" row (that feature does not exist)');
  for (const [action, keys] of [
    ["Focus Composer", MAC ? "⌘⇧J" : "Ctrl+Shift+J"],
    ["Workbench", MAC ? "⌘⌥B" : "Ctrl+Alt+B"],
    ["Command Palette (alternate)", MAC ? "⌘⇧P" : "Ctrl+Shift+P"],
    ["Focus Next Pane", MAC ? "⌘⌥→" : "Ctrl+Alt+→"],
    ["Switch to Session 1–9", MAC ? "⌘1-9" : "Ctrl+1-9"],
  ]) {
    assert(find(action)?.keys === keys, `app-handled "${action}" is listed as ${keys}`);
  }
  await bridge.click(".shortcuts-close");
  await bridge.waitFor("the panel to close", `return !e2e.first(".shortcuts-panel");`);

  // ── 4. Switch the interface language to Português (Brasil) ────────
  log("step 4: switch the interface language to pt-BR (Settings > Plugins > Hermes Language Pack)");
  await bridge.eval(pressScript({ key: "P", shift: true }));
  await bridge.waitFor("the command palette", `return !!e2e.first(".command-palette");`);
  await bridge.clickWhenReady(`
    const item = e2e.all(".command-palette-item").find((el) => e2e.norm(e2e.first(".command-palette-label", el)?.textContent) === "Settings");
    return item ? e2e.click(item) : null;
  `);
  await bridge.waitFor("Settings", `return !!e2e.first(".settings-panel");`);
  const tabs = await bridge.eval(`return e2e.all(".settings-tab").map((el) => e2e.norm(el.textContent));`);
  const shortcutsTab = tabs.indexOf("Shortcuts");
  assert(shortcutsTab >= 0 && tabs.includes("Plugins"), `Settings has Plugins and Shortcuts tabs (${tabs.join(", ")})`);
  await bridge.clickWhenReady(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.textContent) === "Plugins");
    return tab ? e2e.click(tab) : null;
  `);
  // Expand the language pack's row until its settings show. The plugin list
  // can re-render while it loads (slow on the Linux runner), collapsing a row
  // expanded too early, so a collapsed row is clicked again.
  await bridge.waitFor("the language picker with pt-BR", `
    const sel = e2e.first("#language-pack-locale");
    if (sel) return [...sel.options].some((o) => o.value === "pt-BR");
    const row = e2e.all(".pm-row").find((el) => e2e.norm(e2e.first(".pm-row-name", el)?.textContent) === "Hermes Language Pack");
    if (row && !row.classList.contains("pm-row-expanded")) e2e.click(row);
    return false;
  `, { timeoutMs: 30_000, intervalMs: 500 });
  log(`  the language pack's settings are open`);
  await bridge.eval(`
    const sel = e2e.first("#language-pack-locale");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "pt-BR");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
  await bridge.waitFor("the UI to switch to pt-BR", `return e2e.first("#language-pack-locale")?.value === "pt-BR";`);

  // ── 5. Settings > Shortcuts is translated ─────────────────────────
  log("step 5: Settings > Shortcuts in pt-BR");
  await bridge.clickWhenReady(`const tab = e2e.all(".settings-tab")[${shortcutsTab}]; return tab ? e2e.click(tab) : null;`);
  await bridge.waitFor("the shortcuts tab", `return e2e.all(".settings-shortcut-row").length > 0;`);
  const settingsRows = await bridge.eval(`return e2e.all(".settings-shortcut-action").map((el) => e2e.norm(el.textContent));`);
  const settingsGroups = await bridge.eval(`return e2e.all(".settings-shortcut-group-label").map((el) => e2e.norm(el.textContent));`);
  log(`  Settings > Shortcuts: groups ${JSON.stringify(settingsGroups)}; rows ${JSON.stringify(settingsRows)}`);
  await bridge.screenshot(join(evidenceDir, "02-settings-shortcuts-pt-BR.png"));
  assert(settingsRows.length === EXPECTED_ROWS.length, `it lists all ${EXPECTED_ROWS.length} rows`);
  assert(settingsRows.includes("Nova sessão") && !settingsRows.includes("New Session"), 'rows are translated ("Nova sessão")');
  assert(settingsGroups.includes("Arquivo") && !settingsGroups.includes("File"), 'group labels are translated ("Arquivo")');
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings to close", `return !e2e.first(".settings-panel");`);

  // ── 6. The Shortcuts panel is translated ──────────────────────────
  log("step 6: the Shortcuts panel in pt-BR");
  await bridge.click(".status-shortcuts-btn");
  await bridge.waitFor("the Shortcuts panel", `return !!e2e.first(".shortcuts-panel");`);
  await sleep(300);
  await bridge.screenshot(join(evidenceDir, "03-shortcuts-panel-pt-BR.png"));
  panel = await bridge.eval(READ_PANEL);
  log(`  groups shown: ${panel.groups.join(", ")}`);
  log(`  rows: ${JSON.stringify(panel.rows)}`);
  const ptFind = (action) => panel.rows.find((r) => r.action === action);
  assert(panel.rows.length === EXPECTED_ROWS.length, `still ${EXPECTED_ROWS.length} rows`);
  assert(ptFind("Nova sessão")?.keys === expectedKeys("New Session"), '"Nova sessão" with its accelerator');
  assert(ptFind("Nova aba")?.keys === expectedKeys("New Tab"), '"Nova aba" (New Tab) with its accelerator');
  assert(ptFind("Focar compositor")?.keys === (MAC ? "⌘⇧J" : "Ctrl+Shift+J"), '"Focar compositor" (app-handled) is translated too');
  assert(panel.groups.includes("Arquivo") && panel.groups.includes("Sessão"), "group labels are translated");
  assert(!panel.rows.some((r) => r.action === "New Session" || r.action.startsWith("shortcuts.")), "no English row and no raw i18n key left");
  assert(
    JSON.stringify(panel.rows.map((r) => r.keys)) === JSON.stringify(EXPECTED_ROWS.map((r) => r.keys)),
    "the keys are unchanged by the language switch",
  );

  // ── 7. Close it ────────────────────────────────────────────────────
  log("step 7: close the panel");
  await bridge.click(".shortcuts-close");
  await bridge.waitFor("the panel to close", `return !e2e.first(".shortcuts-panel");`);
  assert(!(await bridge.exists(".shortcuts-panel")), "the Shortcuts panel is gone");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    // On Windows the test app's webview storage outlives this run (only its
    // data folder is reset), so put the interface language back for the
    // scenarios that run after this one.
    await app.bridge.eval(`localStorage.removeItem("hermes.ui_language"); return true;`).catch(() => {});
  }
  if (app) {
    log("step 8: quit the app");
    const exit = await app.stop();
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
