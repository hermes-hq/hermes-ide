#!/usr/bin/env node
// QA-launcher-extra-folder: a task with one extra folder, on the REAL app
// with the fake claude.
//
//   1. other-repo is a project; in ⌘N's project menu its checkbox adds it to
//      the task: the chip says "launcher-repo +1" and the Also line names it.
//   2. Launch: the session has both projects attached (the main one first
//      in the order they were sent), and the agent was started with
//      `--add-dir <other-repo>`, its cwd the task's worktree of
//      launcher-repo. other-repo gets no worktree and no branch.
//
// Negative control: a build without extra folders has no checkbox (step 1
// fails), and one that does not pass them on starts the agent with no
// --add-dir (step 2 fails).

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { invoke, launcherState, openChip, openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-extra-folder", async ({ bridge, fx, log, check, assert, evidenceDir }) => {
  const other = await invoke(bridge, "create_project", { path: fx.otherRepo, name: null });
  log(`  other project: ${other.id} ${other.path}`);
  const before = fx.records().length;

  // ── 1. The checkbox adds other-repo ──────────────────────────────────
  await openLauncher(bridge);
  await openChip(bridge, "project");
  await bridge.clickWhenReady(`
    const row = e2e.all(".task-launcher-menu [data-project-path]").find((r) => e2e.norm(r.querySelector(".launcher-pm-name")?.textContent ?? "") === "other-repo");
    const box = e2e.must(row?.querySelector(".launcher-pm-check"), "other-repo's checkbox");
    return box.checked ? true : e2e.click(box);
  `);
  await bridge.waitFor("other-repo in the task", `return !!e2e.first(".task-launcher-extras [data-extra-path]");`, { timeoutMs: 20_000 });
  await bridge.screenshot(join(evidenceDir, "01-extra-folder.png"));
  await bridge.eval(`e2e.first(".launcher-pm-input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
  const st = await launcherState(bridge);
  const also = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-extras")?.innerText ?? "");`);
  log(`  chip: ${st.project}   also: ${also}`);
  assert(st.project === "launcher-repo +1", "the project chip says launcher-repo +1");
  check(also.includes("other-repo") && also.includes("main"), "the Also line names other-repo and its branch");

  // ── 2. Launch: both projects, one --add-dir ──────────────────────────
  await typeInto(bridge, ".task-launcher-task", "Use the shared helper from other-repo");
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  const all = await fx.waitForRecords(before + 1);
  const r = all[all.length - 1];
  log(`  record: cwd=${r.cwd} addDirs=${JSON.stringify(r.addDirs)} argv=${JSON.stringify(r.argv)}`);
  check(Array.isArray(r.addDirs) && r.addDirs.length === 1 && fx.samePath(r.addDirs[0], fx.otherRepo), "the agent was started with --add-dir <other-repo>");
  check(!fx.samePath(r.cwd, fx.otherRepo), "the agent works in launcher-repo's task checkout, not in other-repo");

  const sessions = await invoke(bridge, "get_sessions");
  const s = sessions.find((x) => fx.samePath(x.working_directory, r.cwd)) ?? sessions[sessions.length - 1];
  const projects = await invoke(bridge, "get_session_projects", { sessionId: s.id });
  log(`  session ${s.id} projects: ${JSON.stringify(projects.map((p) => p.path))}`);
  check(projects.some((p) => fx.samePath(p.path, fx.repo)), "launcher-repo is attached");
  check(projects.some((p) => fx.samePath(p.path, fx.otherRepo)), "other-repo is attached");
  const otherWorktrees = execFileSync("git", ["-C", fx.otherRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length;
  check(otherWorktrees === 1, "other-repo gets no worktree");
});
