#!/usr/bin/env node
// QA-git (QAGIT-03): Abort Merge after a conflicting Pull asks first, and
// keeps uncommitted edits the merge never touched.
//
// The project folder (main) has an uncommitted NOTES.md edit; local main and
// origin/main changed README.md's same line, so Pull stops with a conflict
// in README.md. "Abort Merge" asks "Abort the merge? …"; Cancel changes
// nothing; confirming runs `git merge --abort`: README.md is back to the
// local commit and the NOTES.md edit is still there.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (Abort
// was a hard reset with no confirmation, and NOTES.md lost the edit).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  L,
  endScenario,
  fakeAgents,
  gitEnv,
  gitIn,
  launch,
  launchTask,
  makeRepo,
  openReviewDesk,
  rmrf,
  scenarioContext,
  sessionLabel,
  sleep,
  tmpWork,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-abort-merge-keeps-edits";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;

const work = tmpWork("abort");
const fakes = fakeAgents(work);
const remote = join(work, "origin.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: gitEnv });
const repo = makeRepo(join(work, "mono"), { files: { "README.md": "# mono\n\nline\n", "NOTES.md": "notes\n" } });
gitIn(repo, "remote", "add", "origin", remote);
gitIn(repo, "push", "-q", "-u", "origin", "main");
const mate = join(work, "teammate");
execFileSync("git", ["clone", "-q", remote, mate], { env: gitEnv });
writeFileSync(join(mate, "README.md"), "# mono\n\nteammate's line\n");
gitIn(mate, "commit", "-q", "-am", "teammate readme");
gitIn(mate, "push", "-q", "origin", "main");
const homeDir = join(work, "home");

const deskButton = (bridge, re) =>
  bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".review-desk button").find((b) => ${re}.test(e2e.nameOf(b))), ${JSON.stringify(String(re))}));`);

let app;
let error;
try {
  app = await launch({ evidenceDir, homeDir, log, fakes });
  const { bridge } = app;
  await L.completeTaskWelcome(bridge, repo);
  const r = await launchTask(bridge, { task: "Review the readme", where: "current-checkout", log });
  const label = await sessionLabel(bridge, r.sessionId);
  writeFileSync(join(repo, "README.md"), "# mono\n\nmy line\n");
  gitIn(repo, "commit", "-q", "-am", "my readme");
  const EDIT = "notes\n\nan hour of uncommitted notes\n";
  writeFileSync(join(repo, "NOTES.md"), EDIT);
  const mineHead = gitIn(repo, "rev-parse", "HEAD");

  log("step 1: Pull stops with a conflict in README.md");
  await openReviewDesk(bridge, label);
  await bridge.waitFor("the Pull button", `return e2e.all(".review-desk button").some((b) => /^Pull/.test(e2e.nameOf(b)));`, { timeoutMs: 20_000 });
  await deskButton(bridge, /^Pull/);
  await bridge.waitFor("the Abort Merge button", `return e2e.all(".review-desk button").some((b) => /Abort Merge/.test(e2e.nameOf(b)));`, { timeoutMs: 30_000 });
  check(readFileSync(join(repo, "NOTES.md"), "utf8") === EDIT, "the NOTES.md edit survives the conflicting Pull");

  log("step 2: Abort Merge asks first; Cancel changes nothing");
  await deskButton(bridge, /Abort Merge/);
  const ask = await bridge.waitFor("the confirmation", `const d = e2e.first(".git-abort-confirm"); return d ? e2e.norm(d.innerText) : null;`, { timeoutMs: 10_000 });
  log(`  asks: ${ask}`);
  await bridge.screenshot(join(evidenceDir, "01-abort-confirm.png"));
  check(ask.includes("Abort the merge? Files changed by the merge go back to before the pull; your other uncommitted changes stay."), "the confirmation says what Abort does and keeps");
  await bridge.click(".git-abort-confirm .git-abort-cancel");
  await sleep(800);
  check(gitIn(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD") !== "", "Cancel leaves the merge in progress");

  log("step 3: Abort Merge → Abort the merge");
  await deskButton(bridge, /Abort Merge/);
  await bridge.waitFor("the confirmation", `return !!e2e.first(".git-abort-confirm");`, { timeoutMs: 10_000 });
  await bridge.click(".git-abort-confirm .git-abort-yes");
  await bridge.waitFor("the merge to end", `return !e2e.all(".review-desk button").some((b) => /Abort Merge/.test(e2e.nameOf(b)));`, { timeoutMs: 20_000 });
  await sleep(500);
  await bridge.screenshot(join(evidenceDir, "02-after-abort.png"));
  log(`  status after Abort: ${JSON.stringify(gitIn(repo, "status", "--short"))}`);
  check(readFileSync(join(repo, "NOTES.md"), "utf8") === EDIT, "the unrelated uncommitted NOTES.md edit survives Abort Merge");
  check(readFileSync(join(repo, "README.md"), "utf8") === "# mono\n\nmy line\n", "README.md is back to the local commit");
  check(gitIn(repo, "rev-parse", "HEAD") === mineHead, "HEAD is where it was before the Pull");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => rmrf(work) });
