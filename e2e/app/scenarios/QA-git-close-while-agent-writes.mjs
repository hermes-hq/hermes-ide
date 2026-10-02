#!/usr/bin/env node
// QA-git (QAGIT-12): closing a task while its terminal still writes stops it
// first, then saves — nothing written before the stop is lost, and no
// second "Close session?" follows the choice.
//
// The task's terminal runs a loop (the stand-in for an agent at work) that
// writes a file into the worktree every 100 ms and logs each write outside
// it. The dialog says the agent will be stopped before its changes are
// saved. After "Commit to session branch & close", every file the log names
// is in the commit on the task branch, and the worktree folder is gone.
//
// macOS and Linux only (the loop is a POSIX shell loop).
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// commit was a snapshot taken while the loop kept writing).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { skipScenario } from "../harness.mjs";
import {
  L,
  closeSessionByLabel,
  dialogText,
  endScenario,
  gitFixtures,
  launchTask,
  onWindows,
  scenarioContext,
  sessionLabel,
  sleep,
  waitSessionGone,
  worktreeInfo,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-close-while-agent-writes";
if (onWindows) skipScenario({ scenario: SCENARIO, reason: "the stand-in agent is a POSIX shell loop" });
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("agentwrites", log);
const writtenLog = join(fx.work, "written.log");

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);
  const r = await launchTask(bridge, { task: "Generate the fixtures", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);

  log("step 1: the fake agent quits; the task's shell starts writing");
  await bridge.waitForTerminal(r.sessionId, /fake-cli/, { timeoutMs: 30_000 }).catch(() => {});
  await sleep(1000);
  await bridge.typeInTerminal(r.sessionId, "q");
  await sleep(1500);
  const out = join(wt.worktreePath, "fixtures");
  await bridge.typeInTerminal(
    r.sessionId,
    `mkdir -p fixtures; n=0; while true; do f=$(printf 'fixture-%04d.json' $n); echo '{}' > fixtures/$f && echo $f >> '${writtenLog}'; n=$((n+1)); printf .; sleep 0.1; done\n`,
  );
  for (let i = 0; i < 50 && !existsSync(writtenLog); i++) await sleep(200);
  check(existsSync(out), "the loop writes into the task's worktree");
  await sleep(1000);

  log("step 2: close while it writes");
  await closeSessionByLabel(bridge, label);
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`, { timeoutMs: 15_000 });
  const dlg = await dialogText(bridge);
  log(`  dialog: ${dlg.slice(0, 400)}`);
  await bridge.screenshot(join(evidenceDir, "01-dialog.png"));
  check(dlg.includes("The agent is still working — it will be stopped before its changes are saved."), "the dialog says the work is stopped before it is saved");
  await sleep(1500); // the person reads the dialog; the loop keeps writing
  await bridge.clickByName("Commit to session branch & close", { within: ".dirty-wt-actions" });
  await sleep(300);
  check(!(await bridge.exists(".close-dialog")), "no second 'Close session?' follows the choice");
  await waitSessionGone(bridge, label);
  for (let i = 0; i < 100 && existsSync(wt.worktreePath); i++) await sleep(200);
  await bridge.screenshot(join(evidenceDir, "02-closed.png"));
  const stillAsking = await dialogText(bridge);
  if (stillAsking) log(`  the dialog still shows: ${stillAsking.slice(-400)}`);

  const written = readFileSync(writtenLog, "utf8").split("\n").filter(Boolean);
  const committed = fx.git("ls-tree", "-r", "--name-only", wt.branchName, "fixtures").split("\n").filter(Boolean).map((p) => p.split("/").pop());
  const lost = written.filter((f) => !committed.includes(f));
  log(`  written ${written.length}, committed ${committed.length}, not committed ${lost.length}: ${lost.slice(0, 8).join(", ")}`);
  check(written.length > 10, "the loop wrote files while the dialog was open");
  check(lost.length === 0, "every file written before the stop is in the commit");
  check(!existsSync(wt.worktreePath), "the worktree folder is gone");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
