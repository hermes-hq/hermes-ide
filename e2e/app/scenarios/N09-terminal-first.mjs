#!/usr/bin/env node
// Scenario N09: terminal first, for every agent.
//
//   1. A new Claude session made through the New Session wizard opens Claude's
//      own terminal interface (a fake `claude` on PATH, so no login is needed).
//      The wizard starts on the agent step; there is no separate mode step.
//   2. Ticking "Agent view for Claude" once makes it the preselected choice
//      for Claude the next time the wizard opens.
//   3. A saved Agent-view session restores in the Agent view after the app
//      quits and starts again; the terminal session restores as a terminal.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N09-terminal-first.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N09-terminal-first.
//
// macOS and Linux only (see e2e/acceptance.yml): the fake claude is a POSIX
// shell script.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N09-terminal-first";
const startedAt = Date.now();
const FAKE_BANNER = "FAKE-CLAUDE-TUI ready";
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── Fake `claude` and a home folder that survives a relaunch ────────
if (platform() === "win32") {
  // Not a failure: nothing was tested. No result.json is written, so this
  // run can never count as a pass either.
  log("the fake claude is a POSIX shell script; this scenario runs on macOS and Linux only");
  log("RESULT: SKIP");
  process.exit(0);
}
const work = mkdtempSync(join(tmpdir(), "hermes-e2e-n09-"));
const fakeBin = join(work, "bin");
const home = join(work, "home");
mkdirSync(fakeBin, { recursive: true });
mkdirSync(home, { recursive: true });
const fakeClaude = join(fakeBin, "claude");
writeFileSync(
  fakeClaude,
  [
    "#!/bin/sh",
    "# Stand-in for the Claude CLI: prints a banner, then echoes input like a TUI would.",
    `echo "${FAKE_BANNER} pid=$$ (args: $#)"`,
    "while IFS= read -r line; do echo \"fake claude got: $line\"; done",
    "",
  ].join("\n"),
);
chmodSync(fakeClaude, 0o755);
// Only the fake may answer to `claude`: drop every PATH entry that has a
// real one, and never hand the app an API key.
process.env.PATH = [
  fakeBin,
  ...(process.env.PATH || "").split(delimiter).filter((dir) => dir && !existsSync(join(dir, "claude"))),
].join(delimiter);
for (const name of Object.keys(process.env)) {
  if (name.startsWith("ANTHROPIC_")) delete process.env[name];
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function passOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
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
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
}

async function dismissWhatsNew(bridge) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
    log("  dismissed the what's-new dialog");
  }
}

const CLAUDE_CARD = `e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"))`;
const AGENT_VIEW_BOX = `e2e.first(".session-creator-agent-view input[type=checkbox]")`;
/** Label of the pane that shows the Agent view (null if none is on screen). */
const AGENT_PANE_LABEL = `
  const pane = e2e.all(".split-pane").find((p) => p.querySelector(".agent-session-view"));
  return pane ? pane.querySelector(".split-pane-label span")?.innerText.trim() || null : null;
`;

/** State of the wizard's agent step, as a person sees it. */
function agentStep(bridge) {
  return bridge.eval(`
    const claude = ${CLAUDE_CARD};
    const box = ${AGENT_VIEW_BOX};
    return {
      title: e2e.first(".session-creator-body .session-creator-section-title")?.innerText ?? null,
      modeStep: !!document.querySelector(".session-creator-mode-step, .session-creator-mode-card"),
      providers: e2e.all(".session-creator-provider-card").map((c) => c.innerText.trim().split("\\n")[0]),
      claudeSelected: !!claude && claude.classList.contains("selected"),
      // Cards that look selected (chosen or keyboard-highlighted).
      selectedCards: e2e.all(".session-creator-provider-card.selected").map((c) => c.innerText.trim().split("\\n")[0]),
      claudeNotDetected: !!claude && /not detected/i.test(claude.innerText),
      agentView: box ? { checked: box.checked, label: e2e.nameOf(box.closest("label")) } : null,
    };
  `);
}

/** Press the wizard's primary button until the wizard closes. */
async function finishWizard(bridge) {
  for (let i = 0; i < 6; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    const clicked = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      const b = e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      );
      const step = e2e.first(".session-creator-step")?.innerText ?? "";
      return { step, ...e2e.click(b) };
    `);
    if (clicked) log(`  wizard ${clicked.step}: clicked "${clicked.clicked}"`);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
}

function backendSessions(bridge) {
  return bridge.eval(`
    const list = await window.__TAURI_INTERNALS__.invoke("get_sessions");
    return list.filter((s) => s.phase !== "destroyed").map((s) => ({ id: s.id, label: s.label, ai_provider: s.ai_provider, mode: s.mode }));
  `);
}

async function openWizard(bridge) {
  await bridge.clickWhenReady(`
    const b = e2e.first("button.es-tile-primary") || e2e.first(".activity-bar-action");
    return e2e.click(e2e.must(b, "a New Session button"));
  `);
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
}

// ─── Run ─────────────────────────────────────────────────────────────

let app;
let failed = false;
let terminalSid;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  log(`fake claude: ${fakeClaude}`);

  // ── 1. Claude via the wizard → a terminal session ─────────────────
  log("step 1: launch, then create a Claude session through the New Session wizard");
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir: home });
  let { bridge } = app;
  await passOnboarding(bridge);
  await dismissWhatsNew(bridge);

  await openWizard(bridge);
  let s = await agentStep(bridge);
  log(`  wizard opens on: "${s.title}"; agents offered: ${s.providers.join(", ")}`);
  assert(!s.modeStep, "there is no separate mode step");
  assert(s.title?.toLowerCase() === "what do you want to run?", "the wizard opens on the agent step");
  assert(s.providers.some((p) => p.startsWith("Claude")) && s.providers.includes("Plain shell"), "Claude and Plain shell are offered");
  assert(s.agentView === null, "no Agent view option before an agent is chosen");
  await bridge.screenshot(join(evidenceDir, "01-wizard-agent-step.png"));

  await bridge.clickWhenReady(`return e2e.click(e2e.must(${CLAUDE_CARD}, "the Claude card"));`);
  s = await bridge.waitFor("Claude to be selected", `
    const claude = ${CLAUDE_CARD};
    return claude && claude.classList.contains("selected") && ${AGENT_VIEW_BOX} ? true : null;
  `).then(() => agentStep(bridge));
  assert(!s.claudeNotDetected, "the fake claude on PATH is detected");
  assert(s.agentView && s.agentView.checked === false, `"${s.agentView?.label.split(".")[0]}" is offered and NOT ticked`);
  await bridge.screenshot(join(evidenceDir, "02-wizard-claude-terminal.png"));

  let before = await bridge.terminalIds();
  await finishWizard(bridge);
  terminalSid = await bridge.waitFor(
    "the new session's terminal",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  const { line } = await bridge.waitForTerminal(terminalSid, new RegExp(FAKE_BANNER), { timeoutMs: 45_000 });
  assert(true, `Claude's own interface is running in the terminal: "${line.trim()}"`);
  const sessions = await backendSessions(bridge);
  const t1 = sessions.find((x) => x.id === terminalSid);
  assert(t1 && t1.ai_provider === "claude" && t1.mode === "terminal", `the session is a Claude session in terminal mode (${JSON.stringify(t1)})`);
  assert(!(await bridge.exists(".agent-session-view")), "no Agent view is shown");
  await sleep(300);
  await bridge.screenshot(join(evidenceDir, "03-claude-in-terminal.png"));

  // ── 2. Choose the Agent view once → preselected next time ─────────
  log("step 2: create a second Claude session with 'Agent view for Claude' ticked");
  await openWizard(bridge);
  // The keyboard highlight follows the saved choice one render later, so
  // wait for it to settle; a second card that stays selected still fails.
  s = await bridge.waitFor("Claude to be preselected (last used agent), and only Claude", `
    const claude = ${CLAUDE_CARD};
    const selected = e2e.all(".session-creator-provider-card.selected").length;
    return claude && claude.classList.contains("selected") && selected === 1 && ${AGENT_VIEW_BOX} ? true : null;
  `, { timeoutMs: 10_000 }).catch(() => null).then(() => agentStep(bridge));
  assert(s.claudeSelected && s.agentView?.checked === false, "Claude is preselected, still in terminal mode");
  assert(s.selectedCards.length === 1, `only the Claude card looks selected (${s.selectedCards.join(", ")})`);
  await bridge.clickWhenReady(`return e2e.click(e2e.must(${AGENT_VIEW_BOX}, "the Agent view checkbox"));`);
  await bridge.waitFor("the Agent view box to be ticked", `return ${AGENT_VIEW_BOX}?.checked === true;`);
  await bridge.screenshot(join(evidenceDir, "04-wizard-agent-view-ticked.png"));
  await finishWizard(bridge);
  // Agent-view sessions have no terminal: their pane shows the Agent view.
  const agentLabel = await bridge.waitFor("the Agent view pane of the new session", AGENT_PANE_LABEL, {
    timeoutMs: 20_000,
  });
  assert(agentLabel !== t1.label, `the Agent view pane belongs to the new session "${agentLabel}"`);
  const ptys = await backendSessions(bridge);
  assert(ptys.length === 1 && ptys[0].id === terminalSid, "the new session runs no shell (only the first session has one)");
  assert(
    (await bridge.eval(`return e2e.all(".session-item").length;`)) === 2,
    "the session list shows both sessions",
  );
  await sleep(300);
  await bridge.screenshot(join(evidenceDir, "05-agent-view-session.png"));

  log("  open the wizard a third time");
  await openWizard(bridge);
  s = await bridge.waitFor("Claude to be preselected", `
    const claude = ${CLAUDE_CARD};
    return claude && claude.classList.contains("selected") && ${AGENT_VIEW_BOX} ? true : null;
  `).then(() => agentStep(bridge));
  assert(s.agentView?.checked === true, "'Agent view for Claude' is now preselected for Claude");
  await bridge.screenshot(join(evidenceDir, "06-wizard-remembers-agent-view.png"));
  // Opening the SSH form and going Back keeps that choice.
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".session-creator-ssh-link"), "Connect over SSH"));`);
  await bridge.waitFor("the SSH form", `return !e2e.first(".session-creator-provider-card");`);
  await bridge.clickWhenReady(`
    const back = e2e.all(".session-creator-btn-secondary").find((b) => b.innerText.trim() === "Back");
    return e2e.click(e2e.must(back, "the Back button"));
  `);
  await bridge.waitFor("the agent step again", `return e2e.all(".session-creator-provider-card").length > 0;`);
  s = await agentStep(bridge);
  assert(s.claudeSelected && s.agentView?.checked === true, "Back from the SSH form keeps Claude with the Agent view ticked");
  // Another agent is not affected by Claude's choice.
  await bridge.clickWhenReady(`
    const c = e2e.all(".session-creator-provider-card").find((x) => x.innerText.trim().startsWith("Codex"));
    return e2e.click(e2e.must(c, "the Codex card"));
  `);
  await sleep(200);
  assert((await agentStep(bridge)).agentView === null, "Codex has no Agent view option");
  await bridge.click(".session-creator-header .close-btn");
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`);

  // Let the app's periodic auto-save write the workspace.
  log("  wait for the app to save the workspace");
  const saved = await bridge.waitFor("the workspace to be saved with both sessions", `
    const all = await window.__TAURI_INTERNALS__.invoke("get_settings");
    if (!all.saved_workspace) return null;
    const ws = JSON.parse(all.saved_workspace);
    return ws.sessions.length === 2
      ? ws.sessions.map((x) => ({ id: x.id, label: x.label, ai_provider: x.ai_provider, mode: x.mode ?? null }))
      : null;
  `, { timeoutMs: 40_000, intervalMs: 500 });
  log(`  saved workspace: ${JSON.stringify(saved)}`);
  const savedAgent = saved.find((x) => x.label === agentLabel);
  const savedTerm = saved.find((x) => x.id === terminalSid);
  assert(savedAgent?.mode === "agent" && savedAgent.ai_provider === "claude", "the app saved the second session as a Claude Agent-view session");
  assert(savedTerm?.mode === "terminal" && savedTerm.ai_provider === "claude", "the app saved the first session as a Claude terminal session");
  const prefs = await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_settings")).session_mode_by_provider ?? null;`);
  log(`  stored per-agent choice (session_mode_by_provider): ${prefs}`);
  const exit1 = await app.stop();
  log(`  app exited: ${JSON.stringify(exit1)}`);
  app = null;

  // ── 3. Relaunch → the Agent-view session restores as Agent view ───
  log("step 3: start the app again with the same data and check the restored sessions");
  app = await launchApp({ runDir: join(evidenceDir, "run-2"), log, home: "private", homeDir: home });
  bridge = app.bridge;
  await dismissWhatsNew(bridge);
  await bridge.waitFor("both sessions to be listed", `return e2e.all(".session-item").length === 2;`, {
    timeoutMs: 30_000,
  });
  // The terminal session comes back as a terminal running Claude's own interface.
  const restoredTerm = await bridge.waitFor("the restored terminal session", `
    const list = await window.__TAURI_INTERNALS__.invoke("get_sessions");
    const t = list.find((s) => s.phase !== "destroyed" && s.label === ${JSON.stringify(savedTerm.label)});
    return t ? { id: t.id, ai_provider: t.ai_provider, mode: t.mode } : null;
  `, { timeoutMs: 20_000 });
  assert(restoredTerm.mode === "terminal" && restoredTerm.ai_provider === "claude", `"${savedTerm.label}" restored as a Claude terminal session`);
  // A fresh start of the fake prints a new pid; the old line may be in the restored scrollback.
  const { line: again } = await bridge.waitForTerminal(
    restoredTerm.id,
    new RegExp(`${FAKE_BANNER} pid=(?!${line.match(/pid=(\d+)/)[1]}\\b)`),
    { timeoutMs: 45_000 },
  );
  log(`  new start: "${again.trim()}"`);
  assert(true, `"${savedTerm.label}" runs Claude's own interface again`);
  // The Agent-view session comes back in the Agent view.
  await bridge.clickWhenReady(`
    const items = e2e.all(".session-item");
    const target = items.find((el) => el.innerText.includes(${JSON.stringify(savedAgent.label)})) || null;
    return e2e.click(e2e.must(target, "the restored Agent-view session in the list"));
  `);
  const restoredAgentLabel = await bridge.waitFor("the restored Agent view pane", AGENT_PANE_LABEL, { timeoutMs: 20_000 });
  assert(restoredAgentLabel === savedAgent.label, `"${savedAgent.label}" restored in the Agent view`);
  const ptysAfter = await backendSessions(bridge);
  assert(ptysAfter.length === 1 && ptysAfter[0].id === restoredTerm.id, "only the terminal session runs a shell after the restore");
  await sleep(300);
  await bridge.screenshot(join(evidenceDir, "07-restored-agent-view.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          sessions: (await window.__TAURI_INTERNALS__.invoke("get_sessions")).map((s) => ({ id: s.id, phase: s.phase, mode: s.mode, ai: s.ai_provider })),
          dialogs: [...document.querySelectorAll('[class*="backdrop"],[class*="overlay"]')].map((e) => e.className),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app) {
    log("quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
