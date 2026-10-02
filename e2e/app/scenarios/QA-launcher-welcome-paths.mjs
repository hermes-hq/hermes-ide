#!/usr/bin/env node
// QA-launcher-welcome-paths (NEWCOMER-06, NEWCOMER-07): welcome step 2, a
// path typed by hand.
//   - "~/code/demo" (a git repository in the home folder) is read as that
//     folder: accepted, its full path shown under the field;
//   - a folder that does not exist says "No folder at this path";
//   - a folder that is no repository says what to do ("Pick the folder that
//     contains .git, or run git init there.");
//   - each answer is announced (role=status) and describes Continue.
//
// Negative control: a build before the fix calls every one of them "Not a
// git repository", "~" included, silently.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { invoke, onWindows } from "../launcher-steps.mjs";
import { runLauncherQa, sleep, typeValue } from "../qa-launcher-steps.mjs";

const state = (bridge) =>
  bridge.eval(`
    const s = e2e.first(".setup-repo-state");
    const live = e2e.first("#setup-repo-state");
    const cont = e2e.first(".setup-continue");
    const described = (cont?.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean).map((id) => document.getElementById(id)?.innerText ?? "").join(" ");
    return { git: s?.getAttribute("data-git") ?? null, text: e2e.norm(s?.innerText ?? ""), role: live?.getAttribute("role") ?? null, continueDisabled: !!cont?.disabled, described: e2e.norm(described) };`);

await runLauncherQa(
  "QA-launcher-welcome-paths",
  async ({ bridge, fx, log, check, evidenceDir }) => {
    await bridge.waitFor("the welcome's agent check", `return e2e.first(".agent-doctor")?.getAttribute("data-loading") === "false";`, { timeoutMs: 60_000 });
    await bridge.clickWhenReady(`const box = e2e.must(e2e.first("#setup-policy-accept"), "policy"); return box.checked ? true : e2e.click(box);`);
    await bridge.click(".setup-continue");
    await bridge.waitFor("the repository step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);

    await typeValue(bridge, ".setup-repo-input", join(fx.work, "projcets", "demo-app"));
    await bridge.waitFor("the check", `return !!e2e.first(".setup-repo-state");`, { timeoutMs: 20_000 });
    await sleep(400);
    let s = await state(bridge);
    log(`  a missing folder: ${JSON.stringify(s)}`);
    check(s.text === "No folder at this path", "a folder that does not exist is said to be missing");
    check(s.role === "status", "the answer is announced");
    check(s.continueDisabled && s.described.includes("No folder at this path"), "Continue is off and says why");

    const plain = join(fx.work, "notes");
    mkdirSync(plain, { recursive: true });
    await typeValue(bridge, ".setup-repo-input", plain);
    await sleep(900);
    s = await state(bridge);
    log(`  a folder that is no repository: ${JSON.stringify(s)}`);
    check(s.text === "This folder isn't a git repository. Pick the folder that contains .git, or run git init there.", "a plain folder is said to be no repository, with what to do");

    if (!onWindows) {
      const home = (await invoke(bridge, "task_repo_probe", { path: "~", branch: null })).resolved;
      const demo = join(home, "code", "demo");
      mkdirSync(demo, { recursive: true });
      execFileSync("git", ["init", "-q", demo]);
      await typeValue(bridge, ".setup-repo-input", "  ~/code/demo ");
      await sleep(900);
      s = await state(bridge);
      log(`  ~/code/demo: ${JSON.stringify(s)}`);
      check(s.git === "true", '"~/code/demo" is the git repository in the home folder');
      check(/→ .*code[\\/]demo/.test(s.text) && /Git repository: /.test(s.text), "its full path is shown");
      check(!s.continueDisabled, "and Continue is on");
      await bridge.screenshot(join(evidenceDir, "01-tilde.png"));
    }
  },
  { welcome: false },
);
