#!/usr/bin/env node
// Scenario (fix): the line Hermes types to start an agent never lands in the
// user's saved shell history, while what the person types does. A typed
// vendor command can carry the user's custom prefix (an inline key), and a
// terminal's history is the user's own (~/.zsh_history).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-launch-line-not-in-history.mjs
//
//   1. start a (fake) Claude Code session; Hermes types its launch line
//   2. stop the agent with Ctrl-C, run a command of one's own, leave the shell
//   3. EXPECT: ~/.zsh_history holds the person's command and no "hi run"

import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { claude, startApp, write } from "../qa-host-steps.mjs";

const SCENARIO = "FIX-launch-line-not-in-history";
const MINE = `echo hermes-mine-${Date.now().toString(36)}`;

const screen = (bridge, id) => bridge.eval(`return (window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || []).join("\\n");`);

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (platform() !== "darwin") {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "checks zsh's saved history; zsh is the default shell only on macOS", log });
  }
  // zsh, macOS's default shell (a CI runner's account may use another).
  const { fx, bridge } = await startApp("launch-hist", evidenceDir, log, onCleanup, apps, { env: { SHELL: "/bin/zsh" } });

  log("step 1: a Claude Code session; Hermes types its launch line");
  const id = await claude(bridge, fx, fx.repo, "launch-hist", 1);
  await sleep(1500);

  log("step 2: stop the agent, run a command of one's own, leave the shell");
  await write(bridge, id, "\x03");
  await sleep(1500);
  await write(bridge, id, "echo \"HOMEIS=[$HOME] SH=[$ZSH_VERSION]\"\r");
  const info = await bridge.waitFor("the shell's home folder", `
    const l = (window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || []).find((l) => /^HOMEIS=\\[/.test(l.trim()));
    return l ? l.trim() : null;
  `, { timeoutMs: 15_000 });
  log(`  ${info}`);
  const [, home, zsh] = info.match(/^HOMEIS=\[(.*?)\] SH=\[(.*?)\]$/) ?? [];
  if (!zsh) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "the session's shell is not zsh", log });
  await write(bridge, id, `${MINE}\r`);
  await sleep(800);
  await bridge.screenshot(join(evidenceDir, "01-session.png"));
  log(`  screen:\n${(await screen(bridge, id)).split("\n").filter((l) => l.trim()).slice(-8).join("\n")}`);
  await write(bridge, id, "exit\r");

  log("step 3: the saved history");
  const file = join(home, ".zsh_history");
  const saved = await (async () => {
    for (let i = 0; i < 50; i++) {
      if (existsSync(file) && readFileSync(file, "utf8").includes(MINE)) return readFileSync(file, "utf8");
      await sleep(200);
    }
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  })();
  log(`  ~/.zsh_history:\n${saved.trim()}`);
  assert(saved.includes(MINE), "the person's own command is saved");
  assert(!/hi run|claude/.test(saved), "Hermes's launch line is not saved");
});
