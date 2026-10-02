#!/usr/bin/env node
// QA-git (QAGIT-06): Land lands into the branch the task was started from.
//
// A task launched as a new worktree cut from develop (the project folder
// stays on main) commits one file. The Land sheet says "Land into: develop",
// does not count develop's own commit as the task's work, and Squash-merge
// puts the task on develop; main never gets develop's DEVELOP.md. Picking
// main in "Land into" warns that develop's commit would come along.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// sheet landed into main and brought DEVELOP.md with it).

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  L,
  endScenario,
  gitAs,
  gitFixtures,
  launchTask,
  openLandSheet,
  readLandSheet,
  scenarioContext,
  sessionLabel,
  sleep,
  worktreeInfo,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-land-into-base";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("landbase", log);

let app;
let error;
try {
  const mainBefore = fx.git("rev-parse", "main");
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);

  log("step 1: a task as a new worktree cut from develop");
  const r = await launchTask(bridge, { task: "Add task notes", base: "develop", log });
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  check(existsSync(join(wt.worktreePath, "DEVELOP.md")), "the worktree starts from develop");
  writeFileSync(join(wt.worktreePath, "TASK.md"), "task notes\n");
  gitAs(wt.worktreePath, "add", "TASK.md");
  gitAs(wt.worktreePath, "commit", "-q", "-m", "task notes");

  log("step 2: the Land sheet");
  const label = await sessionLabel(bridge, r.sessionId);
  await openLandSheet(bridge, label);
  await bridge.waitFor("the merge option", `return /fast-forward|merge/i.test(e2e.first('.land-sheet-option[data-mode="merge"]')?.innerText ?? "");`, { timeoutMs: 15_000 }).catch(() => {});
  let sheet = await readLandSheet(bridge);
  log(`  sheet: ${JSON.stringify({ title: sheet.title, base: sheet.base, merge: sheet.merge })}`);
  await bridge.screenshot(join(evidenceDir, "01-land-sheet.png"));
  check(/into develop$/.test(sheet.title) && sheet.base === "develop", `the sheet lands into develop ("${sheet.title}", Land into: ${sheet.base})`);
  check(!/DEVELOP\.md/.test(sheet.text), "develop's own commit (DEVELOP.md) is not counted as the task's work");
  check(!/This task was started from/.test(sheet.text), "no mismatch warning while landing into develop");

  log("step 3: picking main warns about develop's commit");
  await bridge.eval(`const s = e2e.first("#land-sheet-base"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "main"); s.dispatchEvent(new Event("change", { bubbles: true })); return true;`);
  await bridge.waitFor("the mismatch warning", `return !!e2e.first(".land-sheet-base-mismatch");`, { timeoutMs: 15_000 });
  sheet = await readLandSheet(bridge);
  const warn = await bridge.eval(`return e2e.norm(e2e.first(".land-sheet-base-mismatch").innerText);`);
  log(`  warning: ${warn}`);
  await bridge.screenshot(join(evidenceDir, "02-into-main.png"));
  check(warn === "This task was started from develop. Landing into main would also bring develop's 1 commit.", "the warning names develop and its 1 commit");
  check(/into main$/.test(sheet.title), "the sheet now lands into main");

  log("step 4: back to develop, Squash-merge");
  await bridge.eval(`const s = e2e.first("#land-sheet-base"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "develop"); s.dispatchEvent(new Event("change", { bubbles: true })); return true;`);
  await bridge.waitFor("develop again", `return !e2e.first(".land-sheet-base-mismatch") && /into develop$/.test(e2e.norm(e2e.first(".land-sheet-title")?.innerText ?? ""));`, { timeoutMs: 15_000 });
  await bridge.clickWhenReady(`const i = e2e.first('.land-sheet-option[data-mode="merge"] input'); return i ? (i.checked || e2e.click(i)) : false;`);
  await sleep(300);
  await bridge.click(".land-sheet-land");
  const landed = await bridge.waitFor("the result", `const r = e2e.first('.land-sheet-result'); return r ? e2e.norm(r.innerText) : null;`, { timeoutMs: 30_000 }).catch(() => null);
  log(`  result: ${landed}`);
  await bridge.screenshot(join(evidenceDir, "03-landed.png"));
  check(fx.git("rev-parse", "main") === mainBefore, "main did not move");
  check(!fx.git("ls-tree", "--name-only", "main").includes("DEVELOP.md"), "main never receives develop's DEVELOP.md");
  check(fx.git("ls-tree", "--name-only", "develop").includes("TASK.md"), "develop has the task's work");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
