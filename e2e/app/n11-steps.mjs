// Shared steps for the N11 scenarios (defect sweep): first-launch welcome,
// creating sessions through the New Session wizard, and a scenario runner
// that captures failure evidence and always quits the app.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep } from "./harness.mjs";

/** Evidence folder + logger + assert for one scenario. */
export function scenarioContext(name) {
  const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", name);
  const logFile = join(evidenceDir, "scenario.log");
  rmSync(logFile, { force: true });
  const log = createLogger(logFile);
  const assert = (condition, message) => {
    if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
    log(`  ok — ${message}`);
  };
  return { evidenceDir, log, assert };
}

/**
 * Run `body(ctx)`; on failure save a screenshot of every app still running.
 * `apps` is filled by the body with each launched app so they can be quit.
 */
export async function runScenario(name, body) {
  const ctx = scenarioContext(name);
  const startedAt = Date.now();
  const apps = [];
  const cleanups = [];
  let failed = false;
  try {
    await body({ ...ctx, apps, onCleanup: (fn) => cleanups.push(fn) });
  } catch (e) {
    failed = true;
    ctx.log(`FAILED: ${e?.stack ?? e}`);
    for (const app of apps) {
      try {
        if (app.isRunning()) await app.bridge.screenshot(join(ctx.evidenceDir, "99-failure.png"));
      } catch (inner) {
        ctx.log(`  (could not capture failure evidence: ${inner.message})`);
      }
    }
  } finally {
    for (const app of apps) {
      if (!app.isRunning()) continue;
      ctx.log("quit the app");
      const exit = await app.stop();
      ctx.log(`  app exited: ${JSON.stringify(exit)}`);
      if (!failed && (exit.forced || exit.code !== 0)) {
        failed = true;
        ctx.log("FAILED: the app did not quit cleanly");
      }
    }
    for (const fn of cleanups) {
      try {
        fn();
      } catch (e) {
        ctx.log(`  (cleanup failed: ${e.message})`);
      }
    }
  }
  // Writes result.json (read by run.mjs and the acceptance gate) and exits.
  finishScenario({ scenario: name, evidenceDir: ctx.evidenceDir, failed, startedAt, log: ctx.log });
}

/**
 * Walk the first-launch welcome screens like a new user. `onAiStep` runs
 * just before the AI tools screen is opened.
 */
export async function completeOnboarding(bridge, log, { onAiStep, onAiScreen } = {}) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const screen of ["welcome", "theme"]) {
    // The AI tools screen checks for installed tools as soon as it opens.
    if (screen === "theme" && onAiStep) await onAiStep();
    const clicked = await bridge.click(".onboarding-actions .onboarding-btn-primary");
    log(`  ${screen}: clicked "${clicked.clicked}"`);
    await sleep(150);
  }
  if (onAiScreen) await onAiScreen();
  const clicked = await bridge.click(".onboarding-actions .onboarding-btn-primary");
  log(`  AI tools: clicked "${clicked.clicked}"`);
  await sleep(150);
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
  await dismissWhatsNew(bridge, log);
}

export async function dismissWhatsNew(bridge, log) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
    log("  dismissed the what's-new dialog");
  }
}

/** Open the New Session wizard from the empty state or the session list. */
export async function openWizard(bridge) {
  if (await bridge.exists("button.es-tile-primary")) {
    await bridge.click("button.es-tile-primary");
  } else {
    // The "+" (New Session) button at the top of the left activity bar.
    await bridge.click(".activity-bar-left > .activity-bar-action");
  }
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
}

/** Click the wizard's primary button until it closes. */
export async function finishWizard(bridge, log) {
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

/** Create a plain terminal session; returns its id once the shell prompts. */
export async function createPlainTerminal(bridge, log) {
  await openWizard(bridge);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  const before = await bridge.terminalIds();
  await finishWizard(bridge, log);
  const sessionId = await bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  await bridge.waitFor("the shell to print its prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1000); // let the shell finish starting up
  log(`  terminal session ready: ${sessionId}`);
  return sessionId;
}

/** Create an Agent-view session: pick Claude, then tick "Agent view for Claude". */
export async function createAgentSession(bridge, log) {
  await openWizard(bridge);
  const claudeCard = `e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"))`;
  const agentViewBox = `e2e.first(".session-creator-agent-view input[type=checkbox]")`;
  await bridge.clickWhenReady(`return e2e.click(e2e.must(${claudeCard}, "the Claude card"));`);
  await bridge.waitFor("the Agent view option", `return !!${agentViewBox};`);
  if (!(await bridge.eval(`return ${agentViewBox}.checked;`))) {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(${agentViewBox}, "the Agent view checkbox"));`);
  }
  await bridge.waitFor("the Agent view box to be ticked", `return ${agentViewBox}?.checked === true;`);
  const before = await bridge.eval(`return e2e.all(".session-item").length;`);
  await finishWizard(bridge, log);
  await bridge.waitFor("the agent session in the session list", `return e2e.all(".session-item").length === ${before + 1};`, {
    timeoutMs: 20_000,
  });
  log("  agent session created");
}

/** Close the main window the way the window's close button does. */
export async function closeWindow(app, log) {
  log("close the app window (saves the workspace, then the app exits)");
  await app.bridge
    .eval(`window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }); return true;`)
    .catch(() => {});
  const until = Date.now() + 15_000;
  while (app.isRunning() && Date.now() < until) await sleep(100);
  return !app.isRunning();
}
