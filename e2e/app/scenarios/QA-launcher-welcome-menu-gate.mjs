#!/usr/bin/env node
// QA-launcher-welcome-menu-gate (NEWCOMER-02): first launch, the welcome is
// open and the Privacy Policy is not accepted. The menu bar (File > New
// Session, File > New Tab, Settings) does nothing behind it: no task sheet
// opens under it, no shell starts before the policy is accepted, and the
// keyboard stays in the welcome, which says "Finish setup first". Help
// still works.
//
// Negative control: a build before the fix opens the task sheet behind the
// welcome and starts a shell.

import { join } from "node:path";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa(
  "QA-launcher-welcome-menu-gate",
  async ({ bridge, log, check, evidenceDir }) => {
    await bridge.waitFor("the three-step welcome", `return !!e2e.first(".setup-dialog");`, { timeoutMs: 60_000 });
    await bridge.waitFor("the welcome's agent check", `return e2e.first(".agent-doctor")?.getAttribute("data-loading") === "false";`, { timeoutMs: 60_000 });
    check((await bridge.eval(`return e2e.first("#setup-policy-accept").checked;`)) === false, "the Privacy Policy is not accepted yet");
    await bridge.chooseMenuItem("file.new-session");
    await sleep(1200);
    const s1 = await bridge.eval(`return {
      sheet: !!e2e.first(".task-launcher-sheet"),
      focusInWelcome: !!document.activeElement?.closest?.(".setup-dialog"),
      nudge: e2e.norm(e2e.first(".setup-nudge")?.innerText ?? ""),
    };`);
    log(`  after File > New Session: ${JSON.stringify(s1)}`);
    await bridge.screenshot(join(evidenceDir, "01-new-session-under-welcome.png"));
    check(!s1.sheet, "File > New Session opens no task sheet under the unfinished welcome");
    check(s1.focusInWelcome, "the keyboard stays in the welcome");
    check(s1.nudge === "Finish setup first", "the welcome says why nothing happened");
    await bridge.chooseMenuItem("file.new-session-tab");
    await bridge.chooseMenuItem("hermes.settings");
    await sleep(2500);
    const terms = await bridge.terminalIds();
    const settings = await bridge.exists(".settings-title");
    log(`  terminals after File > New Tab: ${terms.length}; Settings open: ${settings}`);
    check(terms.length === 0, "File > New Tab starts no shell before the Privacy Policy is accepted");
    check(!settings, "Settings does not open behind the welcome");
    await bridge.screenshot(join(evidenceDir, "02-after-menu-keys.png"));
  },
  { welcome: false },
);
