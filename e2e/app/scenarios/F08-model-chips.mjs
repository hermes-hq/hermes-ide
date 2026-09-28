#!/usr/bin/env node
// Scenario F08: read-only model / permission-mode chips on terminal sessions.
//
// Proves, on the built app, that a terminal session's row shows the model
// and permission-mode a running agent reports about itself — and only
// that. F11 (the spool watcher that turns a real agent's hook events into
// `identity` SessionEvents) is a separate, parallel track and is not on
// main yet, so this scenario plays F11's part itself: it opens a plain
// shell session (no agent runs in it) and feeds the identity events an
// agent's hooks would have produced through the same contract seam F11
// will use (`window.__HERMES_E2E__.injectSessionEvent` —
// docs/adr/004-2.0-contracts.md #2's test seam). What's proven is the
// app's side: the chip appears, tracks a live model change, stays readable
// at the default sidebar width, and never shows what wasn't reported —
// never the spool watcher itself.
//
//   1. a fresh terminal session shows no chip (nothing reported yet);
//   2. an injected identity event with a model makes the model chip appear
//      with that text; a second one with a different, full-length model id
//      updates it in place, and the chip shows the whole id, not an
//      ellipsis, at the default window and sidebar size;
//   3. the permission-mode chip appears independently of the model chip
//      (hidden field-by-field, never guessed);
//   4. the session row with its chips passes the rig's accessibility audit
//      (e2e/app/a11y.mjs), and the audit is shown to fail on an unnamed
//      button planted in the same row;
//   5. negative controls: a malformed identity event is refused and the
//      chip does not move; an identity event for another session never
//      reaches this one's chip. (Agent-mode sessions never show chips;
//      agent mode isn't reachable without a real Claude session, so that
//      is covered by src/__tests__/session-identity-chips.test.tsx.)
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F08-model-chips.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F08-model-chips.

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { a11yAudit } from "../a11y.mjs";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F08-model-chips";
// Synthetic, but as long as a real dated model id — the chip must show all of it.
const LONG_MODEL = "fake-model-sonnet-4-5-20250929";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

async function completeOnboarding(bridge) {
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
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function createPlainTerminal(bridge) {
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
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

const chipText = (bridge, sessionId, testid) => bridge.eval(`
  const row = e2e.first('[data-session-item-id="${sessionId}"]');
  if (!row) return null;
  const el = row.querySelector('[data-testid="${testid}"]');
  return el ? el.textContent : null;
`);

const injectIdentity = (bridge, sessionId, { model = null, permissionMode = null, vendorSessionId = null, at }) => bridge.eval(`
  return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sessionId)}, {
    type: "identity", at: ${at}, source: "e2e",
    vendorSessionId: ${JSON.stringify(vendorSessionId)},
    model: ${JSON.stringify(model)},
    permissionMode: ${JSON.stringify(permissionMode)},
  });
`);

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log });
  const { bridge } = app;
  await completeOnboarding(bridge);
  await bridge.waitFor("the e2e hooks with the contract injector", `return typeof window.__HERMES_E2E__?.injectSessionEvent === "function";`);

  log("step 1: a plain terminal session starts with no chip — nothing reported yet");
  const sessionId = await createPlainTerminal(bridge);
  await bridge.waitFor("the session row", `return !!e2e.first('[data-session-item-id="${sessionId}"]');`);
  assert((await chipText(bridge, sessionId, "session-model-chip")) === null, "no model chip before any identity event");
  assert((await chipText(bridge, sessionId, "session-permission-chip")) === null, "no permission chip before any identity event");

  log("step 2: an injected identity event (standing in for F11) shows the model; a reported model change updates the chip");
  const accepted1 = await injectIdentity(bridge, sessionId, { model: "fake-model-1", at: 1790000000000 });
  assert(accepted1 === true, "the injector accepted the first identity event");
  await bridge.waitFor("the model chip to show the first model", `
    const row = e2e.first('[data-session-item-id="${sessionId}"]');
    const el = row && row.querySelector('[data-testid="session-model-chip"]');
    return el && el.textContent === "fake-model-1" ? true : null;
  `);
  assert((await chipText(bridge, sessionId, "session-permission-chip")) === null, "permission mode still unknown, still hidden");

  const accepted2 = await injectIdentity(bridge, sessionId, { model: LONG_MODEL, permissionMode: "acceptEdits", at: 1790000001000 });
  assert(accepted2 === true, "the injector accepted the second identity event");
  await bridge.waitFor("the model chip to follow the reported change", `
    const row = e2e.first('[data-session-item-id="${sessionId}"]');
    const el = row && row.querySelector('[data-testid="session-model-chip"]');
    return el && el.textContent === ${JSON.stringify(LONG_MODEL)} ? true : null;
  `);
  assert((await chipText(bridge, sessionId, "session-permission-chip")) === "acceptEdits", "the permission-mode chip now shows what the agent reported");
  const fit = await bridge.eval(`
    const row = e2e.first('[data-session-item-id="${sessionId}"]');
    const chips = ["session-model-chip", "session-permission-chip"].map((id) => row.querySelector('[data-testid="' + id + '"]'));
    const sidebar = row.getBoundingClientRect().width;
    return { sidebar: Math.round(sidebar), chips: chips.map((el) => ({ scroll: el.scrollWidth, client: el.clientWidth })) };
  `);
  log(`  row width ${fit.sidebar}px; chips (scrollWidth/clientWidth): ${JSON.stringify(fit.chips)}`);
  assert(fit.chips.every((c) => c.client > 0 && c.scroll <= c.client), "both chips show their whole text at the default sidebar width (no ellipsis)");
  await bridge.screenshot(join(evidenceDir, "chips-showing.png"));

  log("step 3: the row passes the accessibility audit, and the audit can fail");
  const rowSelector = `[data-session-item-id="${sessionId}"]`;
  const clean = await a11yAudit(bridge, rowSelector);
  assert(clean.length === 0, `no accessibility violations in the session row (${JSON.stringify(clean)})`);
  await bridge.eval(`
    const planted = document.createElement("button");
    planted.className = "f08-planted-unnamed";
    e2e.first('${rowSelector}').appendChild(planted);
    return true;
  `);
  const planted = await a11yAudit(bridge, rowSelector);
  await bridge.eval(`document.querySelector(".f08-planted-unnamed")?.remove(); return true;`);
  assert(planted.some((v) => v.rule === "name" && v.element.includes("f08-planted-unnamed")), `the audit flags an unnamed button planted in the row (${JSON.stringify(planted)})`);

  log("step 4: negative controls — a malformed event changes nothing; another session's identity never shows here");
  const refused = await bridge.eval(`
    const H = window.__HERMES_E2E__;
    return [
      H.injectSessionEvent(${JSON.stringify(sessionId)}, { type: "identity", at: 3, model: 5, permissionMode: null, vendorSessionId: null }),
      H.injectSessionEvent(${JSON.stringify(sessionId)}, { type: "identity", model: "x", permissionMode: null, vendorSessionId: null }),
      H.injectSessionEvent("", { type: "identity", at: 3, model: "x", permissionMode: null, vendorSessionId: null }),
    ];
  `);
  assert(refused.every((r) => r === false), `every malformed identity event was refused (${JSON.stringify(refused)})`);
  assert((await chipText(bridge, sessionId, "session-model-chip")) === LONG_MODEL, "the chip did not move after the refused events");

  const otherAccepted = await injectIdentity(bridge, "f08-other-session-with-no-terminal", { model: "should-never-show", at: 1790000002000 });
  assert(otherAccepted === true, "an identity event for an unrelated session is accepted by the store");
  assert((await chipText(bridge, sessionId, "session-model-chip")) === LONG_MODEL, "the real session's chip is unaffected by another session's identity event");
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
    log("step 5: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
