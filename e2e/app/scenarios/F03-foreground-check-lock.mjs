#!/usr/bin/env node
// Scenario F03: typing in a terminal stays responsive while Hermes keeps
// checking whether the shell or a program it started owns the terminal.
//
// Hermes asks that question every 300 ms and before each suggestion. On
// Windows the answer comes from a scan of the whole process table, which can
// take a while; keystrokes are written under the same lock the check needs,
// so a check that held the lock during the scan would stall every key.
//
// The test build is started with HERMES_E2E_FOREGROUND_SCAN_MS, which sends
// every check down the process-table path on every OS and makes the scan
// last that long, so a scan held under the lock is plain to see.
//
//   1. Open a plain terminal and wait for the prompt.
//   2. Run the check back to back from two loops (on top of the app's own
//      300 ms poll) and, meanwhile, type a line one key at a time, timing how
//      long each key takes to show up in the terminal.
//   3. The checks were slow and ran over and over (so the scan really ran
//      during the typing), they answered "the shell is at its prompt", and
//      the keys showed up quickly.
//
// Negative control: HERMES_E2E_F03_LOCK_NEGATIVE=1 also sets
// HERMES_E2E_FOREGROUND_SCAN_UNDER_LOCK=1, which spends the same delay while
// holding the lock (what the check did before it was fixed); the run must
// end in RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F03-foreground-check-lock.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F03-foreground-check-lock.

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F03-foreground-check-lock";
const startedAt = Date.now();
const NEGATIVE = process.env.HERMES_E2E_F03_LOCK_NEGATIVE === "1";
// How long each foreground check's scan takes in this run.
const SCAN_MS = 800;
// What the user types (never run: Ctrl-C clears it).
const TYPED_TEXT = "hermeskeepstypingresponsive";
// A key "shows up quickly" well within one scan; a key that waited for a
// scan under the lock takes most of SCAN_MS or more.
const MEDIAN_LIMIT_MS = 250;
const SLOW_KEY_MS = 400;

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const failures = [];
function check(condition, message) {
  if (condition) {
    log(`  ok — ${message}`);
  } else {
    failures.push(message);
    log(`  CHECK FAILED: ${message}`);
  }
}

async function dismissWhatsNew(bridge) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
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
  await bridge.waitFor("the Finish button", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}

async function createPlainTerminal(bridge) {
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  // "Plain shell" is always the last card.
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
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
  return bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

/** A key the way a keyboard sends it (Ctrl-C). */
function ctrlC(bridge, sessionId) {
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const ta = host.querySelector("textarea.xterm-helper-textarea");
    const mk = (type) => {
      const ev = new KeyboardEvent(type, { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true, composed: true, view: window });
      Object.defineProperty(ev, "keyCode", { get: () => 67 });
      Object.defineProperty(ev, "which", { get: () => 67 });
      return ev;
    };
    ta.dispatchEvent(mk("keydown"));
    ta.dispatchEvent(mk("keyup"));
    return true;
  `);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

let app;
let failed = false;
let details = {};

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (must fail)" : ""}`);

  log(`step 1: start the test app with a ${SCAN_MS} ms foreground scan${NEGATIVE ? " spent UNDER the lock" : ""}`);
  app = await launchApp({
    runDir: join(evidenceDir, "run"),
    log,
    env: {
      HERMES_E2E_FOREGROUND_SCAN_MS: String(SCAN_MS),
      ...(NEGATIVE ? { HERMES_E2E_FOREGROUND_SCAN_UNDER_LOCK: "1" } : {}),
    },
  });
  const { bridge } = app;
  await completeOnboarding(bridge);

  log("step 2: open a plain terminal");
  const sessionId = await createPlainTerminal(bridge);
  log(`  session: ${sessionId}`);
  await bridge.waitFor("the shell to print its prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1500); // let the shell finish starting up
  if (platform() === "win32") {
    // PowerShell writes its history prediction into the line after the
    // cursor ("h" shows "hi run …" from an earlier scenario's launch), so
    // the typed text is never at the end of the line. Turn it off.
    await bridge.typeInTerminal(sessionId, "Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue; Clear-Host\r");
    await sleep(2000);
  }

  log("step 3: run the foreground check back to back while typing, one key at a time");
  await bridge.eval(`
    const id = ${JSON.stringify(sessionId)};
    const st = { checks: [], errors: [], running: true };
    window.__f03FgLoad = st;
    const loop = async () => {
      while (st.running) {
        const t0 = performance.now();
        try {
          const answer = await window.__TAURI_INTERNALS__.invoke("is_shell_foreground", { sessionId: id });
          st.checks.push({ ms: Math.round(performance.now() - t0), answer, endedAt: performance.now() });
        } catch (e) {
          st.errors.push(String(e));
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    };
    loop();
    loop();
    return true;
  `);
  // Let the checks get going: at least one has to be in flight.
  await sleep(SCAN_MS + 200);

  const typing = await bridge.eval(`
    const id = ${JSON.stringify(sessionId)};
    const text = ${JSON.stringify(TYPED_TEXT)};
    const shows = (prefix) => (window.__HERMES_E2E__.readTerminal(id) || []).some((l) => l.trimEnd().endsWith(prefix));
    const keys = [];
    const t0 = performance.now();
    for (let i = 0; i < text.length; i++) {
      const prefix = text.slice(0, i + 1);
      const sent = performance.now();
      await e2e.typeInTerminal(id, text[i]);
      let ms = null;
      while (performance.now() - sent < 10000) {
        if (shows(prefix)) { ms = Math.round(performance.now() - sent); break; }
        await new Promise((r) => setTimeout(r, 2));
      }
      keys.push(ms);
      if (ms === null) break;
      // About as fast as a person types; the typing spans several scans.
      await new Promise((r) => setTimeout(r, 150));
    }
    return { keys, startedAt: t0, endedAt: performance.now() };
  `, { timeoutMs: 15_000 * TYPED_TEXT.length });

  const load = await bridge.eval(`
    const st = window.__f03FgLoad;
    st.running = false;
    return { checks: st.checks, errors: st.errors };
  `);
  const lines = (await bridge.readTerminal(sessionId)) ?? [];
  log("  terminal:");
  for (const l of lines.slice(-3)) log(`    | ${l}`);
  await bridge.screenshot(join(evidenceDir, "01-typed-during-checks.png"));

  const during = load.checks.filter((c) => c.endedAt > typing.startedAt && c.endedAt - c.ms < typing.endedAt);
  const keyMs = typing.keys.filter((k) => k !== null);
  const slowKeys = keyMs.filter((k) => k > SLOW_KEY_MS);
  details = {
    scanMs: SCAN_MS,
    keyEchoMs: typing.keys,
    keyEchoMedianMs: median(keyMs),
    typingMs: Math.round(typing.endedAt - typing.startedAt),
    checksDuringTyping: during.length,
    checkMs: during.map((c) => c.ms),
    checkAnswers: [...new Set(during.map((c) => c.answer))],
    checkErrors: load.errors.slice(0, 3),
  };
  log(`  key echo (ms): ${JSON.stringify(typing.keys)}`);
  log(`  key echo median: ${details.keyEchoMedianMs} ms; keys over ${SLOW_KEY_MS} ms: ${slowKeys.length}`);
  log(`  foreground checks that overlapped the typing: ${during.length}, took (ms): ${JSON.stringify(details.checkMs)}`);
  log(`  their answers: ${JSON.stringify(details.checkAnswers)}; errors: ${JSON.stringify(details.checkErrors)}`);

  assert(load.errors.length === 0, "the foreground checks answered without errors");
  assert(keyMs.length === TYPED_TEXT.length, `every key showed up in the terminal (${keyMs.length}/${TYPED_TEXT.length})`);
  // The slow scan really ran, over and over, while the user typed.
  assert(during.length >= 4, `the foreground check ran repeatedly during the typing (${during.length} times)`);
  assert(
    during.every((c) => c.ms >= SCAN_MS * 0.9),
    `every check took the slow process-table path (>= ${Math.round(SCAN_MS * 0.9)} ms)`,
  );
  check(
    during.every((c) => c.answer === true),
    `every check saw the shell at its prompt (answers: ${JSON.stringify(details.checkAnswers)})`,
  );
  check(
    details.keyEchoMedianMs < MEDIAN_LIMIT_MS,
    `keys show up quickly while the checks run (median ${details.keyEchoMedianMs} ms < ${MEDIAN_LIMIT_MS} ms)`,
  );
  check(
    slowKeys.length <= 1,
    `no key waited for a scan (${slowKeys.length} of ${keyMs.length} keys took over ${SLOW_KEY_MS} ms: ${JSON.stringify(slowKeys)})`,
  );

  await ctrlC(bridge, sessionId);
  await sleep(300);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app) {
    log("step 4: quit");
    try {
      await app.bridge.eval(`if (window.__f03FgLoad) window.__f03FgLoad.running = false; return true;`);
    } catch {
      // the app may already be gone
    }
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

if (failures.length > 0) {
  failed = true;
  log(`FAILED checks: ${failures.length}`);
  for (const f of failures) log(`  - ${f}`);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details });
