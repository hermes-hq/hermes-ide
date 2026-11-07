#!/usr/bin/env node
// Scenario (fix): in a plain terminal, ↑ recalls earlier commands the way it
// does in any other terminal. Hermes's suggestion list must not take ↑ away
// from the shell, and the shell must keep its real history file.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-terminal-up-history.mjs
//
//   1. a plain terminal. zsh only: EXPECT $HISTFILE is the user's own
//      (~/.zsh_history), not a file in Hermes's temporary startup folder
//   2. run a command, leave the shell, open a new terminal, press ↑.
//      EXPECT: the command from the first terminal is on the prompt
//   3. run a command, type the start of it so Hermes's suggestion list
//      opens, press ↑. EXPECT: the list closes and the prompt holds the
//      previous command (the shell's history), not a highlighted suggestion
//   4. type the start of the command so the list opens, close it with Esc,
//      press ↑. EXPECT: the prompt holds the previous command, and the list
//      does not open again for the text typed before ↑
//   5. type the start again so the list opens, press ↓. EXPECT: the first
//      suggestion is highlighted (↓ still moves into the list)

import { platform } from "node:os";
import { join } from "node:path";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";
import { domKey } from "../qa-host-steps.mjs";

const SCENARIO = "FIX-terminal-up-history";
const RUN = Date.now().toString(36);
const FIRST = `echo hermes-up-first-${RUN}`;
const SECOND = `echo hermes-up-second-${RUN}`;
const PREFIX = "echo hermes-up-se";

const promptLine = (bridge, id) => bridge.eval(`
  const lines = (window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || []).filter((l) => l.trim());
  return (lines[lines.length - 1] ?? "").trimEnd();
`);
const overlay = (bridge, id) => bridge.eval(`
  const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(id)}) + '"]');
  const o = host?.closest(".terminal-pane-wrapper")?.querySelector(".suggestion-overlay") ?? document.querySelector(".suggestion-overlay");
  if (!o || !o.isConnected) return null;
  return { items: o.querySelectorAll(".suggestion-item").length, selected: o.querySelectorAll(".suggestion-item-selected").length };
`);
const up = (bridge, id) => domKey(bridge, id, { key: "ArrowUp", code: "ArrowUp" }, 38);
const down = (bridge, id) => domKey(bridge, id, { key: "ArrowDown", code: "ArrowDown" }, 40);
// Ctrl-C gives a fresh prompt (Ctrl-U would keep the shell's place in its history).
const ctrlC = (bridge, id) => domKey(bridge, id, { key: "c", code: "KeyC", ctrlKey: true }, 67);

async function run(bridge, id, command, token) {
  await bridge.typeInTerminal(id, `${command}\n`);
  await bridge.waitForTerminal(id, new RegExp(`^${token}$`), { timeoutMs: 20_000 });
  await sleep(800);
}

await runScenario(SCENARIO, async ({ log, assert, apps, evidenceDir }) => {
  if (platform() === "win32") {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "PowerShell keeps its own history and predictions (PSReadLine); Hermes draws no suggestion list there", log });
  }
  // On macOS, zsh (its default shell; a CI runner's account may use another).
  const env = platform() === "darwin" ? { SHELL: "/bin/zsh" } : {};
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log, env });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  log("step 1: a plain terminal; zsh keeps the user's own history file");
  let id = await createPlainTerminal(bridge, log);
  await bridge.typeInTerminal(id, `echo "SH=[$ZSH_VERSION] HF=[$HISTFILE] HOME=[$HOME]"\n`);
  const info = await bridge.waitFor("the shell's history settings", `
    const l = (window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || []).find((l) => /^SH=\\[/.test(l));
    return l ? l.trim() : null;
  `, { timeoutMs: 15_000 });
  log(`  ${info}`);
  const [, zsh, histfile, home] = info.match(/^SH=\[(.*?)\] HF=\[(.*?)\] HOME=\[(.*?)\]$/) ?? [];
  if (zsh) {
    assert(histfile === `${home}/.zsh_history`, `zsh writes history to ~/.zsh_history (HISTFILE=${JSON.stringify(histfile)})`);
  } else {
    log("  (not zsh: HISTFILE is the shell's own default)");
  }

  log("step 2: a command run in one terminal is on ↑ in the next one");
  await run(bridge, id, FIRST, FIRST.slice(5));
  await bridge.typeInTerminal(id, "exit\n");
  await sleep(1500);
  id = await createPlainTerminal(bridge, log);
  // The first terminal's last command was `exit`; the one before it, FIRST.
  await up(bridge, id);
  await sleep(600);
  const once = await promptLine(bridge, id);
  await up(bridge, id);
  await sleep(600);
  const recalled = await promptLine(bridge, id);
  log(`  prompt after ↑: ${JSON.stringify(once)}; after ↑↑: ${JSON.stringify(recalled)}`);
  assert(once.endsWith("exit"), "↑ in a new terminal recalls the previous terminal's last command (exit)");
  assert(recalled.endsWith(FIRST), "↑ again recalls the command before it");
  await bridge.screenshot(join(evidenceDir, "01-history-across-terminals.png"));
  await ctrlC(bridge, id);
  await sleep(400);

  log("step 3: with the suggestion list open, ↑ goes to the shell's history");
  await run(bridge, id, SECOND, SECOND.slice(5));
  await bridge.typeInTerminal(id, PREFIX);
  const open = await bridge.waitFor("the suggestion list", `
    const o = document.querySelector(".suggestion-overlay");
    return o && o.isConnected && o.querySelectorAll(".suggestion-item").length ? true : null;
  `, { timeoutMs: 10_000 });
  assert(open === true, "typing the start of a known command opens the suggestion list");
  await bridge.screenshot(join(evidenceDir, "02-list-open.png"));
  await up(bridge, id);
  await sleep(1200);
  const afterUp = { line: await promptLine(bridge, id), overlay: await overlay(bridge, id) };
  log(`  after ↑: ${JSON.stringify(afterUp)}`);
  await bridge.screenshot(join(evidenceDir, "03-after-up-with-list.png"));
  assert(afterUp.line.endsWith(SECOND), "the prompt holds the previous command from the shell's history");
  assert(afterUp.overlay === null, "the suggestion list is closed");
  await ctrlC(bridge, id);
  await sleep(400);

  log("step 4: the list closed with Esc stays closed after ↑");
  await bridge.typeInTerminal(id, PREFIX);
  await bridge.waitFor("the suggestion list", `
    const o = document.querySelector(".suggestion-overlay");
    return o && o.isConnected && o.querySelectorAll(".suggestion-item").length ? true : null;
  `, { timeoutMs: 10_000 });
  await domKey(bridge, id, { key: "Escape", code: "Escape" }, 27);
  await bridge.waitFor("the list to close", `return !document.querySelector(".suggestion-overlay") || null;`);
  await up(bridge, id);
  await sleep(1500);
  const afterEsc = { line: await promptLine(bridge, id), overlay: await overlay(bridge, id) };
  log(`  after ↑: ${JSON.stringify(afterEsc)}`);
  await bridge.screenshot(join(evidenceDir, "04-after-up-post-esc.png"));
  assert(afterEsc.line.endsWith(SECOND), "the prompt holds the previous command");
  assert(afterEsc.overlay === null, "no suggestion list opens for the text typed before ↑");
  await ctrlC(bridge, id);
  await sleep(400);

  log("step 5: ↓ still moves into the list");
  await bridge.typeInTerminal(id, PREFIX);
  await bridge.waitFor("the suggestion list", `
    const o = document.querySelector(".suggestion-overlay");
    return o && o.isConnected && o.querySelectorAll(".suggestion-item").length ? true : null;
  `, { timeoutMs: 10_000 });
  await down(bridge, id);
  await sleep(400);
  const afterDown = await overlay(bridge, id);
  log(`  after ↓: ${JSON.stringify(afterDown)}`);
  assert(afterDown && afterDown.selected === 1, "↓ highlights the first suggestion");
  await bridge.screenshot(join(evidenceDir, "05-down-into-list.png"));
});
