#!/usr/bin/env node
// QA-git (QAGIT-17): Land never squash-merges over an uncommitted edit in
// the project folder, and says so in plain words.
//
// The task changed README.md and committed it; the project folder (on main)
// has its own uncommitted README.md edit. The Land sheet's merge option is
// disabled with "README.md has uncommitted changes in the project folder
// (main)." — never "stash" — and main and the edit are untouched. An
// unrelated dirty file does not block it.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// merge was offered and failed with git's own text advising stash).

import { readFileSync, writeFileSync } from "node:fs";
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

const SCENARIO = "QA-git-land-into-dirty-folder";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("landdirty", log);

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);
  const r = await launchTask(bridge, { task: "Polish the readme", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  writeFileSync(join(wt.worktreePath, "README.md"), "# launcher-repo\n\npolished by the agent\n");
  gitAs(wt.worktreePath, "commit", "-q", "-am", "polish");
  const MINE = "# launcher-repo\n\nmy own uncommitted edit\n";
  writeFileSync(join(fx.repo, "README.md"), MINE);
  writeFileSync(join(fx.repo, "SCRATCH.md"), "an unrelated scratch file\n");
  const mainBefore = fx.git("rev-parse", "main");

  await openLandSheet(bridge, label);
  await sleep(1500);
  const sheet = await readLandSheet(bridge);
  log(`  merge option: ${JSON.stringify(sheet.merge)}`);
  await bridge.screenshot(join(evidenceDir, "01-sheet.png"));
  check(sheet.merge?.disabled === true, "the merge option is disabled");
  check((sheet.merge?.text ?? "").includes("README.md has uncommitted changes in the project folder (main)."), "it names the file and where it is");
  check(!/stash/i.test(sheet.text), "nothing on the sheet suggests git stash");
  check(!/SCRATCH\.md/.test(sheet.merge?.text ?? ""), "an unrelated dirty file is not named");
  check(readFileSync(join(fx.repo, "README.md"), "utf8") === MINE, "the uncommitted README.md edit is untouched");
  check(fx.git("rev-parse", "main") === mainBefore, "main did not move");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
