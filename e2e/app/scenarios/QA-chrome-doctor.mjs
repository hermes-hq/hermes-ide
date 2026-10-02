#!/usr/bin/env node
// Scenario QA-chrome-doctor: the agent doctor and Settings' agent tabs, as a
// newcomer meets them, with a fake `claude` (signed out) and a `codex` that
// is installed but cannot start (exit 127, "env: node: No such file or
// directory", as an nvm-installed CLI without node on PATH; on Windows an
// npm-style .cmd shim whose program is not on PATH, which cmd.exe answers
// with "'…' is not recognized as an internal or external command" and exit
// 9009). No real CLI.
//
//   1. ACC-09: the doctor calls Codex installed but failing to start, with
//      its first line, never "signed out", and offers no Sign in for it; the
//      launcher shows no "signed out" block for it either.
//   2. NEWCOMER-08: every Copy install command / Sign in button names its
//      agent for a screen reader.
//   3. NEWCOMER-14: the columns read "Status updates" and "Can resume" and a
//      one-line legend explains them; "Hermes Agent (Nous Research)" is told
//      apart from the app; "Copied" goes back after two seconds.
//   4. NEWCOMER-18: Settings has "Launch defaults" (not "AI Agent" next to
//      "Agents"); Settings > Agents has one "Check again"; the launch
//      prefixes list installed agents, the rest behind "Show all agents".
//
// Negative control (must end in RESULT: FAIL): a build of main before the
// fix.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/QA-chrome-doctor.mjs

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { fakeEnv, registryPath, removeWork, setFake, setupFakes } from "../cap-steps.mjs";
import { completeTaskWelcome, launcherState, onWindows, openLauncher, pickInMenu } from "../launcher-steps.mjs";
import { runScenario } from "../n11-steps.mjs";

const SCENARIO = "QA-chrome-doctor";

/** The test app with the real flag defaults; Windows keeps its data under %APPDATA% (a fresh one on the first run). */
function startApp(f, evidenceDir, log, run, { first = false, env = {} } = {}) {
  const common = { runDir: join(evidenceDir, `run-${run}`), log, env: { ...fakeEnv(f), ...env }, flagDefaults: {} };
  return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir: f.home });
}
// On Windows the shim runs a program that is on no PATH, so the words and
// the exit code are cmd.exe's own, as with an npm shim and no node.
const MISSING_NODE = "hermes-qa-missing-node";
const BROKEN = onWindows
  ? `'${MISSING_NODE}' is not recognized as an internal or external command`
  : "env: node: No such file or directory";

/** A row of the doctor, as a person and a screen reader meet it. */
const doctorRow = (bridge, id) =>
  bridge.eval(`
    const tr = document.querySelector('tr.agent-doctor-row[data-agent-id=${JSON.stringify(id)}]');
    if (!tr) return null;
    const name = (b) => (b.getAttribute("aria-label") || b.innerText || "").replace(/\\s+/g, " ").trim();
    return {
      signedIn: tr.getAttribute("data-signed-in"),
      broken: tr.getAttribute("data-broken"),
      name: e2e.norm(tr.querySelector(".agent-doctor-name")?.childNodes[0]?.textContent ?? ""),
      note: e2e.norm(tr.querySelector(".agent-doctor-broken")?.innerText ?? ""),
      buttons: [...tr.querySelectorAll("button")].map((b) => ({ text: e2e.norm(b.innerText), name: name(b) })),
    };
  `);

await runScenario(SCENARIO, async ({ evidenceDir, log, apps, onCleanup }) => {
  const f = setupFakes("qa-doctor", ["claude", "codex"]);
  onCleanup(() => removeWork(f, log));
  const restorePath = registryPath(f, log);
  if (restorePath === null) {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI (the fakes need the registry Path)", log });
  }
  onCleanup(() => restorePath?.());
  setFake(f, "version", "claude", "2.1.300");
  setFake(f, "auth", "claude", "out");
  // Codex is there but cannot start.
  if (onWindows) {
    writeFileSync(join(f.fakeBin, "codex.cmd"), `@ECHO off\r\n${MISSING_NODE} "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`);
  } else {
    writeFileSync(join(f.fakeBin, "codex"), `#!/bin/sh\necho "${BROKEN}" >&2\nexit 127\n`);
    chmodSync(join(f.fakeBin, "codex"), 0o755);
  }

  const problems = [];
  const check = (ok, message) => {
    log(`  ${ok ? "ok" : "FAILED"} — ${message}`);
    if (!ok) problems.push(message);
  };

  // The real flag defaults: the three-step welcome with the doctor.
  const app = await startApp(f, evidenceDir, log, 1, { first: true });
  apps.push(app);
  const { bridge } = app;
  await bridge.waitFor("the doctor's answer", `return e2e.all("tr.agent-doctor-row[data-agent-id]").length >= 3 && e2e.first(".agent-doctor")?.dataset.loading === "false";`, { timeoutMs: 60_000 });

  // ─── 1. a CLI that cannot start ────────────────────────────────────
  log("step 1: Codex installed but failing to start");
  const codex = await doctorRow(bridge, "codex");
  log(`  codex: ${JSON.stringify(codex)}`);
  check(codex && codex.signedIn !== "no", `Codex is not called signed out (${codex?.signedIn})`);
  check(codex?.note === `Codex is installed but fails to start: ${BROKEN}. Check your PATH or reinstall.`, `the row says it fails to start, in its own words ("${codex?.note}")`);
  check(codex && !codex.buttons.some((b) => b.text === "Sign in"), "no Sign in for a CLI that cannot start");
  await bridge.screenshot(join(evidenceDir, "01-doctor.png"));

  // ─── 2. names for a screen reader ──────────────────────────────────
  log("step 2: every button names its agent");
  const copies = await bridge.eval(`return e2e.all(".setup-dialog .agent-doctor-copy").map((b) => (b.getAttribute("aria-label") || b.innerText).replace(/\\s+/g, " ").trim());`);
  log(`  copy buttons: ${JSON.stringify(copies)}`);
  check(copies.length >= 2 && new Set(copies).size === copies.length, "each Copy install command button has its own name");
  check(copies.every((c) => /^Copy install command for .+/.test(c)), "and names the agent it installs");
  const claude = await doctorRow(bridge, "claude");
  const signIn = claude?.buttons.find((b) => b.text === "Sign in");
  check(signIn?.name === "Sign in to Claude Code", `Sign in names the agent ("${signIn?.name}")`);

  // ─── 3. what the columns mean ──────────────────────────────────────
  log("step 3: the columns are explained");
  const head = await bridge.eval(`
    const ths = e2e.all(".setup-dialog .agent-doctor-table th").map((th) => ({ text: e2e.norm(th.innerText), title: th.title }));
    const legend = e2e.norm(e2e.first(".setup-dialog .agent-doctor-legend")?.innerText ?? "");
    const described = !!e2e.first(".setup-dialog .agent-doctor-table")?.getAttribute("aria-describedby");
    return { ths, legend, described };
  `);
  log(`  ${JSON.stringify(head)}`);
  const signals = head.ths.find((t) => t.text.toLowerCase() === "status updates");
  const resume = head.ths.find((t) => t.text.toLowerCase() === "can resume");
  check(!!signals && /Exact = the agent tells Hermes when it needs you/.test(signals.title), "\"Status updates\" says what Exact, Notifications and None mean");
  check(!!resume && /reopen the conversation after a restart/.test(resume.title), "\"Can resume\" says what it means");
  check(/Status updates: Exact = .+ None = Hermes guesses from the screen\. Can resume: reopen the conversation after a restart\./.test(head.legend) && head.described, "a one-line legend under the table, linked to it");
  const hermes = await doctorRow(bridge, "hermes-agent");
  check(hermes?.name === "Hermes Agent (Nous Research)", `Nous Research's agent is told apart from Hermes ("${hermes?.name}")`);
  const copied = await bridge.eval(`
    const b = e2e.first('.setup-dialog tr.agent-doctor-row[data-agent-id="hermes-agent"] .agent-doctor-copy') || e2e.first(".setup-dialog .agent-doctor-copy");
    const id = b.closest("tr").dataset.agentId;
    e2e.click(b);
    await new Promise((r) => setTimeout(r, 400));
    const now = e2e.first('.setup-dialog tr.agent-doctor-row[data-agent-id="' + id + '"] .agent-doctor-copy');
    return { id, text: e2e.norm(now?.innerText ?? "") };
  `);
  log(`  after Copy: ${JSON.stringify(copied)}`);
  if (copied.text === "Copied") {
    await sleep(2_600);
    const later = await bridge.eval(`return e2e.norm(e2e.first('.setup-dialog tr.agent-doctor-row[data-agent-id="${copied.id}"] .agent-doctor-copy')?.innerText ?? "");`);
    check(later === "Copy install command", `"Copied" goes back after two seconds ("${later}")`);
  } else {
    log("  (the webview refused the clipboard here; the reset is covered by the unit test)");
  }

  // ─── 1b. the launcher ──────────────────────────────────────────────
  await completeTaskWelcome(bridge, f.repo);
  log("step 1b: the launcher does not offer Sign in for Codex");
  await openLauncher(bridge);
  await pickInMenu(bridge, "agent", '[data-agent-id="codex"]');
  await sleep(1500);
  const st = await launcherState(bridge);
  log(`  launcher blocks: ${JSON.stringify(st.blocks)}`);
  check(!st.blocks.some((b) => b.kind === "signed-out"), "no \"signed out\" block for a CLI that cannot start");
  await bridge.screenshot(join(evidenceDir, "02-launcher-codex.png"));
  await bridge.eval(`e2e.first(".task-launcher-close")?.click(); return true;`);
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 10_000 }).catch(() => {});

  // ─── 4. Settings' agent tabs ───────────────────────────────────────
  log("step 4: Settings' agent tabs");
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "hermes.settings" } }); return true;`);
  await bridge.waitFor("Settings", `return !!e2e.first('[role="dialog"] .settings-title');`);
  const tabs = await bridge.eval(`return e2e.all(".settings-tab").map((b) => e2e.norm(b.innerText));`);
  log(`  tabs: ${JSON.stringify(tabs)}`);
  check(tabs.includes("Launch defaults") && !tabs.includes("AI Agent") && tabs.includes("Agents"), "\"Launch defaults\" and \"Agents\" read as different things");
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Agents"), "Agents tab"));`);
  await bridge.waitFor("the Agents screen", `return e2e.first(".agents-settings")?.dataset.loading === "false" && !!e2e.first(".settings-agents-doctor tr.agent-doctor-row");`, { timeoutMs: 60_000 });
  const recheck = await bridge.eval(`return e2e.all('[role="dialog"] button').filter((b) => b.offsetParent && e2e.norm(b.innerText) === "Check again").length;`);
  check(recheck === 1, `Settings > Agents has one "Check again" (${recheck})`);
  await bridge.screenshot(join(evidenceDir, "03-settings-agents.png"));

  const prefixTab = tabs.includes("Launch defaults") ? "Launch defaults" : "AI Agent";
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === ${JSON.stringify(prefixTab)}), "the launch defaults tab"));`);
  await bridge.waitFor("the prefix rows", `return e2e.all(".settings-agent-prefix-row").length > 0;`);
  await sleep(500);
  const rows = await bridge.eval(`return { rows: e2e.all(".settings-agent-prefix-row .settings-agent-prefix-label").map((l) => e2e.norm(l.innerText)), more: e2e.norm(e2e.first(".settings-agent-prefix-show-all")?.innerText ?? "") };`);
  log(`  prefix rows: ${JSON.stringify(rows)}`);
  check(rows.rows.length === 2 && rows.rows.includes("Claude Code") && rows.rows.includes("Codex"), "a prefix row per installed agent only");
  check(/^Show all agents \(\d+ more\)$/.test(rows.more), `the others are behind "${rows.more}"`);
  if (rows.more) {
    await bridge.click(".settings-agent-prefix-show-all");
    const all = await bridge.eval(`return e2e.all(".settings-agent-prefix-row").length;`);
    check(all > 2, `Show all agents lists every agent (${all})`);
  }
  await bridge.screenshot(join(evidenceDir, "04-launch-defaults.png"));

  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
});
