#!/usr/bin/env node
// Scenario: suggestions and ghost text never offer back a secret.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/QA-no-secret-suggestions.mjs
//
//   1. a plain terminal; run an everyday command and one that sets an API key
//   2. type the start of the everyday command. EXPECT: ghost text with the
//      rest (the control: suggestions are on and learn from typed commands)
//   3. type the start of the API-key line. EXPECT: no ghost text
//   4. at a hidden prompt the shell itself shows (`read -s`), type a
//      password and Enter. EXPECT: once the prompt is back, typing the start
//      of that password shows no ghost text

import { platform } from "node:os";
import { join } from "node:path";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";
import { domKey } from "../qa-host-steps.mjs";

const SCENARIO = "QA-no-secret-suggestions";
const T = Date.now().toString(36);
const PLAIN = `echo hermes-plain-${T}`;
const PLAIN_PREFIX = "echo hermes-plain-";
const KEY_LINE = `export HERMES_E2E_API_KEY=e2e-${T}`;
const KEY_PREFIX = "export HERMES_E2E_A";
const PASSWORD = `hermes-pw-${T}`;
const PASSWORD_PREFIX = "hermes-pw-";

const ghosts = (bridge) =>
  bridge.eval(`return [...document.querySelectorAll(".ghost-text-overlay")].filter((g) => g.isConnected).map((g) => g.textContent);`);

/** Erase what was typed with Backspace (works the same in every shell). */
async function eraseTyped(bridge, id, count) {
  for (let i = 0; i < count; i++) await domKey(bridge, id, { key: "Backspace", code: "Backspace" }, 8);
  await sleep(400);
}

/** Type `prefix`, give suggestions time to come up, and return the ghost text shown. */
async function ghostAfter(bridge, id, prefix) {
  await bridge.typeInTerminal(id, prefix);
  await sleep(1500);
  const shown = await ghosts(bridge);
  await eraseTyped(bridge, id, prefix.length);
  return shown;
}

await runScenario(SCENARIO, async ({ log, assert, apps, evidenceDir }) => {
  if (platform() === "win32") {
    // PowerShell predicts from its own history (PSReadLine); Hermes draws no
    // ghost text over it (see ghost-text.mjs).
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows PowerShell shows its own predictions, and Hermes draws no ghost text over them", log });
  }
  log("step 1: launch, open a plain terminal, run an everyday command and one that sets an API key");
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);
  const id = await createPlainTerminal(bridge, log);
  await bridge.typeInTerminal(id, `${PLAIN}\n`);
  await bridge.waitForTerminal(id, new RegExp(`^hermes-plain-${T}$`), { timeoutMs: 20_000 });
  await bridge.typeInTerminal(id, `${KEY_LINE}; echo key-set-${T}\n`);
  await bridge.waitForTerminal(id, new RegExp(`^key-set-${T}$`), { timeoutMs: 20_000 });
  await sleep(1500);

  log(`step 2 (control): type "${PLAIN_PREFIX}"`);
  const control = await ghostAfter(bridge, id, PLAIN_PREFIX);
  log(`  ghost text: ${JSON.stringify(control)}`);
  assert(control.length === 1 && control[0] === PLAIN.slice(PLAIN_PREFIX.length), "an everyday command typed earlier comes back as ghost text");

  log(`step 3: type "${KEY_PREFIX}"`);
  const key = await ghostAfter(bridge, id, KEY_PREFIX);
  log(`  ghost text: ${JSON.stringify(key)}`);
  assert(key.length === 0, "a line that sets an API key is never offered back");
  await bridge.screenshot(join(evidenceDir, "01-no-key-ghost.png"));

  log("step 4: a password typed at a hidden prompt the shell shows itself (read -s)");
  await bridge.typeInTerminal(id, `read -s HERMES_E2E_PW; echo read-done-${T}\n`);
  await sleep(1000);
  await bridge.typeInTerminal(id, `${PASSWORD}\n`);
  await bridge.waitForTerminal(id, new RegExp(`^read-done-${T}$`), { timeoutMs: 20_000 });
  const screen = (await bridge.readTerminal(id)) ?? [];
  assert(!screen.some((l) => l.includes(PASSWORD)), "the password never appeared on screen (echo was off)");
  await sleep(1500);
  const pw = await ghostAfter(bridge, id, PASSWORD_PREFIX);
  log(`  ghost text: ${JSON.stringify(pw)}`);
  assert(pw.length === 0, "what was typed at the hidden prompt is never offered back");
  await bridge.screenshot(join(evidenceDir, "02-no-password-ghost.png"));
});
