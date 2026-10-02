#!/usr/bin/env node
// QA-host-quit-no-host (XP-05) — without the session host (Windows, or the
// flag off), quitting with a busy terminal used to end it without a word:
// the question was asked only for hosted sessions. EXPECT: "1 program is
// running. Quitting stops it." with Stop and quit and Cancel and
// no Keep running; Cancel keeps the app open; Stop and quit ends it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, pidAlive, quitAndReadQuestion, runNodeIn, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-quit-no-host";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, app, bridge } = await startApp("qa-nohost", evidenceDir, log, onCleanup, apps, { flagDefaults: { taskLauncher: false, sessionHost: false } });
  const state = join(fx.work, "streamer.json");
  let pid = null;
  onCleanup(() => {
    if (pid && pidAlive(pid)) process.kill(pid);
  });
  const sid = await newTerminal(bridge, "long job");
  const streamer = join(REPO_ROOT, "e2e", "app", "fixtures", "streamer.mjs");
  await runNodeIn(bridge, sid, streamer, [state]);
  for (let i = 0; i < 60 && !existsSync(state); i++) await sleep(100);
  pid = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).pid : null;
  await sleep(2000);
  log(`  streamer pid ${pid}`);

  const question = await quitAndReadQuestion(app);
  log(`  quit question: ${question ?? "(none)"}`);
  assert(!!question, "quitting with a busy terminal asks first");
  await bridge.screenshot(join(evidenceDir, "01-question.png"));
  assert(/1 program is running\. Quitting stops it\./.test(question), "it says quitting stops it");
  assert(!(await bridge.exists(".quit-dialog-btn-keep")), "it offers no Keep running without the session host");

  await bridge.click('[data-testid="quit-with-agents-dialog"] .quit-dialog-btn');
  await sleep(1000);
  assert(app.isRunning() && !(await bridge.exists('[data-testid="quit-with-agents-dialog"]')), "Cancel keeps Hermes open");
  assert(pid !== null && pidAlive(pid), "and the program running");

  const again = await quitAndReadQuestion(app);
  assert(!!again, "quitting again asks again");
  await bridge.click('[data-testid="quit-with-agents-dialog"] .quit-dialog-btn-stop');
  const exit = await app.stop({ stopPrograms: false });
  log(`  app exited: ${JSON.stringify(exit)}`);
  await sleep(1500);
  assert(!pidAlive(pid), "Stop and quit ended the program with the app");
});
