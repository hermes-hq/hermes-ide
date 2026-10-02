#!/usr/bin/env node
// QA-launcher-welcome-keyboard (NEWCOMER-09, SOLO-15): the first-run welcome
// is a modal dialog for the keyboard and a screen reader too.
//   - each step puts the keyboard inside it: step 1 on the policy box,
//     step 2 on the path field, step 3 on the task field;
//   - nothing behind it is a Tab stop (the app behind is inert), and Tab on
//     its last control wraps to its first;
//   - Enter in a path that is a repository moves on, as Continue does;
//   - the dialog is named by its title.
//
// Negative control: a build before the fix leaves the keyboard on <body>,
// lets Tab reach the app behind the backdrop and ignores Enter in the path.

import { join } from "node:path";
import { pressKey } from "../launcher-steps.mjs";
import { runLauncherQa, sleep, typeValue } from "../qa-launcher-steps.mjs";

const where = (bridge) =>
  bridge.eval(`const a = document.activeElement; return { inDialog: !!a?.closest?.(".setup-dialog"), cls: a ? a.tagName + "." + String(a.className).slice(0, 50) : null, id: a?.id ?? "" };`);

await runLauncherQa(
  "QA-launcher-welcome-keyboard",
  async ({ bridge, fx, log, check, evidenceDir }) => {
    await bridge.waitFor("the welcome's agent check", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "agents" && e2e.first(".agent-doctor")?.getAttribute("data-loading") === "false";`, { timeoutMs: 60_000 });
    await sleep(300);
    let f = await where(bridge);
    log(`  step 1 focus: ${JSON.stringify(f)}`);
    check(f.inDialog, "step 1: the keyboard starts inside the welcome");
    const trap = await bridge.eval(`
      const d = e2e.first(".setup-dialog");
      const sel = 'button:not([disabled]), a[href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])';
      const behind = e2e.all(sel).filter((e) => e.offsetParent !== null && !e.closest("[inert]") && !d.contains(e));
      const inside = [...d.querySelectorAll(sel)].filter((e) => e.offsetParent !== null && e.tabIndex >= 0);
      const last = inside[inside.length - 1];
      last.focus();
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      last.dispatchEvent(tab);
      return { behind: behind.map((e) => e2e.norm(e.getAttribute("aria-label") || e.innerText || e.className).slice(0, 30)).slice(0, 6), wrapped: tab.defaultPrevented && document.activeElement === inside[0], label: document.getElementById(d.getAttribute("aria-labelledby") ?? "")?.innerText ?? "" };`);
    log(`  ${JSON.stringify(trap)}`);
    check(trap.behind.length === 0, "nothing behind the welcome can be reached with Tab");
    check(trap.wrapped, "Tab on its last control wraps to its first");
    check(trap.label === "Your agents", "the dialog is named by its title");

    await bridge.clickWhenReady(`const box = e2e.must(e2e.first("#setup-policy-accept"), "policy"); return box.checked ? true : e2e.click(box);`);
    await bridge.waitFor("Continue", `return !e2e.first(".setup-continue").disabled;`);
    await bridge.click(".setup-continue");
    await bridge.waitFor("the repository step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`, { timeoutMs: 20_000 });
    await sleep(400);
    f = await where(bridge);
    log(`  step 2 focus: ${JSON.stringify(f)}`);
    check(f.inDialog && /setup-repo-input/.test(f.cls), "step 2: the keyboard is in the path field");
    await typeValue(bridge, ".setup-repo-input", fx.repo);
    await bridge.waitFor("the repository accepted", `return e2e.first(".setup-repo-state")?.getAttribute("data-git") === "true";`, { timeoutMs: 20_000 });
    await pressKey(bridge, ".setup-repo-input", "Enter");
    await sleep(800);
    const step = await bridge.eval(`return e2e.first(".setup-dialog")?.getAttribute("data-step");`);
    log(`  after Enter in the path field: step=${step}`);
    check(step === "task", "Enter in a valid path moves on to step 3");
    await bridge.waitFor("the launcher in step 3", `return e2e.first(".setup-dialog .task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 }).catch(() => {});
    await sleep(400);
    f = await where(bridge);
    log(`  step 3 focus: ${JSON.stringify(f)}`);
    check(f.inDialog && /task-launcher-task/.test(f.cls), "step 3: the keyboard is in the task field");
    await bridge.screenshot(join(evidenceDir, "01-step-3.png"));
  },
  { welcome: false },
);
