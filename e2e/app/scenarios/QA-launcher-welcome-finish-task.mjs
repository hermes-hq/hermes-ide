#!/usr/bin/env node
// QA-launcher-welcome-finish-task (NEWCOMER-03, NEWCOMER-05): welcome step 3
// with a first task typed.
//   - The step's primary is "Start task ⏎", the other "Skip for now"
//     (without a task: "Finish").
//   - Back to step 2 and Continue again: the task is still there.
//   - Skip for now asks 'Start “<task>” now?' [Start] [Keep as draft]
//     [Discard]; Keep as draft finishes the welcome, and ⌘N opens with the
//     task and the repository picked on step 2.
//
// Negative control: a build before the fix throws the task away on Finish
// (the highlighted button), and Back erases it.

import { join } from "node:path";
import { invoke, launcherState, openLauncher } from "../launcher-steps.mjs";
import { dismissWhatsNew, runLauncherQa, sleep, typeValue, welcomeToTaskStep } from "../qa-launcher-steps.mjs";

const TASK = "Add a contributing guide";

await runLauncherQa(
  "QA-launcher-welcome-finish-task",
  async ({ bridge, fx, log, check, evidenceDir }) => {
    await welcomeToTaskStep(bridge, fx.repo);
    const empty = await bridge.eval(`return { primary: e2e.norm(e2e.first(".setup-dialog .setup-actions .h-btn--primary")?.innerText ?? "") };`);
    check(empty.primary === "Finish", `with no task the primary is Finish ("${empty.primary}")`);
    await typeValue(bridge, ".task-launcher-task", TASK);
    await bridge.waitFor("Start task to be ready", `const b = e2e.first(".setup-start-task"); return !!b && !b.disabled;`, { timeoutMs: 30_000 });
    const buttons = await bridge.eval(`return {
      primary: e2e.norm(e2e.first(".setup-dialog .setup-actions .h-btn--primary")?.innerText ?? ""),
      finish: e2e.norm(e2e.first(".setup-finish")?.innerText ?? ""),
    };`);
    log(`  step 3 with a task: ${JSON.stringify(buttons)}`);
    check(buttons.primary === "Start task ⏎", "the primary is Start task ⏎");
    check(buttons.finish === "Skip for now", "the other is Skip for now");
    await bridge.screenshot(join(evidenceDir, "01-task-typed.png"));

    log("Back, then Continue: the task is kept");
    await bridge.click(".setup-back");
    await bridge.waitFor("step 2", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
    await bridge.waitFor("the repository accepted", `return e2e.first(".setup-repo-state")?.getAttribute("data-git") === "true";`, { timeoutMs: 20_000 });
    await bridge.click(".setup-continue");
    await bridge.waitFor("step 3", `return !!e2e.first(".task-launcher-task");`);
    await sleep(800);
    check((await bridge.eval(`return e2e.first(".task-launcher-task").value;`)) === TASK, "the typed task survives Back → Continue");

    log("Skip for now asks; Keep as draft keeps it for ⌘N");
    await bridge.click(".setup-finish");
    const ask = await bridge.waitFor("the question", `return e2e.norm(e2e.first(".setup-ask")?.innerText ?? "") || null;`, { timeoutMs: 5_000 }).catch(() => "");
    log(`  asked: ${JSON.stringify(ask)}`);
    check(/Start “Add a contributing guide” now\?/.test(ask) && /Keep as draft/.test(ask) && /Discard/.test(ask), "Skip for now asks whether to start the task, keep it, or drop it");
    await bridge.screenshot(join(evidenceDir, "02-asked.png"));
    if (ask) await bridge.click(".setup-ask-keep");
    else await bridge.click(".setup-finish");
    await bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop, .setup-pill");`, { timeoutMs: 20_000 });
    await dismissWhatsNew(bridge);
    check(fx.records().length === 0, "nothing was launched");
    const projects = (await invoke(bridge, "get_projects_ordered")).map((p) => p.path);
    check(projects.some((p) => fx.samePath(p, fx.repo)), "the repository picked on step 2 is a project now");
    await openLauncher(bridge, { draft: "keep" });
    await sleep(800);
    const st = await launcherState(bridge);
    log(`  ⌘N afterwards: task=${JSON.stringify(st.task)} project=${st.project}`);
    check(st.task === TASK, "⌘N opens with the task kept as a draft");
    check(st.project === "launcher-repo", "on the repository picked on step 2");
    await bridge.screenshot(join(evidenceDir, "03-cmd-n.png"));
  },
  { welcome: false },
);
