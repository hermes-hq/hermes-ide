#!/usr/bin/env node
// Scenario: a first-time user opens Hermes, starts a plain terminal, runs a
// command, sees its output, and closes the terminal.
//
// Runs against the REAL app, hands-free. Never needs the window to be focused
// or in front; the screenshots are rendered by the app's own webview.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/terminal-echo.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/terminal-echo. HERMES_E2E_HOME=real runs with the real
// home folder instead of a throwaway one.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { platform } from "node:os";
import { basename, join } from "node:path";
import { appBinaryPath, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "terminal-echo";
/**
 * How macOS names the test app: the un-bundled binary is reported by its
 * file name ("hermes-ide-e2e"); a bundled build would carry its productName
 * from src-tauri/tauri.e2e.conf.json.
 */
const TEST_APP_NAMES = new Set([basename(appBinaryPath(), ".exe"), "Hermes IDE E2E"]);
const startedAt = Date.now();
const MARKER = "hermes-e2e-ok";
// What the terminal is expected to print. Override it to prove the check can
// fail (HERMES_E2E_EXPECT=something-else must end in RESULT: FAIL).
const EXPECT = process.env.HERMES_E2E_EXPECT || MARKER;
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

/** Name of the app that has keyboard focus right now (macOS, read-only). */
function frontmostApp() {
  if (platform() !== "darwin") return "(not checked on this OS)";
  const asn = spawnSync("lsappinfo", ["front"], { encoding: "utf8" }).stdout.trim();
  const out = spawnSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf8" }).stdout;
  return /"LSDisplayName"="([^"]*)"/.exec(out)?.[1] ?? "(unknown)";
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

let app;
let failed = false;
const focusBefore = frontmostApp();

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   app with focus before launch: "${focusBefore}"`);

  // ── 1. Launch ────────────────────────────────────────────────────
  log("step 1: launch the test app with a clean, first-launch data folder");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log, home: process.env.HERMES_E2E_HOME || undefined });
  const { bridge } = app;
  const win = await bridge.windowInfo();
  log(`  window "${win.title}" ${win.width}x${win.height}, focused=${win.focused}, window id=${win.cgWindowId}`);
  const page = await bridge.eval(`return { visibility: document.visibilityState, hasFocus: document.hasFocus() };`);
  log(`  page visibility=${page.visibility}, page has keyboard focus=${page.hasFocus}`);

  // ── 2. First-launch welcome ──────────────────────────────────────
  log("step 2: go through the first-launch welcome screens");
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  await bridge.screenshot(join(evidenceDir, "01-welcome.png"));
  for (const screen of ["welcome", "theme", "AI tools"]) {
    const clicked = await bridge.click(".onboarding-actions .onboarding-btn-primary");
    log(`  ${screen}: clicked "${clicked.clicked}"`);
    await sleep(150);
  }
  // Privacy screen: say no to usage analytics (this is a test run), accept the policy.
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  const privacy = await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return { analytics: analytics.checked, policy: policy.checked };
  `);
  assert(privacy.analytics === false && privacy.policy === true, "analytics switched off, policy accepted");
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  // A "what's new" dialog may follow on some versions — dismiss it like a user would.
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
    log("  dismissed the what's-new dialog");
  }
  assert((await bridge.eval(`return e2e.all(".session-item").length;`)) === 0, "session list starts empty");

  // ── 3. Create a plain terminal through the UI ────────────────────
  log("step 3: create a plain terminal session through the New Session wizard");
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });

  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  const providers = await bridge.eval(`return e2e.all(".session-creator-provider-card").map(e2e.nameOf);`);
  log(`  agent picker offers: ${providers.map((p) => JSON.stringify(p.split(" ")[0])).join(", ")}`);
  // "Plain shell" is always the last card.
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await bridge.waitFor("plain shell to be selected", `
    const cards = e2e.all(".session-creator-provider-card");
    return cards[cards.length - 1].classList.contains("selected");
  `);
  await bridge.screenshot(join(evidenceDir, "02-wizard-plain-shell.png"));

  // Walk the remaining wizard screens with the primary button until the
  // session exists. Folder step: nothing selected = the default folder.
  const before = await bridge.terminalIds();
  for (let i = 0; i < 6; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    const clicked = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null; // wizard already closed
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

  const sessionId = await bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  log(`  session created: ${sessionId}`);
  const listed = await bridge.waitFor("the session to show in the session list", `
    const items = e2e.all(".session-item");
    return items.length === 1 ? { count: 1, text: e2e.norm(items[0].innerText).slice(0, 80) } : null;
  `);
  assert(listed.count === 1, `session list shows exactly one session ("${listed.text}")`);

  // ── 4. Type a command ────────────────────────────────────────────
  log("step 4: wait for the shell prompt, then type a command and press Enter");
  await bridge.waitFor("the shell to print its prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1000); // let the shell finish starting up
  const typed = await bridge.typeInTerminal(sessionId, `echo ${MARKER}\n`);
  log(`  typed ${typed.typed} keys: "echo ${MARKER}" + Enter`);

  // ── 5. Assert on the real output ─────────────────────────────────
  log("step 5: read the terminal and check the command's output");
  const exact = new RegExp(`^${EXPECT}$`);
  const { lines } = await bridge.waitForTerminal(sessionId, exact, { timeoutMs: EXPECT === MARKER ? 20_000 : 5_000 });
  const commandLine = lines.find((l) => l.includes(`echo ${MARKER}`));
  assert(!!commandLine, `the typed command is on screen: "${commandLine?.trim()}"`);
  assert(lines.some((l) => exact.test(l)), `the command's output line "${EXPECT}" is on screen`);
  log("  terminal content:");
  for (const l of lines.slice(-8)) log(`    | ${l}`);
  // The picture is taken after the page has painted and is refused when it
  // is a flat colour, so it shows the state asserted above — or fails.
  const shot = await bridge.screenshot(join(evidenceDir, "03-terminal-output.png"));
  log(`  screenshot saved: ${shot.file} (${shot.bytes} bytes, ${shot.width}x${shot.height}, not a flat colour)`);

  // ── 6. Close the session ─────────────────────────────────────────
  log("step 6: close the session from the session list");
  await bridge.click(".session-item .session-item-close");
  await sleep(300);
  if (await bridge.exists(".close-dialog")) {
    const c = await bridge.click(".close-dialog .close-dialog-btn-confirm");
    log(`  confirmation dialog: clicked "${c.clicked}"`);
  }
  await bridge.waitFor("the session to leave the session list", `return e2e.all(".session-item").length === 0;`);
  assert((await bridge.eval(`return e2e.all(".session-item").length;`)) === 0, "session list is empty again");
  await bridge.waitFor("the terminal to be removed", `
    return !window.__HERMES_E2E__.terminalIds().includes(${JSON.stringify(sessionId)});
  `);
  assert(!(await bridge.terminalIds()).includes(sessionId), "the terminal is gone");
  await bridge.screenshot(join(evidenceDir, "04-after-close.png"));

  // ── 7. Focus was never taken ─────────────────────────────────────
  const after = await bridge.windowInfo();
  const focusAfter = frontmostApp();
  log(`step 7: focus check — app with focus is "${focusAfter}" (was "${focusBefore}"), test window focused=${after.focused}`);
  if (platform() === "darwin") {
    assert(after.focused === false, "the test window never had keyboard focus at the end of the run");
    // The person may switch apps or lock the screen while this runs; what
    // must never happen is the test app itself ending up in front.
    assert(!TEST_APP_NAMES.has(focusAfter), `the test app is not the app with focus ("${focusAfter}")`);
  } else {
    // Windows and a bare X display hand focus to the newest window; nobody
    // is typing on those runners, so this is recorded but not asserted.
    log("  (focus is only asserted on macOS)");
  }
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          dialogs: [...document.querySelectorAll('[class*="backdrop"],[class*="overlay"]')].map((e) => e.className),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  // ── 8. Quit ──────────────────────────────────────────────────────
  if (app) {
    log("step 8: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
