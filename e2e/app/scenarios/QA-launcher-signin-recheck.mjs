#!/usr/bin/env node
// QA-launcher-signin-recheck (NEWCOMER-04): Claude Code is signed out. On
// welcome step 3 the launcher says so; Sign in steps the welcome aside, the
// person signs in in the terminal, then "Back to setup": the launcher reads
// the sign-in afresh (not a cached answer) and Launch is enabled within a
// few seconds, at the latest after "Check again".
//
// Negative control: a build before the fix keeps saying "signed out" for up
// to two minutes (the capabilities cache), and Check again does not help.

import { join } from "node:path";
import { runLauncherQa, sleep, typeValue, welcomeToTaskStep } from "../qa-launcher-steps.mjs";

await runLauncherQa(
  "QA-launcher-signin-recheck",
  async ({ bridge, fx, log, check, evidenceDir }) => {
    await welcomeToTaskStep(bridge, fx.repo);
    await typeValue(bridge, ".task-launcher-task", "Add a contributing guide");
    await bridge.waitFor("the signed-out row", `return !!e2e.first('.task-launcher-block[data-kind="signed-out"]');`, { timeoutMs: 30_000 });
    await bridge.screenshot(join(evidenceDir, "01-signed-out.png"));
    await bridge.click(".task-launcher-sign-in");
    await bridge.waitFor("the setup pill", `return !!e2e.first(".setup-pill");`);
    fx.setFake("auth-claude", "in");
    log("  signed in (in the terminal); Back to setup");
    await bridge.click(".setup-resume");
    await bridge.waitFor("step 3 again", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task";`, { timeoutMs: 30_000 });
    const t0 = Date.now();
    let cleared = false;
    let pressed = false;
    while (Date.now() - t0 < 15_000) {
      cleared = await bridge.eval(`return !e2e.first('.task-launcher-block[data-kind="signed-out"]') && !!e2e.first(".setup-start-task") && !e2e.first(".setup-start-task").disabled;`);
      if (cleared) break;
      if (!pressed && Date.now() - t0 > 3000) {
        pressed = await bridge.eval(`const b = e2e.first('.task-launcher-block[data-kind="signed-out"] .task-launcher-recheck'); if (b) e2e.click(b); return !!b;`);
        if (pressed) {
          const label = await bridge.eval(`return e2e.norm(e2e.first('.task-launcher-block[data-kind="signed-out"] .task-launcher-recheck')?.innerText ?? "");`);
          log(`  pressed Check again (now: "${label}")`);
        }
      }
      await sleep(400);
    }
    log(`  the launcher took ${Date.now() - t0} ms to see the sign-in (Check again pressed: ${pressed})`);
    await bridge.screenshot(join(evidenceDir, "02-after-back.png"));
    check(cleared, "after signing in and Back to setup, the launcher no longer says Claude Code is signed out, and the task can start");
  },
  { welcome: false, before: (fx) => fx.setFake("auth-claude", "out") },
);
