#!/usr/bin/env node
// Scenario: UI-audit-fixes — two small defects the UI audit found, on the
// REAL app:
//
//   1. the empty state's masthead shows the running app's version (it read
//      a fixed "v1.1" while the app was 1.4.x)
//   2. the Review Desk of a session whose folder is not a git repository
//      shows the plain "No git repository" empty state, not git's raw
//      "fatal: not a git repository" in red
//
// The session is a plain shell in the default folder of a throwaway home,
// which is not a repository.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_UIFIX_EXPECT_VERSION=0.0.0   expects another version
//   HERMES_E2E_UIFIX_EXPECT_RAW=1            expects the raw git error
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/UI-audit-fixes.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/UI-audit-fixes.

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "UI-audit-fixes";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const EXPECT_RAW = process.env.HERMES_E2E_UIFIX_EXPECT_RAW === "1";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const _screen of ["welcome", "theme", "AI tools"]) {
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
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  const { bridge } = app;
  const health = await bridge.health();
  const version = process.env.HERMES_E2E_UIFIX_EXPECT_VERSION || health.version;
  await completeOnboarding(bridge);

  log("step 1: the empty state names the running version");
  const eyebrow = await bridge.waitFor("the empty state", `return e2e.first(".es-eyebrow")?.innerText || null;`);
  log(`  masthead: "${eyebrow}" (app reports v${health.version})`);
  const shown = await bridge.eval(`return e2e.first(".es-eyebrow-version")?.textContent ?? null;`);
  assert(shown === `v${version}`, `the masthead version is "${shown}" (expected "v${version}")`);
  assert(!/v1\.1(?![.\d])/i.test(eyebrow) || version.startsWith("1.1"), "no fixed \"v1.1\" is left in the masthead");
  await bridge.screenshot(join(evidenceDir, "01-empty-state.png"));

  log("step 2: a plain shell in a folder that is not a repository");
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard or the task launcher", `return !!e2e.first(".session-creator, .task-launcher-sheet");`, { timeoutMs: 20_000 });
  if (await bridge.exists(".task-launcher-sheet")) await bridge.click(".task-launcher-advanced");
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
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
  await bridge.waitFor("the session row", `return e2e.all(".session-item").length === 1;`, { timeoutMs: 20_000 });

  log("step 3: open its Review Desk");
  await bridge.click(".session-item-wrapper-active .session-subview-btn[title='Review Desk']");
  await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`);
  await bridge.waitFor("the desk to finish loading", `return e2e.first(".review-desk")?.getAttribute("data-loading") === "0";`, { timeoutMs: 20_000 });
  await sleep(300);
  const desk = await bridge.eval(`
    const d = e2e.first(".review-desk");
    return {
      repo: d.getAttribute("data-repo") || "",
      empty: e2e.first('.review-desk .review-empty[data-empty="no-repository"]')?.innerText ?? null,
      error: e2e.first(".review-desk .review-error")?.innerText ?? null,
      fatal: /fatal:/i.test(d.innerText),
    };
  `);
  log(`  desk: folder="${desk.repo}" empty="${desk.empty}" error=${JSON.stringify(desk.error)}`);
  // A real folder, so the desk asked git for a diff there and git refused:
  // the path that used to print "fatal: not a git repository".
  assert(desk.repo.length > 0, "the desk reviewed the session's folder (git was asked for its diff)");
  await bridge.screenshot(join(evidenceDir, "02-review-desk-no-repository.png"));
  if (EXPECT_RAW) {
    assert(desk.fatal, "NEGATIVE CONTROL: expected git's raw error text on the desk");
  } else {
    assert(!!desk.empty && /no git repository/i.test(desk.empty), `the desk shows the plain empty state ("${desk.empty}")`);
    assert(desk.error === null, "no error block is shown");
    assert(!desk.fatal, 'no "fatal:" text anywhere on the desk');
  }
} catch (e) {
  failed = true;
  log(`ERROR: ${e.stack || e.message}`);
  if (app) {
    try {
      await app.bridge.screenshot(join(evidenceDir, "zz-failure.png"));
    } catch {
      // no picture
    }
  }
} finally {
  if (app) await app.stop();
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
