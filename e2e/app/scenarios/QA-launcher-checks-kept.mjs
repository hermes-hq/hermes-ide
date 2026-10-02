#!/usr/bin/env node
// QA-launcher-checks-kept (PLN-10, the launcher's half): the checks typed in
// the launcher's "+ options → Checks" are kept for the task's worktree,
// in its own git folder (<git-dir>/hermes/done-when.json), never inside
// the repository (nothing to commit), so `hi check` can run them for that
// worktree.
//
// Negative control: a build before the fix keeps them only in the launch
// record; no file next to the worktree.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expandOptions, invoke, newTerminals, openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

const CHECK = 'node -e "process.exit(3)"';

await runLauncherQa("QA-launcher-checks-kept", async ({ bridge, fx, log, check, assert, evidenceDir }) => {
  const project = (await invoke(bridge, "get_projects_ordered")).find((p) => fx.samePath(p.path, fx.repo));
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Add an add function");
  await expandOptions(bridge);
  // The repository's own check (npm test) is listed once the repository was
  // read; a second one is added.
  await bridge.waitFor("the repository's check", `return e2e.all(".task-launcher-check-input").some((c) => c.value === "npm test");`, { timeoutMs: 20_000 });
  await bridge.click(".task-launcher-check-add");
  await bridge.waitFor("the new check field", `return e2e.all(".task-launcher-check-input").length === 2;`);
  await bridge.eval(`
    const el = e2e.all(".task-launcher-check-input")[1];
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(CHECK)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;`);
  await waitLaunchEnabled(bridge);
  const before = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  const [sid] = await newTerminals(bridge, before, 1, "the task's terminal");
  await fx.waitForRecords(1);
  await sleep(2000);
  const wt = await invoke(bridge, "git_session_worktree_info", { sessionId: sid, projectId: project.id });
  assert(wt && !wt.isMainWorktree, "the task runs in its own worktree");
  let gitDir = execFileSync("git", ["-C", wt.worktreePath, "rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
  if (!isAbsolute(gitDir)) gitDir = join(wt.worktreePath, gitDir);
  const file = join(gitDir, "hermes", "done-when.json");
  const body = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  log(`  ${file}: ${JSON.stringify(body)}`);
  check(JSON.stringify(body?.done_when) === JSON.stringify(["npm test", CHECK]), "the task's checks are kept in the worktree's git folder, in order");
  const status = execFileSync("git", ["-C", wt.worktreePath, "status", "--porcelain"], { encoding: "utf8" }).trim();
  check(!/done-when/.test(status), "and nothing new appears in the checkout for git to commit");
  await bridge.screenshot(join(evidenceDir, "01-launched.png"));
});
