#!/usr/bin/env node
// QA-git (QAGIT-22, PLN-21, PLN-16, PLN-17): what the Land sheet offers and
// drafts.
//
//   (a) No remote: the pull request option says only "This repository has
//       no remote. Add one (git remote add origin <url>) to open a pull
//       request." — never also "gh auth login".
//   (b) The drafted commit subject is the task as typed ("Notizen
//       ergänzen"), not the branch slug ("Notizen erganzen").
//   (c) "Archive…" with an agent running asks "Archive: stop <agent> in this
//       session and remove the worktree folder (the branch is kept)?";
//       Cancel keeps the session and its folder.
//   (d) origin on GitLab (gh signed in to github.com only): the pull request
//       option is disabled with "origin isn't a GitHub repository." and the
//       sheet picks the local squash-merge.
//
// A stand-in gh (e2e/app/fixtures/fake-gh.mjs) answers; no network.
// Negative control: a build from before the fix ends in RESULT: FAIL.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  L,
  endScenario,
  gitAs,
  gitEnv,
  gitFixtures,
  launchTask,
  openLandSheet,
  readLandSheet,
  scenarioContext,
  sessionLabel,
  sleep,
  worktreeInfo,
  onWindows,
} from "../qa-git-steps.mjs";
import { skipScenario } from "../harness.mjs";

const SCENARIO = "QA-git-land-sheet-polish";
if (onWindows) skipScenario({ scenario: SCENARIO, reason: "url.<path>.insteadOf with a Windows path is not part of this check" });
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("landpolish", log);
const FAKE_GH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-gh.mjs");
const ghState = join(fx.work, "gh-state.json");
writeFileSync(ghState, JSON.stringify({ signedIn: true }));
const ghEnv = { HERMES_E2E_GH: FAKE_GH, FAKE_GH_STATE: ghState, FAKE_GH_LOG: join(fx.work, "gh.jsonl") };

const closeSheet = async (bridge) => {
  if (await bridge.exists(".land-sheet")) await bridge.click(".land-sheet-cancel").catch(() => {});
  await sleep(500);
  // Cancel brings the person back to the Review Desk the sheet was opened
  // from (QA-review-14): close it too, so the session list is reachable.
  if (await bridge.exists(".review-desk")) await bridge.click(".review-desk .review-close").catch(() => {});
};

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir, 1, { env: ghEnv });
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);
  const r = await launchTask(bridge, { task: "Notizen ergänzen", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  writeFileSync(join(wt.worktreePath, "NOTIZEN.md"), "Notizen\n");
  gitAs(wt.worktreePath, "add", ".");
  gitAs(wt.worktreePath, "commit", "-q", "-m", "Notizen");

  log("(a)+(b) no remote; the drafted subject");
  await openLandSheet(bridge, label);
  await sleep(2500);
  let sheet = await readLandSheet(bridge);
  log(`  PR option: ${JSON.stringify(sheet.pr)}; message: ${JSON.stringify(sheet.message)}`);
  await bridge.screenshot(join(evidenceDir, "01-no-remote.png"));
  check((sheet.pr?.text ?? "").includes("This repository has no remote. Add one (git remote add origin <url>) to open a pull request."), "the PR option says the repository has no remote, and how to add one");
  check(!/gh auth login|Sign in/i.test(sheet.pr?.text ?? ""), "it does not also ask to sign in to gh");
  check((sheet.message ?? "").split("\n")[0] === "Notizen ergänzen", `the draft subject is the task as typed (${JSON.stringify((sheet.message ?? "").split("\n")[0])})`);

  log("(c) Archive… asks while the agent runs");
  await bridge.click(".land-sheet-archive");
  const ask = await bridge.waitFor("the archive question", `const d = e2e.first(".land-sheet-archive-confirm"); return d ? e2e.norm(d.innerText) : null;`, { timeoutMs: 10_000 }).catch(() => null);
  log(`  asks: ${ask}`);
  await bridge.screenshot(join(evidenceDir, "02-archive-confirm.png"));
  check(!!ask && /^Archive: stop .+ in this session and remove the worktree folder \(the branch is kept\)\?/.test(ask), "Archive… asks before stopping the agent");
  if (ask) await bridge.click(".land-sheet-archive-cancel");
  await sleep(800);
  check((await bridge.terminalIds()).includes(r.sessionId) && existsSync(wt.worktreePath), "Cancel keeps the session and its folder");
  await closeSheet(bridge);

  log("(d) origin on GitLab");
  const bare = join(fx.work, "gitlab-remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare], { env: gitEnv });
  const url = "git@gitlab.example.com:team/launcher-repo.git";
  fx.git("config", `url.${bare}.insteadOf`, url);
  fx.git("remote", "add", "origin", url);
  await openLandSheet(bridge, label);
  await bridge.waitFor("the gh check", `return !/Checking GitHub CLI/.test(e2e.first('.land-sheet-option[data-mode="pr"]')?.innerText ?? "");`, { timeoutMs: 20_000 });
  await sleep(800);
  sheet = await readLandSheet(bridge);
  log(`  PR option: ${JSON.stringify(sheet.pr)}; merge: ${JSON.stringify(sheet.merge)}`);
  await bridge.screenshot(join(evidenceDir, "03-gitlab-origin.png"));
  check(sheet.pr?.disabled === true && (sheet.pr?.text ?? "").includes("origin isn't a GitHub repository."), "the PR option is disabled: origin isn't a GitHub repository");
  check(sheet.merge?.checked === true, "the sheet picks the local squash-merge");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
