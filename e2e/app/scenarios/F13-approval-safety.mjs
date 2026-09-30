#!/usr/bin/env node
// Scenario F13: in Agent view an approval cannot be accepted by accident.
//
// A person is typing to the agent when it asks for permission to run a
// command. They keep typing and press Enter. That Enter must go to their
// message, never to the approval. Then they choose "Always allow" and the
// rule must land in the project's .claude/settings.local.json, not in their
// global ~/.claude/settings.json, and show up in the workbench's Context
// tab (Permissions) as a "local" rule.
//
// The agent is a replayed session (tools/fake-agents/replay-stdio.mjs with
// e2e/app/fixtures/F13-bash-approval.jsonl), selected through
// HERMES_BRIDGE_PATH, so no account or network is needed.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F13-approval-safety.mjs
//
// Keys go to whatever element has keyboard focus, exactly like a keyboard:
// the key events are dispatched on document.activeElement and, when the page
// does not consume them, the browser's own default action for that element
// follows (text is inserted into a text field; Enter activates a button).

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F13-approval-safety";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

const REPLAY = join(REPO_ROOT, "tools", "fake-agents", "replay-stdio.mjs");
const CASSETTE = join(REPO_ROOT, "e2e", "app", "fixtures", "F13-bash-approval.jsonl");
/** Rule "Always allow" must write for the cassette's `rm -rf build`. */
const EXPECTED_RULE = "Bash(rm -rf build:*)";
/** Only appears on screen once the approved command has run. */
const TOOL_RAN_MARKER = "F13-TOOL-RAN";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** In-page: describe the element that has keyboard focus. */
const FOCUS_SCRIPT = `
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: "body", inPermPrompt: false, isComposer: false, name: "" };
  return {
    tag: el.tagName.toLowerCase(),
    name: e2e.nameOf(el).slice(0, 60),
    inPermPrompt: !!el.closest(".perm-modal"),
    isComposer: el.classList.contains("session-composer-input"),
  };
`;

/** In-page: type `text` into whatever has keyboard focus, one key at a time. */
const typeIntoFocused = (text) => `
  const text = ${JSON.stringify(text)};
  const activations = [];
  for (const ch of text) {
    const el = document.activeElement || document.body;
    const isEnter = ch === "\\n";
    const key = isEnter ? "Enter" : ch;
    const init = { key, code: isEnter ? "Enter" : "", bubbles: true, cancelable: true, composed: true, view: window };
    const down = new KeyboardEvent("keydown", init);
    Object.defineProperty(down, "keyCode", { get: () => (isEnter ? 13 : ch.toUpperCase().charCodeAt(0)) });
    const notConsumed = el.dispatchEvent(down);
    if (notConsumed) {
      if (el instanceof HTMLButtonElement && isEnter) {
        // Enter on a focused button presses it.
        activations.push(e2e.nameOf(el).slice(0, 60));
        el.click();
      } else if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !isEnter)) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        setter.call(el, el.value.slice(0, start) + ch + el.value.slice(end));
        el.setSelectionRange(start + 1, start + 1);
        el.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: isEnter ? "insertLineBreak" : "insertText", data: isEnter ? null : ch,
        }));
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    await new Promise((r) => setTimeout(r, 10));
  }
  return { activations };
`;

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  assert(existsSync(REPLAY), `the replay agent exists (${REPLAY})`);
  assert(existsSync(CASSETTE), `the approval cassette exists (${CASSETTE})`);

  // ── 1. Launch with the replayed agent ────────────────────────────
  log("step 1: launch the test app with the replayed Claude bridge");
  app = await launchApp({
    runDir: join(evidenceDir, "run"),
    log,
    home: process.env.HERMES_E2E_HOME || undefined,
    env: { HERMES_BRIDGE_PATH: REPLAY, HERMES_FAKE_CASSETTE: CASSETTE, HERMES_FAKE_SPEED: "0" },
  });
  const { bridge } = app;
  const privateHome = existsSync(join(app.tmpDir, "home")) ? join(app.tmpDir, "home") : null;
  const home = privateHome ?? homedir();
  const userSettings = join(home, ".claude", "settings.json");
  const userSettingsBefore = existsSync(userSettings) ? readFileSync(userSettings, "utf8") : null;
  log(`  global Claude settings file: ${privateHome ? "<private home>" : "<real home>"}/.claude/settings.json (exists: ${userSettingsBefore !== null})`);

  // A fresh project folder for the agent to work in.
  const projectDir = join(app.tmpDir, "f13-project");
  mkdirSync(projectDir, { recursive: true });
  const localSettings = join(projectDir, ".claude", "settings.local.json");

  // ── 2. First-launch welcome ──────────────────────────────────────
  log("step 2: go through the first-launch welcome screens");
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

  // ── 3. New Agent session in the project folder ───────────────────
  log("step 3: create an Agent session for the project folder through the New Session wizard");
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  // The wizard opens on the agent step: pick Claude, then tick "Agent view for Claude".
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const claude = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(claude, "the Claude card"));
  `);
  const agentViewBox = `e2e.first(".session-creator-agent-view input[type=checkbox]")`;
  await bridge.waitFor("the Agent view option", `return !!${agentViewBox};`);
  if (!(await bridge.eval(`return ${agentViewBox}.checked;`))) {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(${agentViewBox}, "the Agent view checkbox"));`);
  }
  await bridge.waitFor("the Agent view to be chosen", `return ${agentViewBox}?.checked === true;`);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`);
  await bridge.eval(`
    const input = e2e.must(e2e.first(".session-creator-scan-input"), "folder path input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, ${JSON.stringify(projectDir)});
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    return true;
  `);
  await bridge.clickWhenReady(`
    const scan = e2e.all(".session-creator-scan-btn").find((b) => !b.disabled && /scan/i.test(e2e.nameOf(b)));
    return e2e.click(e2e.must(scan, "the Scan button"));
  `);
  await bridge.waitFor("the project folder to be attached", `
    return e2e.all(".project-picker-item-attached").some((el) => el.innerText.includes("f13-project"));
  `);
  await bridge.screenshot(join(evidenceDir, "01-wizard-project-folder.png"));
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
  await bridge.waitFor("the Agent view", `return !!e2e.first(".agent-session-view");`, { timeoutMs: 20_000 });
  if (!(await bridge.exists(".session-composer-input"))) {
    await bridge.click(".session-composer-fab");
  }
  await bridge.waitFor("the composer", `return !!e2e.first(".session-composer-input");`);

  // ── 4. Type to the agent; the agent asks for approval ────────────
  log("step 4: click into the composer, type a request and press Enter");
  await bridge.click(".session-composer-input");
  const first = await bridge.eval(typeIntoFocused("please clean the build folder\n"), { timeoutMs: 20_000 });
  log(`  sent the first message (buttons pressed by Enter: ${JSON.stringify(first.activations)})`);
  await bridge.waitFor("the approval prompt", `return !!e2e.first(".perm-modal");`, { timeoutMs: 30_000 });
  const prompt = await bridge.text(".perm-modal");
  assert(/rm -rf build/.test(prompt), "the approval prompt shows the command the agent wants to run");
  await sleep(500); // give any autofocus a chance to happen, as it would for a person
  const focusAfterPrompt = await bridge.eval(FOCUS_SCRIPT);
  log(`  keyboard focus after the prompt appeared: ${JSON.stringify(focusAfterPrompt)}`);
  await bridge.screenshot(join(evidenceDir, "02-approval-prompt.png"));

  // ── 5. Keep typing and press Enter ───────────────────────────────
  log("step 5: keep typing in the composer and press Enter while the approval is open");
  const second = await bridge.eval(typeIntoFocused("wait, show me first\n"), { timeoutMs: 20_000 });
  log(`  buttons pressed by Enter: ${JSON.stringify(second.activations)}`);
  await sleep(2500); // long enough for an accidental approval to reach the agent and come back
  const after = await bridge.eval(`
    return {
      promptOpen: !!e2e.first(".perm-modal"),
      toolRan: document.body.innerText.includes(${JSON.stringify(TOOL_RAN_MARKER)}),
      messageShown: document.body.innerText.includes("wait, show me first"),
    };
  `);
  log(`  after Enter: ${JSON.stringify(after)}`);
  await bridge.screenshot(join(evidenceDir, "03-after-enter-still-pending.png"));
  assert(second.activations.length === 0, `Enter did not press any button (pressed: ${JSON.stringify(second.activations)})`);
  assert(after.promptOpen, "the approval prompt is still open after Enter");
  assert(!after.toolRan, "the agent did not run the command");
  assert(after.messageShown, "the typed message went to the conversation instead");
  assert(!focusAfterPrompt.inPermPrompt, "the approval prompt did not take keyboard focus");
  assert(focusAfterPrompt.isComposer, "keyboard focus stayed in the composer when the prompt appeared");

  // ── 6. Open the rule list ────────────────────────────────────────
  log("step 6: open the workbench's Context tab, where permission rules are listed");
  if (!(await bridge.exists(".workbench-panel"))) {
    await bridge.click('.activity-bar-right [data-tab-id="workbench"]');
  }
  await bridge.waitFor("the workbench", `return !!e2e.first(".workbench-panel");`);
  await bridge.clickWhenReady(`
    const tab = e2e.all(".workbench-tab").find((b) => e2e.norm(b.innerText).toLowerCase() === "context");
    return e2e.click(e2e.must(tab, "the workbench's Context tab"));
  `);
  await bridge.waitFor("the permissions list", `return !!e2e.first(".workbench-panel .perms-section");`);
  const RULE_ROW = `e2e.all(".workbench-panel .perms-row").find((r) => r.innerText.includes(${JSON.stringify(EXPECTED_RULE)}))`;
  assert(!(await bridge.eval(`return !!${RULE_ROW};`)), "the rule is not listed before Always allow");
  assert(await bridge.exists(".perm-modal"), "the approval prompt is still open");

  // ── 7. Always allow ──────────────────────────────────────────────
  log('step 7: click "Always allow" on the approval prompt');
  // Found by its visible label (its accessible name is the hint text).
  const ALWAYS_ALLOW = `e2e.all(".perm-modal button").find((b) => e2e.norm(b.innerText).startsWith("Always allow"))`;
  const title = await bridge.eval(`
    return e2e.must(${ALWAYS_ALLOW}, "Always allow button").getAttribute("title");
  `);
  log(`  button hint: ${title}`);
  assert(/settings\.local\.json/.test(title ?? ""), "the button says the rule goes to the project's settings.local.json");
  await bridge.clickWhenReady(`return e2e.click(e2e.must(${ALWAYS_ALLOW}, "Always allow button"));`);
  await bridge.waitFor("the approval prompt to close", `return !e2e.first(".perm-modal");`);
  await bridge.waitFor("the approved command to run", `return document.body.innerText.includes(${JSON.stringify(TOOL_RAN_MARKER)});`, {
    timeoutMs: 15_000,
  });
  log("  the approved command ran");

  const deadline = Date.now() + 10_000;
  while (!existsSync(localSettings) && Date.now() < deadline) await sleep(100);
  const local = readJson(localSettings);
  log(`  <project>/.claude/settings.local.json: ${JSON.stringify(local)}`);
  assert(Array.isArray(local?.permissions?.allow) && local.permissions.allow.includes(EXPECTED_RULE),
    `the project's .claude/settings.local.json allows ${EXPECTED_RULE}`);
  const userSettingsAfter = existsSync(userSettings) ? readFileSync(userSettings, "utf8") : null;
  assert(userSettingsAfter === userSettingsBefore, "the global ~/.claude/settings.json was not touched");
  assert(!existsSync(join(projectDir, ".claude", "settings.json")), "the shared project settings.json was not created");
  await bridge.waitFor("the saved rule to appear in the Context tab", `return !!${RULE_ROW};`, { timeoutMs: 10_000 });
  const listed = await bridge.eval(`return e2e.norm(${RULE_ROW}.innerText);`);
  log(`  Context tab row: ${listed}`);
  assert(/local$/i.test(listed), "the Context tab lists it as a local (this project) rule");
  await sleep(300);
  const shot = await bridge.screenshot(join(evidenceDir, "04-always-allowed.png"));
  log(`  screenshot saved: ${shot.file} (${shot.bytes} bytes)`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          focus: document.activeElement ? e2e.nameOf(document.activeElement).slice(0, 60) : null,
          text: document.body.innerText.slice(-1500),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
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
