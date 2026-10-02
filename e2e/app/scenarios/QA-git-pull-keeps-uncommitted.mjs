#!/usr/bin/env node
// QA-git (QAGIT-01): Pull in the Review Desk never throws away uncommitted
// edits.
//
// A task works on the current checkout (main) with an uncommitted edit in
// README.md; a teammate pushed one commit to origin/main.
//   1. The teammate's commit adds NEWS.md only: Pull fast-forwards, NEWS.md
//      arrives and the README.md edit is still there.
//   2. The teammate's next commit changes README.md too: Pull stops, says
//      which file is in the way, and the edit is still there (main has not
//      moved).
//
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// fast-forward was a forced checkout that reset README.md).
//
//   node e2e/app/build.mjs && node e2e/app/scenarios/QA-git-pull-keeps-uncommitted.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

const SCENARIO = "QA-git-pull-keeps-uncommitted";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;

const work = tmpWork("pull");
const fakes = fakeAgents(work);
const remote = join(work, "origin.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: gitEnv });
const repo = makeRepo(join(work, "mono"), { files: { "README.md": "# mono\n\nline\n" } });
gitIn(repo, "remote", "add", "origin", remote);
gitIn(repo, "push", "-q", "-u", "origin", "main");
const mate = join(work, "teammate");
execFileSync("git", ["clone", "-q", remote, mate], { env: gitEnv });
const matePush = (file, content, msg) => {
  writeFileSync(join(mate, file), content);
  gitIn(mate, "add", file);
  gitIn(mate, "commit", "-q", "-m", msg);
  gitIn(mate, "push", "-q", "origin", "main");
};
matePush("NEWS.md", "teammate news\n", "news");
const homeDir = join(work, "home");

/** Pull, then this Pull's result: messages other than the ones a previous Pull left on screen. */
async function pressPull(bridge, previous = []) {
  await bridge.waitFor("the Pull button", `return e2e.all(".review-desk button").some((b) => /^Pull/.test(e2e.nameOf(b)));`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".review-desk button").find((b) => /^Pull/.test(e2e.nameOf(b))), "Pull"));`);
  return bridge
    .waitFor("the Pull result", `const old = ${JSON.stringify(previous)}; const m = e2e.all(".review-desk .git-error, .review-desk .review-changes-toast, .review-desk .review-notice").map((x) => e2e.norm(x.innerText)).filter((t) => t && !old.includes(t)); return m.length ? m : null;`, { timeoutMs: 30_000 })
    .catch(() => []);
}

let app;
let error;
try {
  app = await launch({ evidenceDir, homeDir, log, fakes });
  const { bridge } = app;
  await L.completeTaskWelcome(bridge, repo);
  log("step 1: a task on the current checkout (main), README.md edited and not committed");
  const r = await launchTask(bridge, { task: "Review the readme", where: "current-checkout", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const EDIT = "# mono\n\nline\n\nan uncommitted edit — an hour of work\n";
  writeFileSync(join(repo, "README.md"), EDIT);

  log("step 2: Pull (the incoming commit adds NEWS.md only)");
  await openReviewDesk(bridge, label);
  const msg1 = await pressPull(bridge);
  log(`  after Pull: ${JSON.stringify(msg1)}`);
  await bridge.screenshot(join(evidenceDir, "01-after-pull.png"));
  check(readFileSync(join(repo, "README.md"), "utf8") === EDIT, "the uncommitted README.md edit survives a fast-forward Pull");
  check(existsSync(join(repo, "NEWS.md")), "the incoming NEWS.md arrived");
  check(gitIn(repo, "rev-parse", "main") === gitIn(repo, "rev-parse", "origin/main"), "main fast-forwarded to origin/main");

  log("step 3: the teammate changes README.md as well; Pull again");
  matePush("README.md", "# mono\n\nteammate's line\n", "readme");
  const mainBefore = gitIn(repo, "rev-parse", "main");
  await sleep(500);
  const msg2 = await pressPull(bridge, msg1);
  log(`  after the second Pull: ${JSON.stringify(msg2)}`);
  await bridge.screenshot(join(evidenceDir, "02-pull-stopped.png"));
  check(readFileSync(join(repo, "README.md"), "utf8") === EDIT, "the README.md edit survives a Pull whose commits also change README.md");
  check(gitIn(repo, "rev-parse", "main") === mainBefore, "main did not move");
  const said = msg2.join(" ");
  check(/Pull stopped: README\.md has uncommitted changes that the incoming commits also change/.test(said), `the stop names README.md in plain words (got "${said}")`);
  check(!/stash/i.test(said), "the message never suggests git stash");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => rmrf(work) });
