#!/usr/bin/env node
// Scenario (README claim "ghost-text"): at the shell prompt Hermes completes
// what you type from your command history, as faded "ghost" text after the
// cursor, and → accepts it.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/ghost-text.mjs
//
//   1. a plain terminal; run a command nobody has run before
//   2. type the start of a command that is in no history. EXPECT: no ghost
//      text (the control: nothing is invented)
//   3. type the start of the command from step 1. EXPECT: the ghost text is
//      exactly the rest of that command
//   4. press →. EXPECT: the ghost text is gone and the prompt line holds the
//      whole command; Enter runs it (its output appears a second time)

import { platform } from "node:os";
import { join } from "node:path";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";
import { domKey } from "../qa-host-steps.mjs";

const SCENARIO = "ghost-text";
const TOKEN = `hermes-ghost-${Date.now().toString(36)}`;
const COMMAND = `echo ${TOKEN}`;
const PREFIX = COMMAND.slice(0, "echo hermes-gh".length);

const ghosts = (bridge) =>
  bridge.eval(`return [...document.querySelectorAll(".ghost-text-overlay")].filter((g) => g.isConnected).map((g) => g.textContent);`);

/** Erase what was typed with Backspace (works the same in every shell). */
async function eraseTyped(bridge, id, count) {
  for (let i = 0; i < count; i++) await domKey(bridge, id, { key: "Backspace", code: "Backspace" }, 8);
  await sleep(400);
}

await runScenario(SCENARIO, async ({ log, assert, apps, evidenceDir }) => {
  if (platform() === "win32") {
    // PowerShell predicts from its own history (PSReadLine); Hermes leaves
    // the prompt to a shell with suggestions of its own.
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows PowerShell shows its own predictions, and Hermes draws no ghost text over them", log });
  }
  log("step 1: launch, open a plain terminal, run a command nobody has run before");
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);
  const id = await createPlainTerminal(bridge, log);
  await bridge.typeInTerminal(id, `${COMMAND}\n`);
  await bridge.waitForTerminal(id, new RegExp(`^${TOKEN}$`), { timeoutMs: 20_000 });
  await sleep(1000);

  log("step 2: the start of a command that is in no history: no ghost text");
  await bridge.typeInTerminal(id, "echo zqxv-");
  await sleep(1500);
  const none = await ghosts(bridge);
  log(`  ghost text: ${JSON.stringify(none)}`);
  assert(none.length === 0, "no ghost text for a prefix nothing in the history starts with");
  await eraseTyped(bridge, id, "echo zqxv-".length);

  log(`step 3: type "${PREFIX}"`);
  await bridge.typeInTerminal(id, PREFIX);
  const shown = await bridge.waitFor("ghost text after the cursor", `
    const g = [...document.querySelectorAll(".ghost-text-overlay")].filter((g) => g.isConnected).map((g) => g.textContent);
    return g.length ? g : null;
  `, { timeoutMs: 10_000 });
  log(`  ghost text: ${JSON.stringify(shown)}`);
  assert(shown.length === 1 && shown[0] === COMMAND.slice(PREFIX.length), `the ghost text is the rest of the earlier command ("${COMMAND.slice(PREFIX.length)}")`);
  const style = await bridge.eval(`
    const g = [...document.querySelectorAll(".ghost-text-overlay")].find((g) => g.isConnected);
    const s = getComputedStyle(g);
    return { opacity: Number(s.opacity), inScreen: !!g.closest(".xterm-screen"), session: g.closest("div[data-session-id]")?.getAttribute("data-session-id") };
  `);
  assert(style.opacity < 1 && style.inScreen && style.session === id, "it is drawn faded, inside this terminal's screen");
  await bridge.screenshot(join(evidenceDir, "01-ghost-text.png"));
  const typed = await bridge.eval(`
    const lines = (window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || []).filter((l) => l.trim());
    return lines[lines.length - 1] ?? "";
  `);
  assert(typed.trimEnd().endsWith(PREFIX), `until it is accepted, the prompt holds only what was typed (${JSON.stringify(typed)})`);

  log("step 4: → accepts it; Enter runs the whole command");
  await domKey(bridge, id, { key: "ArrowRight", code: "ArrowRight" }, 39);
  await bridge.waitFor("the ghost text to go away", `return [...document.querySelectorAll(".ghost-text-overlay")].filter((g) => g.isConnected).length === 0;`);
  // The command line from step 1 also ends with the command; the prompt
  // being typed on is the last non-empty line.
  const line = await bridge.waitFor("the whole command on the prompt line", `
    const lines = (window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || []).filter((l) => l.trim());
    const last = lines[lines.length - 1] ?? "";
    return last.trimEnd().endsWith(${JSON.stringify(COMMAND)}) ? last : null;
  `, { timeoutMs: 10_000 });
  log(`  prompt line: ${JSON.stringify(line)}`);
  assert(line.trimEnd().endsWith(COMMAND), "the prompt line now holds the whole command");
  await bridge.screenshot(join(evidenceDir, "02-accepted.png"));
  await bridge.typeInTerminal(id, "\n");
  await bridge.waitFor("the command's output a second time", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || [];
    return lines.filter((l) => l.trim() === ${JSON.stringify(TOKEN)}).length >= 2;
  `, { timeoutMs: 15_000 });
  assert(true, "the accepted command ran");
});
