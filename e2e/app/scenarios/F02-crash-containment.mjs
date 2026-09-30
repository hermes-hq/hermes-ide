#!/usr/bin/env node
// Scenario F02: a crash stays inside its pane, and the app starts lean.
//
// A user has two terminals side by side. Something inside the left pane
// crashes while drawing (forced with the test-only crash switch). The left
// pane shows an error card with Reload / Close; the right pane keeps
// working — it still runs commands. Reload brings the left pane back with
// its shell and scrollback intact.
//
// Also checked on the real app:
//   - views nobody has opened yet (Agent view, Settings, plugin manager,
//     code editor, "What's new", other languages) are not loaded at startup;
//     on first launch the version is still recorded as seen
//   - Settings, the plugin manager and a language pack load when opened,
//     and switching to German fetches only the German pack
//   - the Claude agent bridge is not warmed at startup for terminal-only
//     use; the warm-up request runs once per app run
//   - with the interface in German, the error card is in German
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F02-crash-containment.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F02-crash-containment.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F02-crash-containment";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// Views whose code must NOT be fetched at startup (they load when first used).
const ON_DEMAND_VIEWS = [
  "SessionComposer",
  "WorkbenchPanel",
  "AgentSessionView",
  "Settings",
  "PluginManager",
  "EditorPane",
  "FilePreviewPanel",
  "SessionCreator",
  "CommandPalette",
  "ContextPanel",
  "WhatsNewDialog",
];
const LANGUAGES = ["de", "fr", "es", "ru", "ja", "hi", "pt-BR", "zh-CN"];

/** On-demand views whose code the app has fetched so far. */
const loadedViews = (bridge) => bridge.eval(`return window.__HERMES_E2E__.loadedViews();`);
/** Languages whose translations are in memory. */
const loadedLanguages = (bridge) => bridge.eval(`return window.__HERMES_E2E__.loadedLanguages();`);

async function passOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`, { timeoutMs: 20_000 });
  for (let i = 0; i < 3; i++) {
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return true;
  `);
  await bridge.waitFor("the Finish button", `
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
}

/** Walk the already-open New Session wizard to a plain shell; returns the new session id. */
async function finishPlainShellWizard(bridge) {
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await bridge.waitFor("plain shell selected", `
    const cards = e2e.all(".session-creator-provider-card");
    return cards[cards.length - 1].classList.contains("selected");
  `);
  const before = await bridge.terminalIds();
  for (let i = 0; i < 6; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      ));
    `);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const id = await bridge.waitFor(
    "a new terminal",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  await bridge.waitFor("the shell prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1000);
  return id;
}

async function runInTerminal(bridge, sessionId, marker) {
  await bridge.typeInTerminal(sessionId, `echo ${marker}\n`);
  await bridge.waitForTerminal(sessionId, new RegExp(`^${marker}$`), { timeoutMs: 20_000 });
}

/** Where each session's pane is, and what it shows. */
function paneState(bridge) {
  return bridge.eval(`
    return e2e.all(".split-pane").map((pane) => ({
      terminal: pane.querySelector("div[data-session-id]")?.getAttribute("data-session-id") ?? null,
      errorCard: pane.querySelector('[data-error-scope="pane"]') ? e2e.norm(pane.querySelector('[data-error-scope="pane"]').innerText) : null,
      label: e2e.norm(pane.querySelector(".split-pane-label span")?.innerText ?? ""),
    }));
  `);
}

async function shot(bridge, name) {
  const saved = await bridge.screenshot(join(evidenceDir, name));
  log(`  screenshot saved: ${saved.file} (${saved.bytes} bytes)`);
}

let app;
let failed = false;

try {
  log(`scenario: F02-crash-containment   platform: ${platform()}`);

  // ── 1. Launch: nothing optional is loaded ─────────────────────────
  log("step 1: launch the test app (first launch, throwaway home folder)");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log, home: process.env.HERMES_E2E_HOME || undefined });
  const { bridge } = app;
  await sleep(1500); // let startup settle (plugins, settings reads)
  const startupViews = await loadedViews(bridge);
  const startupLanguages = await loadedLanguages(bridge);
  log(`  views loaded at startup: [${startupViews.join(", ")}]; languages in memory: [${startupLanguages.join(", ")}]`);
  for (const name of ON_DEMAND_VIEWS) {
    assert(!startupViews.includes(name), `"${name}" is not loaded at startup`);
  }
  assert(startupLanguages.join(",") === "en", "only English is in memory at startup");
  const appLog0 = readFileSync(app.appLog, "utf8");
  assert(
    appLog0.includes("[prewarm] agent bridge warm-up deferred until an Agent-view session exists"),
    "the app log says the agent bridge warm-up is deferred",
  );
  assert(!appLog0.includes("warming the agent bridge"), "the agent bridge is not warmed at startup");
  const lastSeen = await bridge.eval(`
    const all = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return all.last_seen_version ?? null;
  `);
  const appVersion = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
  log(`  last_seen_version after first launch: ${lastSeen} (app version ${appVersion})`);
  assert(lastSeen === appVersion, "first launch records this version as seen without loading the What's new dialog");

  // ── 2. Two terminals side by side ────────────────────────────────
  log("step 2: first launch welcome, then two plain terminals side by side");
  await passOnboarding(bridge);
  await bridge.click("button.es-tile-primary");
  const first = await finishPlainShellWizard(bridge);
  log(`  first terminal: ${first}`);
  assert((await loadedViews(bridge)).includes("SessionCreator"), "the New Session wizard loaded when opened");
  assert(!(await loadedViews(bridge)).includes("AgentSessionView"), "a terminal session does not load the Agent view");

  // Same as View ▸ Split Right in the menu bar (the menu sends this event).
  await bridge.eval(`
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "menu-action",
      payload: { action: "view.split-horizontal" },
    });
    return true;
  `);
  const second = await finishPlainShellWizard(bridge);
  log(`  second terminal: ${second}`);
  const panes = await bridge.waitFor("two panes, one terminal each", `
    const panes = e2e.all(".split-pane").map((p) => p.querySelector("div[data-session-id]")?.getAttribute("data-session-id"));
    return panes.length === 2 && panes[0] && panes[1] && panes[0] !== panes[1] ? panes : null;
  `);
  const [left, right] = panes;
  assert(left === first && right === second, "the first terminal stays on the left, the new one opens on the right");
  log(`  left pane: ${left}; right pane: ${right}`);
  await runInTerminal(bridge, left, "left-before-crash");
  await runInTerminal(bridge, right, "right-before-crash");
  await shot(bridge, "01-two-panes.png");

  // ── 3. Crash the left pane ───────────────────────────────────────
  log("step 3: the left pane crashes while drawing (test-only crash switch)");
  await bridge.eval(`window.__HERMES_E2E__.crash(${JSON.stringify(`pane:${left}`)}); return true;`);
  const crashed = await bridge.waitFor("an error card in the left pane", `
    const card = e2e.first(".split-pane")?.querySelector('[data-error-scope="pane"]');
    return card ? e2e.norm(card.innerText) : null;
  `);
  log(`  left pane now shows: "${crashed}"`);
  assert(crashed.includes("This pane stopped working"), "the left pane shows the pane error card");
  assert(/Reload pane/.test(crashed) && /Close pane/.test(crashed), "the card offers Reload pane and Close pane");
  let state = await paneState(bridge);
  assert(state.length === 2, "both panes are still on screen");
  assert(state[1].errorCard === null && state[1].terminal === right, "the right pane has no error and still shows its terminal");
  assert((await bridge.eval(`return e2e.all(".session-item").length;`)) === 2, "the session list still shows both sessions");
  assert((await bridge.terminalIds()).includes(left), "the left session's shell is still running behind the card");
  assert(!(await bridge.exists(".contained-error-app")), "the window itself did not fall over");

  log("step 4: the right pane keeps working");
  await runInTerminal(bridge, right, "right-after-crash");
  assert(true, "the right terminal ran a command after the left pane crashed");
  await sleep(300);
  await shot(bridge, "02-left-pane-crashed-right-pane-working.png");

  // ── 5. Reload the crashed pane ───────────────────────────────────
  log("step 5: press Reload pane in the left pane");
  await bridge.clickWhenReady(`
    const pane = e2e.first(".split-pane");
    return e2e.click(e2e.must(pane.querySelector(".contained-error-reload"), "Reload pane button"));
  `);
  await bridge.waitFor("the left terminal to come back", `
    const pane = e2e.first(".split-pane");
    return !pane.querySelector('[data-error-scope]') && pane.querySelector("div[data-session-id]")?.getAttribute("data-session-id") === ${JSON.stringify(left)};
  `);
  const scrollback = await bridge.readTerminal(left);
  assert(scrollback.some((l) => l === "left-before-crash"), "the left terminal kept its earlier output");
  await runInTerminal(bridge, left, "left-after-reload");
  assert(true, "the left terminal runs commands again after Reload");
  state = await paneState(bridge);
  assert(state.every((p) => p.errorCard === null), "no pane shows an error any more");
  await sleep(300);
  await shot(bridge, "03-left-pane-reloaded.png");

  // ── 5b. Open a file in the code editor ──────────────────────────
  log("step 5b: open a TypeScript file in the editor (editor and grammar load on demand)");
  // A throwaway project folder in the run's private temp folder (the same
  // on every OS, whatever the shell).
  const projectDir = join(app.tmpDir, "proj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "demo.ts"), "const answer = 42\n");
  log(`  project folder: ${projectDir}`);
  const before5b = await loadedViews(bridge);
  assert(!before5b.includes("EditorPane") && !before5b.includes("FileExplorerPanel"), "editor and file explorer not loaded yet");
  // Attach the folder as a project: "+ Add Project" in the left pane, type the path, Scan.
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".split-pane")?.querySelector(".scope-bar-add"), "+ Add Project"));`);
  await bridge.waitFor("the project picker", `return !!e2e.first(".project-picker-footer .project-picker-scan-input");`);
  await bridge.eval(`
    const input = e2e.first(".project-picker-footer .project-picker-scan-input");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(input, ${JSON.stringify(projectDir)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await bridge.clickWhenReady(`
    const scan = e2e.all(".project-picker-footer .project-picker-scan").find((b) => e2e.norm(b.innerText) === "Scan");
    return e2e.click(e2e.must(scan, "Scan button"));
  `);
  await bridge.waitFor("the project to be attached", `
    return !!e2e.first(".project-picker-footer .project-picker-scan-input") && e2e.first(".project-picker-footer .project-picker-scan-input").value === "";
  `);
  await bridge.click(".project-picker-done");
  await bridge.clickWhenReady(`
    const btn = e2e.first('.session-subview-btn[title="Files"]');
    return e2e.click(e2e.must(btn, "Files button"));
  `);
  await bridge.waitFor("demo.ts in the file explorer", `return e2e.all(".file-tree-node").some((n) => n.title.endsWith("demo.ts"));`, {
    timeoutMs: 20_000,
  });
  await bridge.clickWhenReady(`
    const node = e2e.all(".file-tree-node").find((n) => n.title.endsWith("demo.ts"));
    return e2e.click(e2e.must(node, "demo.ts"));
  `);
  const highlighted = await bridge.waitFor("the editor to show the file with TypeScript highlighting", `
    const line = e2e.first(".cm-editor .cm-content .cm-line");
    if (!line || !line.innerText.includes("const answer = 42")) return null;
    const spans = [...line.querySelectorAll("span")].map((s) => s.textContent);
    return spans.includes("const") ? spans : null;
  `, { timeoutMs: 20_000 });
  log(`  highlighted tokens on line 1: ${JSON.stringify(highlighted)}`);
  const after5b = await loadedViews(bridge);
  assert(
    ["FileExplorerPanel", "FilePreviewPanel", "EditorPane"].every((v) => after5b.includes(v)),
    "file explorer, file preview and editor loaded when used",
  );
  assert(true, "the TypeScript grammar loaded and highlighted the keyword");
  await sleep(300);
  await shot(bridge, "03b-editor-highlighting.png");
  await bridge.click(".file-preview-back");
  await bridge.waitFor("the terminals to be back", `return !e2e.first(".file-preview") && e2e.all(".split-pane").length === 2;`);

  // ── 6. Agent bridge warm-up is on request, once ──────────────────
  log("step 6: the agent bridge warm-up runs only when asked, once per run");
  assert(!readFileSync(app.appLog, "utf8").includes("warming the agent bridge"), "still not warmed with terminals only");
  const firstAsk = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("warm_agent_bridge");`);
  const secondAsk = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("warm_agent_bridge");`);
  assert(firstAsk === true && secondAsk === false, "the first request starts the warm-up, the second is a no-op");
  await sleep(300);
  const warmLines = readFileSync(app.appLog, "utf8").split("\n").filter((l) => l.includes("warming the agent bridge"));
  assert(warmLines.length === 1, "the app log shows exactly one warm-up");

  // ── 7. Settings, plugins and one language load on demand ─────────
  log("step 7: open Settings ▸ Plugins and switch the interface to German");
  await bridge.clickWhenReady(`
    const btn = e2e.all(".activity-bar-left .activity-bar-action")
      .find((b) => e2e.norm(b.querySelector(".activity-bar-label")?.textContent) === "Settings");
    return e2e.click(e2e.must(btn, "Settings button"));
  `);
  await bridge.waitFor("the Settings dialog", `return !!e2e.first(".settings-panel");`);
  assert((await loadedViews(bridge)).includes("Settings"), "Settings loaded when opened");
  await bridge.clickWhenReady(`
    const tab = e2e.all(".settings-tab").find((t) => e2e.norm(t.innerText) === "Plugins");
    return e2e.click(e2e.must(tab, "Plugins tab"));
  `);
  await bridge.waitFor("the plugin list", `return e2e.all(".pm-row").length > 0;`, { timeoutMs: 20_000 });
  assert((await loadedViews(bridge)).includes("PluginManager"), "the plugin manager loaded when its tab opened");
  await bridge.clickWhenReady(`
    const row = e2e.all(".pm-row").find((r) => e2e.norm(r.querySelector(".pm-row-name")?.innerText) === "Hermes Language Pack");
    return e2e.click(e2e.must(row, "Hermes Language Pack row"));
  `);
  await bridge.waitFor("the language picker", `return !!e2e.first("#language-pack-locale");`);
  const offered = await bridge.eval(`return [...document.querySelectorAll("#language-pack-locale option")].map((o) => o.value);`);
  log(`  languages offered: ${offered.join(", ")}`);
  assert(offered.includes("de") && offered.includes("ja") && offered.length >= 9, "every language is offered before any is loaded");
  assert((await loadedLanguages(bridge)).join(",") === "en", "no other language is loaded yet");
  await bridge.eval(`
    const select = document.getElementById("language-pack-locale");
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setValue.call(select, "de");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
  const title = await bridge.waitFor("the Settings title in German", `
    const t = e2e.norm(e2e.first(".settings-title")?.innerText);
    return t === "Einstellungen" ? t : null;
  `);
  assert(title === "Einstellungen", "the interface switched to German");
  const afterSwitch = await loadedLanguages(bridge);
  log(`  languages in memory now: [${afterSwitch.join(", ")}]`);
  assert(afterSwitch.includes("de"), "the German pack was fetched");
  assert(!LANGUAGES.filter((l) => l !== "de").some((l) => afterSwitch.includes(l)), "no other language pack was fetched");
  await sleep(300);
  await shot(bridge, "04-settings-in-german.png");

  // ── 8. The error card speaks the interface language ──────────────
  log("step 8: with the interface in German, the right pane crashes");
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings to close", `return !e2e.first(".settings-panel");`);
  await bridge.eval(`window.__HERMES_E2E__.crash(${JSON.stringify(`pane:${right}`)}); return true;`);
  const german = await bridge.waitFor("an error card in the right pane", `
    const card = e2e.all(".split-pane")[1]?.querySelector('[data-error-scope="pane"]');
    return card ? e2e.norm(card.innerText) : null;
  `);
  log(`  right pane now shows: "${german}"`);
  assert(german.includes("Dieses Pane funktioniert nicht mehr"), "the card title is in German");
  assert(/Pane neu laden/.test(german) && /Pane schließen/.test(german), "Reload and Close are in German");
  state = await paneState(bridge);
  assert(state[0].errorCard === null && state[0].terminal === left, "the left pane is unaffected");
  await sleep(300);
  await shot(bridge, "05-right-pane-crashed-in-german.png");
  await bridge.clickWhenReady(`
    const pane = e2e.all(".split-pane")[1];
    return e2e.click(e2e.must(pane.querySelector(".contained-error-reload"), "Pane neu laden button"));
  `);
  await bridge.waitFor("the right terminal to come back", `
    const pane = e2e.all(".split-pane")[1];
    return !pane.querySelector('[data-error-scope]') && pane.querySelector("div[data-session-id]")?.getAttribute("data-session-id") === ${JSON.stringify(right)};
  `);
  await runInTerminal(bridge, right, "right-after-reload");
  assert(true, "the right terminal runs commands again after Reload");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          panes: e2e.all(".split-pane").map((p) => e2e.norm(p.innerText).slice(0, 200)),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
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
    log("step 9: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
