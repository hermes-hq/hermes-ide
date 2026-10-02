#!/usr/bin/env node
// QA-launcher-launch-next-keeps-typing (SOLO-01): Launch & next (⌘⏎), and
// while the first task is still starting the next one is typed. The text
// typed during "Launching…" stays in the field; only the launched text is
// cleared. A slow terminal start (HERMES_E2E_SLOW_SPAWN_MS) holds the
// launch open long enough to type into it on every machine.
//
// Negative control: a build before the fix clears the field when the
// in-flight launch ends (the next task is lost).

import { MOD, openLauncher, typeInto, waitLaunchEnabled } from "../launcher-steps.mjs";
import { focusState, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa(
  "QA-launcher-launch-next-keeps-typing",
  async ({ bridge, fx, log, check, evidenceDir }) => {
    await openLauncher(bridge);
    await typeInto(bridge, ".task-launcher-task", "Fix the flaky login test");
    await waitLaunchEnabled(bridge);
    const r = await bridge.eval(`
      const ta = e2e.first(".task-launcher-task");
      ta.focus();
      const set = (v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, v); ta.dispatchEvent(new Event("input", { bubbles: true })); };
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...${JSON.stringify(MOD)} }));
      await new Promise((r) => setTimeout(r, 60));
      const launching = /Launching/.test(e2e.first(".task-launcher-launch")?.innerText ?? "");
      set("Rename formatDate to formatDay");
      return { launching };
    `);
    log(`  launching while the next task was typed: ${r.launching}`);
    check(r.launching, "the first launch was still running while the next task was typed");
    await bridge.waitFor("the first launch to finish", `return /Fix the flaky login test/.test(e2e.first(".task-launcher-launched")?.innerText ?? "");`, { timeoutMs: 45_000 });
    await sleep(600);
    const after = await bridge.eval(`return { value: e2e.first(".task-launcher-task").value, where: e2e.norm(e2e.first('[data-chip="where"]')?.innerText ?? "") };`);
    log(`  after the launch finished: ${JSON.stringify(after)}`);
    check(after.value === "Rename formatDate to formatDay", "the next task typed during the launch is still in the field");
    check(/hermes\/rename-formatdate-to-formatday/.test(after.where), "and it gets its own branch");
    check((await focusState(bridge)).task, "the keyboard is in the task field");
    await fx.waitForRecords(1, 30_000);
    await bridge.screenshot(`${evidenceDir}/01-next-task-kept.png`);

    // Nothing typed during the launch: the field is cleared for the next task, as before.
    await bridge.eval(`
      const ta = e2e.first(".task-launcher-task"); ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...${JSON.stringify(MOD)} }));
      return true;`);
    await bridge.waitFor("the second launch to finish", `return /Rename formatDate/.test(e2e.first(".task-launcher-launched")?.innerText ?? "");`, { timeoutMs: 45_000 });
    await sleep(400);
    const cleared = await bridge.eval(`return e2e.first(".task-launcher-task").value;`);
    check(cleared === "", "with nothing typed meanwhile, Launch & next leaves an empty field for the next task");
  },
  { env: { HERMES_E2E_SLOW_SPAWN_MS: "1500" } },
);
