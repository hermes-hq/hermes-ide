#!/usr/bin/env node
// Scenario QA-chrome-panels: what the Search and Usage panels say when they
// have nothing to show, on the REAL app with a fake `claude` and a
// throwaway repository. No real account.
//
//   1. NEWCOMER-11 / CHAOS-16 Search: with no session, "Open a session to
//      search its files."; with a shell that has no project, "This session
//      has no project. Add one to search its files." with Add project… and
//      the field off; once the project is added the field works and finds a
//      word in the repository; opened again for that session it never
//      flashes "no project" nor turns the field off while the projects load,
//      and the field has the keyboard; in German the panel is German.
//   2. NEWCOMER-13 Usage: a plain shell reads "Shell" / "No agent in this
//      session." (never "claude · live"); a Claude task in a terminal reads
//      "Claude Code · terminal" and says how to get usage (Agent view).
//
// Negative control (must end in RESULT: FAIL): a build of main before the
// fix ("Open a session to search" with a session open; "claude · live").
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/QA-chrome-panels.mjs

import { join } from "node:path";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { fakeEnv, invoke, launchWithChoice, onWindows, registryPath, removeWork, setFake, setupFakes } from "../cap-steps.mjs";
import { completeTaskWelcome } from "../launcher-steps.mjs";
import { runScenario } from "../n11-steps.mjs";

const SCENARIO = "QA-chrome-panels";

/** The test app with the real flag defaults; Windows keeps its data under %APPDATA% (a fresh one on the first run). */
function startApp(f, evidenceDir, log, run, { first = false, env = {} } = {}) {
  const common = { runDir: join(evidenceDir, `run-${run}`), log, env: { ...fakeEnv(f), ...env }, flagDefaults: {} };
  return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir: f.home });
}

const menu = (bridge, action) =>
  bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: ${JSON.stringify(action)} } }); return true;`);

const searchState = (bridge) =>
  bridge.eval(`
    const input = e2e.first(".search-panel .search-input");
    return {
      open: !!e2e.first(".search-panel"),
      title: e2e.norm(e2e.first(".search-panel-title")?.innerText ?? ""),
      hint: e2e.norm((e2e.first(".search-no-project > span") || e2e.first(".search-no-session"))?.innerText ?? ""),
      placeholder: input?.placeholder ?? "",
      disabled: !!input?.disabled,
      add: e2e.norm(e2e.first(".search-add-project")?.innerText ?? ""),
    };
  `);

const usageState = (bridge) =>
  bridge.eval(`
    return {
      subtitle: e2e.norm(e2e.first(".usage-panel-subtitle")?.innerText ?? ""),
      body: e2e.norm(e2e.first(".usage-panel .usage-empty-text")?.innerText ?? ""),
    };
  `);

await runScenario(SCENARIO, async ({ evidenceDir, log, apps, onCleanup }) => {
  const f = setupFakes("qa-panels", ["claude"]);
  onCleanup(() => removeWork(f, log));
  const restorePath = registryPath(f, log);
  if (restorePath === null) {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI (the fakes need the registry Path)", log });
  }
  onCleanup(() => restorePath?.());
  setFake(f, "version", "claude", "2.1.300");

  const problems = [];
  const check = (ok, message) => {
    log(`  ${ok ? "ok" : "FAILED"} — ${message}`);
    if (!ok) problems.push(message);
  };

  const app = await startApp(f, evidenceDir, log, 1, { first: true });
  apps.push(app);
  const { bridge } = app;
  const project = await completeTaskWelcome(bridge, f.repo);

  // ─── 1. Search ─────────────────────────────────────────────────────
  log("step 1: Search with no session");
  await menu(bridge, "edit.find");
  await bridge.waitFor("the Search panel", `return !!e2e.first(".search-panel");`);
  await sleep(300);
  let s = await searchState(bridge);
  log(`  ${JSON.stringify(s)}`);
  check(s.hint === "Open a session to search its files.", `no session: "${s.hint}"`);
  check(s.disabled, "the field is off while there is nothing to search");
  await menu(bridge, "edit.find");
  await bridge.waitFor("the Search panel to close", `return !e2e.first(".search-panel");`);

  log("step 1b: a shell with no project");
  const before = await bridge.terminalIds();
  await menu(bridge, "file.new-session-tab");
  const shell = await bridge.waitFor("a shell", `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id)); return ids[0] ?? null;`, { timeoutMs: 30_000 });
  const attached = await invoke(bridge, "get_session_projects", { sessionId: shell }).catch(() => []);
  log(`  shell ${shell}; projects: ${attached.length}`);
  await menu(bridge, "edit.find");
  await bridge.waitFor("the Search panel", `return !!e2e.first(".search-panel");`);
  // While the session's projects are read the panel says nothing (by design,
  // see step 1b2); on a busy runner that takes longer than a fixed pause.
  await bridge.waitFor("the session's projects read (the panel shows its hint)", `return !!e2e.first(".search-no-project");`, { timeoutMs: 10_000 }).catch(() => {});
  s = await searchState(bridge);
  log(`  ${JSON.stringify(s)}`);
  check(s.hint === "This session has no project. Add one to search its files.", `a session without a project says so ("${s.hint}")`);
  check(s.add === "Add project…" && s.disabled, "it offers Add project… and the field is off");
  await bridge.screenshot(join(evidenceDir, "01-search-no-project.png"));
  if (s.add) {
    await bridge.click(".search-add-project");
    const picker = await bridge.waitFor("the project picker", `return !!e2e.first(".project-picker");`, { timeoutMs: 10_000 }).then(() => true).catch(() => false);
    check(picker, "Add project… opens the project picker");
    await bridge.eval(`const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
    await bridge.waitFor("the picker to close", `return !e2e.first(".project-picker");`, { timeoutMs: 5_000 }).catch(async () => {
      await bridge.eval(`e2e.first(".command-palette-overlay")?.click(); return true;`);
    });
  }
  log("  the project added: the panel searches it");
  await invoke(bridge, "attach_session_project", { sessionId: shell, projectId: project.id, role: "primary" });
  const ready = await bridge.waitFor("the field to turn on", `const i = e2e.first(".search-panel .search-input"); return !!i && !i.disabled;`, { timeoutMs: 10_000 }).then(() => true).catch(() => false);
  check(ready, "with a project, the field turns on without reopening the panel");
  if (ready) {
    await bridge.eval(`
      const el = e2e.first(".search-panel .search-input");
      el.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, "qa-panels");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    const summary = await bridge.waitFor("results", `return e2e.norm(e2e.first(".search-summary")?.innerText ?? "").match(/^\\d+ results? in \\d+ files?$/)?.[0] ?? false;`, { timeoutMs: 15_000 }).catch(() => "");
    check(!!summary, `the search finds the word in the repository ("${summary}")`);
  }

  log("step 1b2: Find opened again for the session with a project");
  // While its projects load, the panel must not say "no project" nor turn
  // the field off: Find has the keyboard in the field on every open.
  const opens = [];
  for (let i = 0; i < 3; i++) {
    await menu(bridge, "edit.find");
    await bridge.waitFor("the Search panel to close", `return !e2e.first(".search-panel");`);
    await bridge.eval(`window.__HERMES_E2E__.focusTerminal(${JSON.stringify(shell)}); return true;`);
    await sleep(300);
    await bridge.eval(`
      window.__qaSearch = { noProject: false, disabled: false };
      window.__qaSearchObs?.disconnect();
      const look = () => {
        if (e2e.first(".search-no-project")) window.__qaSearch.noProject = true;
        if (e2e.first(".search-panel .search-input")?.disabled) window.__qaSearch.disabled = true;
      };
      window.__qaSearchObs = new MutationObserver(look);
      window.__qaSearchObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      return true;
    `);
    await menu(bridge, "edit.find");
    await bridge.waitFor("the Search panel", `return !!e2e.first(".search-panel");`);
    await sleep(1000);
    const r = await bridge.eval(`
      window.__qaSearchObs.disconnect();
      const input = e2e.first(".search-panel .search-input");
      return { ...window.__qaSearch, focused: !!input && document.activeElement === input, disabledNow: !!input?.disabled };
    `);
    log(`  open #${i + 1}: ${JSON.stringify(r)}`);
    opens.push(r);
  }
  check(opens.every((r) => !r.noProject), `"no project" never shows for a session that has one (${opens.filter((r) => r.noProject).length}/${opens.length} opens showed it)`);
  check(opens.every((r) => !r.disabled && !r.disabledNow), `the field is never off while the projects load (${opens.filter((r) => r.disabled).length}/${opens.length} opens turned it off)`);
  check(opens.every((r) => r.focused), `Find puts the keyboard in the field on every open (${opens.filter((r) => !r.focused).length}/${opens.length} did not)`);

  log("step 1c: in German");
  await invoke(bridge, "set_setting", { key: "ui_language", value: "de" });
  await bridge.eval(`localStorage.setItem("hermes.ui_language", "de"); return true;`);
  await invoke(bridge, "detach_session_project", { sessionId: shell, projectId: project.id }).catch(() => {});
  await bridge.reload();
  await sleep(2500);
  if (!(await bridge.exists(".search-panel"))) await menu(bridge, "edit.find");
  await bridge.waitFor("the Search panel", `return !!e2e.first(".search-panel");`);
  await bridge.waitFor("the panel's hint", `return !!e2e.first(".search-no-project, .search-no-session");`, { timeoutMs: 10_000 }).catch(() => {});
  s = await searchState(bridge);
  log(`  German: ${JSON.stringify(s)}`);
  check(s.title.toLowerCase() === "suche" && s.placeholder === "Dateien durchsuchen…", "the panel's title and field are German");
  check(s.hint === "Diese Sitzung hat kein Projekt. Füge eines hinzu, um seine Dateien zu durchsuchen." || s.hint === "Öffne eine Sitzung, um ihre Dateien zu durchsuchen.", `its hint is German ("${s.hint}")`);
  await bridge.screenshot(join(evidenceDir, "02-search-de.png"));
  await invoke(bridge, "set_setting", { key: "ui_language", value: "en" });
  await bridge.eval(`localStorage.setItem("hermes.ui_language", "en"); return true;`);
  await bridge.reload();
  await sleep(2500);
  if (await bridge.exists(".search-panel")) await menu(bridge, "edit.find");

  // ─── 2. Usage ──────────────────────────────────────────────────────
  log("step 2: Usage for a plain shell");
  await bridge.clickByName("Usage · plan & limits");
  await bridge.waitFor("the Usage panel", `return !!e2e.first(".usage-panel-subtitle");`);
  await sleep(400);
  let u = await usageState(bridge);
  log(`  shell: ${JSON.stringify(u)}`);
  check(u.subtitle === "Shell", `a plain shell is not "claude · live" ("${u.subtitle}")`);
  check(u.body === "No agent in this session.", `and says there is no agent ("${u.body}")`);
  await bridge.screenshot(join(evidenceDir, "03-usage-shell.png"));

  log("step 2b: Usage for a Claude task in a terminal");
  await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "usage check" });
  await bridge.waitFor("the Claude task selected", `return e2e.norm(e2e.first(".usage-panel-subtitle")?.innerText ?? "").startsWith("Claude Code");`, { timeoutMs: 20_000 }).catch(() => {});
  u = await usageState(bridge);
  log(`  claude: ${JSON.stringify(u)}`);
  check(u.subtitle === "Claude Code · terminal", `the subtitle names the agent and where it runs ("${u.subtitle}")`);
  check(u.body === "Plan usage and limits show for tasks that run in Agent view. This task runs in a terminal. Start the next task with + options › Runs in › Agent view.", `it says how to get usage ("${u.body}")`);
  check(!/agent-mode/.test(u.body), "no \"agent-mode\" jargon");
  await bridge.screenshot(join(evidenceDir, "04-usage-claude.png"));

  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
});
