#!/usr/bin/env node
// QA-review-commit-draft (QAGIT-21): the Review Desk's commit box on a
// "Current checkout" session (branch main) starts empty. It was pre-filled
// with "Main" — the branch name, humanized — a meaningless commit subject
// one click away. (A task's own hermes/<slug> branch keeps the draft made
// from its turns.)
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp } from "../harness.mjs";
import { L, fakeAgents, launchTask, mkRepo, mkWork, onWindows, openReviewDesk, runScenario, sessionCwd, sleep } from "../review-steps.mjs";

await runScenario("QA-review-commit-draft", async ({ evidenceDir, log, check }) => {
  const work = mkWork("draft");
  const { repo } = mkRepo(join(work, "demo-repo"), { "math.js": "export const sub = (a, b) => a - b;\n" });
  const fake = fakeAgents(work);
  const env = { ...fake.env, ...(process.env.HERMES_E2E_FREE_SPACE_BYTES ? { HERMES_E2E_FREE_SPACE_BYTES: process.env.HERMES_E2E_FREE_SPACE_BYTES } : {}) };
  const app = await launchApp(
    onWindows
      ? { runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, flagDefaults: null, env }
      : { runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir: join(work, "home"), flagDefaults: null, env },
  );
  try {
    const { bridge } = app;
    await L.completeTaskWelcome(bridge, repo);
    const sid = await launchTask(bridge, repo, "Look around", { currentCheckout: true });
    log(`session ${sid} in ${await sessionCwd(bridge, sid)}`);
    writeFileSync(join(repo, "README.md"), "# demo\n\nedited\n");
    await openReviewDesk(bridge);
    await bridge.waitFor("the commit box", `return !!e2e.first(".review-desk textarea");`, { timeoutMs: 20_000 });
    await sleep(1000);
    const msg = await bridge.eval(`return e2e.first(".review-desk textarea").value;`);
    log(`commit box: ${JSON.stringify(msg)}`);
    await bridge.screenshot(join(evidenceDir, "commit-box.png"));
    check(msg.trim() === "", "on main the commit box starts empty (no 'Main')");
  } finally {
    if (app.isRunning()) await app.stop();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
