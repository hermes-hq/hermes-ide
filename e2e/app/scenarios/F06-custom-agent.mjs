#!/usr/bin/env node
// Scenario: F06 — agent catalog as data: a Custom agent (any command).
//
// Proves, on the REAL app, with a fake agent (a tiny Node program written to
// a temp folder; no real agent, no account):
//
//   run 1  fresh install, stable channel (the agentCatalog flag is on by
//          default since 2.0): the New Session agent step lists the catalog
//          agents by name ("GitHub Copilot CLI", not the retired gh
//          extension), the agents new in 2.0 and the Custom agent card. Its
//          Next button stays disabled until a command is typed. Name it
//          "Fake Agent", give it the fake agent's command, create the
//          session: the fake agent starts in the session's terminal (its
//          banner is on screen, it answers a typed line), and the sidebar
//          shows "Fake Agent". Then switch the flag off in Settings > Flags
//          (the kill switch).
//   run 2  relaunch: no Custom agent card and none of the agents new in 2.0.
//
// Negative control: HERMES_E2E_EXPECT_NAME=<something else> must end in
// RESULT: FAIL (the sidebar check is real).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F06-custom-agent.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F06-custom-agent.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F06-custom-agent";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

const AGENT_NAME = "Fake Agent";
const EXPECT_NAME = process.env.HERMES_E2E_EXPECT_NAME || AGENT_NAME;
const MARKER = "e2e-f06";
const FLAG_LABEL = "More agents and Custom agent";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ── The fake agent: prints a banner, answers each line, exits on "quit". ──
const fakeDir = mkdtempSync(join(tmpdir(), "hermes-e2e-f06-"));
const fakeScript = join(fakeDir, "fake-agent.mjs");
writeFileSync(
  fakeScript,
  `const marker = process.argv[2] ?? "fake";
process.stdout.write("FAKE-AGENT READY " + marker + "\\r\\n");
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.search(/[\\r\\n]/)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    if (line === "quit") { process.stdout.write("fake-agent bye\\r\\n"); process.exit(0); }
    process.stdout.write("fake-agent got: " + line + "\\r\\n");
  }
});
`,
);
// Typed into the session's shell (zsh, bash, PowerShell, cmd) exactly as
// written, so it must not need quoting.
const COMMAND = `${process.execPath} ${fakeScript} ${MARKER}`;
if (/\s/.test(process.execPath) || /\s/.test(fakeScript)) {
  throw new Error(`the fake agent command would need quoting: ${COMMAND}`);
}

// Windows keeps app data under %APPDATA%, which a private HOME does not
// move, so there the harness uses the real home and the test app's own data
// folder; relaunches then keep that folder instead of wiping it.
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f06-home-"));

function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first })
    : launchApp({ runDir, log, home: "private", homeDir });
}

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

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
  await dismissWhatsNew(bridge);
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
}

/** Opens the New Session wizard and waits for the agent step. */
async function openAgentStep(bridge) {
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  return bridge.eval(`
    return e2e.all(".session-creator-provider-card").map((c) => ({
      id: c.getAttribute("data-agent-id"),
      name: e2e.norm(c.querySelector(".session-creator-provider-name")?.innerText ?? ""),
    }));
  `);
}

/** Sets a React-controlled text input the way typing does (value + input event). */
function setInput(bridge, selector, value) {
  return bridge.eval(`
    const input = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  `);
}

/** Opens Settings, unlocks the hidden Flags tab (7 clicks on the title) and forces the catalog flag on or off. */
async function forceCatalogFlag(bridge, value) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.eval(`
    const title = e2e.must(e2e.first(".settings-title"), "settings title");
    for (let i = 0; i < 7; i++) e2e.click(title);
    return { clicked: 7 };
  `);
  await bridge.waitFor("the hidden Flags tab", `return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Flags");`);
  await bridge.eval(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Flags");
    return e2e.click(e2e.must(tab, "Flags tab"));
  `);
  const result = await bridge.clickWhenReady(`
    const group = e2e.all(".settings-group").find((g) => e2e.norm(g.querySelector(".settings-label")?.textContent ?? "") === ${JSON.stringify(FLAG_LABEL)});
    const sel = e2e.must(group?.querySelector("select"), "the agentCatalog flag select");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { value: sel.value };
  `);
  assert(result.value === value, `the agentCatalog flag select shows Force ${value}`);
  await bridge.waitFor("the override to be saved", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
    return overrides.agentCatalog === ${value === "on" ? "true" : "false"};
  `);
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   fake agent command: ${COMMAND}`);

  // ── run 1: stable, no override (on by default since 2.0) ──────────
  log("step 1: fresh launch on the stable channel: the agent step comes from the catalog, with the Custom agent");
  app = await launch(1, { first: true });
  const { bridge } = app;
  await completeOnboarding(bridge);
  let cards = await openAgentStep(bridge);
  log(`  agent cards: ${JSON.stringify(cards)}`);
  assert(cards.some((c) => c.id === "copilot" && c.name.startsWith("GitHub Copilot CLI")), "Copilot is the new GitHub Copilot CLI");
  assert(cards.some((c) => c.id === "gemini" && c.name.startsWith("Gemini CLI (legacy)")), "Gemini CLI is marked legacy");
  assert(cards.some((c) => c.id === "antigravity" && c.name.startsWith("Antigravity CLI")), "Antigravity CLI is offered on stable with no override");
  assert(cards.some((c) => c.id === "custom" && c.name === "Custom agent"), "the Custom agent card is offered on stable with no override");
  await bridge.screenshot(join(evidenceDir, "01-stable-agent-step.png"));

  log("step 3: pick Custom agent; Next stays disabled until a command is typed");
  await bridge.click('.session-creator-provider-card[data-agent-id="custom"]');
  await bridge.waitFor("the custom agent fields", `return !!e2e.first("#session-creator-custom-agent-command");`);
  assert(
    (await bridge.eval(`return e2e.first(".session-creator-actions .session-creator-btn-primary").disabled;`)) === true,
    "Next is disabled while the command is empty",
  );
  const fieldText = await bridge.eval(`
    return {
      nameLabel: e2e.norm(e2e.first('label[for="session-creator-custom-agent-name"]')?.textContent ?? ""),
      commandLabel: e2e.norm(e2e.first('label[for="session-creator-custom-agent-command"]')?.textContent ?? ""),
      hint: e2e.norm(e2e.first(".session-creator-custom-agent .session-creator-custom-suffix-hint")?.textContent ?? ""),
    };
  `);
  log(`  custom agent fields: ${JSON.stringify(fieldText)}`);
  assert(
    fieldText.nameLabel === "Name" && fieldText.commandLabel === "Command" && fieldText.hint.startsWith("Hermes starts this command"),
    "the custom agent fields show their translated labels (not raw keys)",
  );
  await setInput(bridge, "#session-creator-custom-agent-name", AGENT_NAME);
  const typed = await setInput(bridge, "#session-creator-custom-agent-command", COMMAND);
  assert(typed === COMMAND, "the command field holds the fake agent command");
  await bridge.waitFor("Next to become enabled", `return e2e.first(".session-creator-actions .session-creator-btn-primary").disabled === false;`);
  const preview = await bridge.text(".session-creator-launch-preview-cmd");
  assert(preview === COMMAND, `the launch preview shows the command ("${preview}")`);
  await bridge.screenshot(join(evidenceDir, "02-custom-agent-step.png"));

  log("step 4: create the session");
  const before = await bridge.terminalIds();
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
  const sessionId = await bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  log(`  session created: ${sessionId}`);

  log("step 5: the fake agent starts in the session's terminal");
  const banner = new RegExp(`^FAKE-AGENT READY ${MARKER}$`);
  const { lines } = await bridge.waitForTerminal(sessionId, banner, { timeoutMs: 60_000 });
  assert(lines.some((l) => banner.test(l.trim())), `the terminal shows the fake agent's banner`);
  log("  terminal content:");
  for (const l of lines.slice(-8)) log(`    | ${l}`);
  // The shell's line editor may redraw a long command, so only its end is
  // reliably on screen.
  assert(lines.some((l) => l.includes(`fake-agent.mjs ${MARKER}`)), "the command Hermes typed is on screen");
  await sleep(300);
  await bridge.typeInTerminal(sessionId, "hello from hermes\n");
  await bridge.waitForTerminal(sessionId, /^fake-agent got: hello from hermes$/, { timeoutMs: 15_000 });
  log("  ok — the fake agent answers what is typed in the terminal");

  log("step 6: the sidebar shows the custom agent's name");
  const tag = await bridge.waitFor("the agent tag on the session card", `
    const t = e2e.first(".session-item .session-agent-tag");
    return t ? e2e.norm(t.innerText) : null;
  `);
  assert(tag === EXPECT_NAME, `the session card's agent tag is "${EXPECT_NAME}" (shows "${tag}")`);
  await bridge.settle();
  const shot = await bridge.screenshot(join(evidenceDir, "03-custom-agent-running.png"));
  log(`  screenshot saved: ${shot.file} (${shot.width}x${shot.height})`);
  log("  terminal content:");
  for (const l of (await bridge.readTerminal(sessionId)).slice(-8)) log(`    | ${l}`);

  log("step 7: quit the fake agent and close the session");
  await bridge.typeInTerminal(sessionId, "quit\n");
  await bridge.waitForTerminal(sessionId, /^fake-agent bye$/, { timeoutMs: 15_000 });
  await bridge.click(".session-item .session-item-close");
  await sleep(300);
  if (await bridge.exists(".close-dialog")) await bridge.click(".close-dialog .close-dialog-btn-confirm");
  await bridge.waitFor("the session to leave the session list", `return e2e.all(".session-item").length === 0;`);

  log("step 8: switch the agentCatalog flag off in Settings > Flags (the kill switch), then relaunch");
  await forceCatalogFlag(bridge, "off");
  await quit(app);

  // ── run 2: flag forced off ───────────────────────────────────────
  app = await launch(2);
  await waitForReturningLaunch(app.bridge);
  cards = await openAgentStep(app.bridge);
  log(`  agent cards: ${JSON.stringify(cards)}`);
  assert(cards.some((c) => c.id === "copilot" && c.name.startsWith("GitHub Copilot CLI")), "the 1.x agents are still offered");
  assert(!cards.some((c) => c.id === "custom"), "no Custom agent card with the flag switched off");
  assert(!cards.some((c) => c.id === "opencode" || c.id === "antigravity"), "none of the agents new in 2.0 with the flag switched off");
  await app.bridge.screenshot(join(evidenceDir, "04-flag-off-agent-step.png"));
  await app.bridge.click(".session-creator .session-creator-close");
  await app.bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          sessions: e2e.all(".session-item").map((s) => e2e.norm(s.innerText).slice(0, 120)),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("step 9: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(fakeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
