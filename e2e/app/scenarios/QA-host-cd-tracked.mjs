#!/usr/bin/env node
// QA-host-cd-tracked (CHAOS-06) — `cd` in a plain zsh or bash terminal used
// to go unnoticed: the session kept its start folder (status bar, worktree
// auto-attach, restore). EXPECT: Hermes's shell integration reports the
// folder (OSC 7) after every cd, also for a folder with a space and a
// non-ASCII letter in its name.
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, onWindows, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-cd-tracked";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "the zsh/bash integration (PowerShell reports its folder through OSC 9;9)", log });
  const { fx, bridge } = await startApp("qa-cd", evidenceDir, log, onCleanup, apps);
  const dir = join(realpathSync(fx.work), "work dir", "démo-project");
  mkdirSync(dir, { recursive: true });
  const id = await newTerminal(bridge, "cd");
  await bridge.typeInTerminal(id, `cd '${dir}' && echo moved-ok\n`);
  await bridge.waitForTerminal(id, /^moved-ok/);
  let wd = "";
  for (let i = 0; i < 20; i++) {
    wd = (await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((s) => s.id === ${JSON.stringify(id)})?.working_directory || "";`)) || "";
    if (wd.normalize("NFC") === dir.normalize("NFC")) break;
    await sleep(250);
  }
  const shell = await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((s) => s.id === ${JSON.stringify(id)})?.shell || "";`);
  log(`  shell ${shell}; session folder after cd: ${wd}`);
  await bridge.screenshot(join(evidenceDir, "01-after-cd.png"));
  assert(wd.normalize("NFC") === dir.normalize("NFC"), "the session's folder follows `cd`, spaces and accents included");
});
