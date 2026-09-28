#!/usr/bin/env node
// Scenario: C0 — the 2.0 contracts are wired into the REAL app.
//
// Proves, on the built app, that a SessionEvent reaches the per-session
// store the app reads (docs/adr/004-2.0-contracts.md):
//
//   1. the e2e injector feeds a `status` event for a session that has no
//      terminal at all; the store's snapshot (what `useSessionEvents` would
//      render) shows it, and a subscriber was woken exactly once;
//   2. an event pushed through the RUST side of the channel (the test-build
//      command `emit_session_event_for_test`, serde -> Tauri event -> the
//      frontend parser) lands in the same snapshot;
//   3. negative controls: a malformed event is refused by the injector AND
//      by the Rust command, and the snapshot does not move; a second session
//      is untouched by the first one's events;
//   4. the inbox seam: raise, list (oldest first), resolve;
//   5. the turn ledger seam answers with nothing (and validates its input).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/C0-session-event-bridge.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/C0-session-event-bridge.

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "C0-session-event-bridge";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const SESSION = "c0-fake-session";
const OTHER = "c0-other-session";

/** First-launch welcome flow, same steps as the terminal-echo scenario. */
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
    return { analytics: analytics.checked, policy: policy.checked };
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

const snapshot = (bridge, id) => bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)});`);

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log });
  const { bridge } = app;
  await completeOnboarding(bridge);
  await bridge.waitFor("the e2e hooks with the contract injector", `return typeof window.__HERMES_E2E__?.injectSessionEvent === "function";`);

  // ── 1. inject through the frontend injector ───────────────────────
  log("step 1: a status event injected for a session with no terminal shows up in the store the app reads");
  const before = await snapshot(bridge, SESSION);
  assert(before.version === 0 && before.status.kind === "idle" && before.status.confidence === "guessed", "before: nothing reported, status idle (guessed)");
  await bridge.eval(`window.__HERMES_E2E__.watchSessionEvents(${JSON.stringify(SESSION)}); return true;`);
  const accepted = await bridge.eval(`
    return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(SESSION)}, {
      type: "status", at: 1790000000000, source: "e2e",
      status: { kind: "needs_approval", confidence: "exact", detail: "Bash: rm -rf build" },
    });
  `);
  assert(accepted === true, "the injector accepted a well-formed status event");
  const s1 = await snapshot(bridge, SESSION);
  assert(s1.version === 1, `snapshot version is 1 (got ${s1.version})`);
  assert(s1.status.kind === "needs_approval" && s1.status.confidence === "exact", "status is needs_approval, exact");
  assert(s1.status.detail === "Bash: rm -rf build", "the detail line is the one injected");
  assert(s1.events.length === 1 && s1.events[0].type === "status" && s1.events[0].source === "e2e", "the event is kept with its source");
  const woken = await bridge.eval(`return window.__HERMES_E2E__.sessionEventNotifications(${JSON.stringify(SESSION)});`);
  assert(woken === 1, `the subscriber was woken once (got ${woken})`);
  const ids = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSessionIds();`);
  assert(ids.length === 1 && ids[0] === SESSION, `only this session has events (${JSON.stringify(ids)})`);

  // ── 2. through the Rust side of the channel ───────────────────────
  log("step 2: an event emitted by Rust (serde -> Tauri event -> parser) lands in the same snapshot");
  await bridge.eval(`
    await window.__TAURI_INTERNALS__.invoke("emit_session_event_for_test", {
      sessionId: ${JSON.stringify(SESSION)},
      event: { type: "identity", at: 1790000001000, source: "rust", vendorSessionId: "vs-0001", model: "fake-model-1", permissionMode: "default" },
    });
    return true;
  `);
  const s2 = await bridge.waitFor("the identity to reach the store", `
    const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(SESSION)});
    return s.identity.model === "fake-model-1" ? s : null;
  `);
  assert(s2.version === 2 && s2.identity.vendorSessionId === "vs-0001" && s2.identity.permissionMode === "default", "identity from Rust: vendor session, model and permission mode");
  assert(s2.status.kind === "needs_approval", "the earlier status is still there");
  assert(s2.events[1].source === "rust", "the Rust event carries its source");
  await bridge.eval(`
    await window.__TAURI_INTERNALS__.invoke("emit_session_event_for_test", {
      sessionId: ${JSON.stringify(SESSION)},
      event: { type: "exit", at: 1790000002000, code: 0, signal: null },
    });
    return true;
  `);
  const s3 = await bridge.waitFor("the exit to reach the store", `
    const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(SESSION)});
    return s.exit ? s : null;
  `);
  assert(s3.status.kind === "exited" && s3.status.confidence === "exact" && s3.status.detail === "", "an exit sets the status to exited, exactly, with no text of its own");
  const wokenAfterRust = await bridge.eval(`return window.__HERMES_E2E__.sessionEventNotifications(${JSON.stringify(SESSION)});`);
  assert(wokenAfterRust === 3, `the subscriber was woken once per event (got ${wokenAfterRust})`);

  // ── 3. negative controls ──────────────────────────────────────────
  log("step 3: malformed events are refused on both sides and change nothing; other sessions are untouched");
  const refused = await bridge.eval(`
    const H = window.__HERMES_E2E__;
    return [
      H.injectSessionEvent(${JSON.stringify(SESSION)}, { type: "status", at: 1, status: { kind: "bogus", confidence: "exact", detail: "" } }),
      H.injectSessionEvent(${JSON.stringify(SESSION)}, { type: "turn_start", at: 1, n: 0 }),
      H.injectSessionEvent(${JSON.stringify(SESSION)}, { type: "nope", at: 1 }),
      H.injectSessionEvent("", { type: "attention", at: 1, detail: "x" }),
    ];
  `);
  assert(refused.every((r) => r === false), `the injector refused every malformed event (${JSON.stringify(refused)})`);
  const rustRefusal = await bridge.eval(`
    try {
      await window.__TAURI_INTERNALS__.invoke("emit_session_event_for_test", {
        sessionId: ${JSON.stringify(SESSION)},
        event: { type: "status", at: 1, status: { kind: "bogus", confidence: "exact", detail: "" } },
      });
      return { threw: false };
    } catch (e) { return { threw: true, message: String(e) }; }
  `);
  assert(rustRefusal.threw && /not a SessionEvent/.test(rustRefusal.message), `Rust refused the malformed event: ${rustRefusal.message}`);
  await sleep(300);
  const s4 = await snapshot(bridge, SESSION);
  assert(s4.version === 3 && s4.events.length === 3, `nothing moved: version ${s4.version}, ${s4.events.length} events`);
  const other = await snapshot(bridge, OTHER);
  assert(other.version === 0 && other.status.kind === "idle", "a second session saw none of it");

  // ── 4. the inbox seam ─────────────────────────────────────────────
  log("step 4: inbox raise / list / resolve");
  const inbox = await bridge.eval(`
    const H = window.__HERMES_E2E__;
    const a = H.raiseInboxItem({ kind: "blocked", sessionId: ${JSON.stringify(SESSION)}, detail: "Bash: rm -rf build", source: "e2e" });
    const b = H.raiseInboxItem({ kind: "gate", detail: "plan", source: "e2e" });
    const dup = H.raiseInboxItem({ kind: "blocked", sessionId: ${JSON.stringify(SESSION)}, detail: "Bash: rm -rf build", source: "e2e" });
    const listed = H.inboxItems();
    const resolved = H.resolveInboxItem(a.id);
    const again = H.resolveInboxItem(a.id);
    return { a, b, dup, listed, resolved, again, after: H.inboxItems() };
  `);
  assert(inbox.listed.length === 2 && inbox.listed[0].id === inbox.a.id && inbox.listed[1].id === inbox.b.id, "two items, oldest first");
  assert(inbox.dup.id === inbox.a.id, "raising the same thing twice returns the open item");
  assert(inbox.a.kind === "blocked" && inbox.a.sessionId === SESSION && inbox.a.source === "e2e" && typeof inbox.a.createdAt === "number", "an item has kind, session, detail, time and source");
  assert(inbox.resolved === true && inbox.again === false, "resolve works once");
  assert(inbox.after.length === 1 && inbox.after[0].kind === "gate" && inbox.after[0].sessionId === null, "the gate item remains");

  // ── 5. the turn ledger seam ───────────────────────────────────────
  log("step 5: the turn ledger commands answer with nothing until F20 lands");
  const turns = await bridge.eval(`
    const inv = window.__TAURI_INTERNALS__.invoke;
    const list = await inv("list_turns", { sessionId: ${JSON.stringify(SESSION)} });
    const diff = await inv("get_turn_diff", { sessionId: ${JSON.stringify(SESSION)}, n: 1 });
    let bad = null;
    try { await inv("get_turn_diff", { sessionId: "has space", n: 1 }); } catch (e) { bad = String(e); }
    return { list, diff, bad };
  `);
  assert(Array.isArray(turns.list) && turns.list.length === 0, "list_turns -> []");
  assert(turns.diff === null, "get_turn_diff -> null");
  assert(typeof turns.bad === "string" && /not a turn/.test(turns.bad), `an invalid session id is refused: ${turns.bad}`);

  await bridge.screenshot(join(evidenceDir, "01-after-events.png"));
  await bridge.eval(`window.__HERMES_E2E__.unwatchSessionEvents(${JSON.stringify(SESSION)}); return true;`);
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
    log("step 6: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
