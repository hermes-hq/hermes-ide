#!/usr/bin/env node
// QA-git (CHAOS-09): a New Session in a repository with no commits yet
// (`git init`, nothing committed) goes ahead without isolation instead of
// failing.
//
// In the wizard's branch step the repository is named: "fresh-repo has no
// commits yet. Make a first commit, or continue without isolation."; Continue
// is disabled and "Continue without isolation" is the primary. The summary
// says "fresh-repo (no separate branch: no commits yet)" and the session is
// created in the folder, with no libgit2 text or id shown anywhere.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// wizard defaulted to a new branch, closed, and showed libgit2's error).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as N from "../n11-steps.mjs";
import { endScenario, gitEnv, gitFixtures, scenarioContext, sleep, toasts } from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-empty-repo-session";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("emptyrepo", log);
const folder = join(fx.work, "fresh-repo");
mkdirSync(folder);
execFileSync("git", ["init", "-q", "-b", "main", folder], { env: gitEnv });
const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir, 1, { flagDefaults: null });
  const { bridge } = app;
  await N.completeOnboarding(bridge, log);
  await N.openWizard(bridge);
  // A plain shell (the last card).
  await bridge.clickWhenReady(`const cards = e2e.all(".session-creator-provider-card"); return e2e.click(cards[cards.length - 1]);`);
  await bridge.click(PRIMARY);
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`);
  await bridge.eval(`const i = e2e.first(".session-creator-scan-input"); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; i.focus(); s.call(i, ${JSON.stringify(folder)}); i.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); return true;`);
  await bridge.clickWhenReady(`const b = e2e.all(".session-creator-scan-btn").find((b) => !b.disabled && /scan/i.test(e2e.nameOf(b))); return e2e.click(e2e.must(b, "scan"));`);
  await bridge.waitFor("the folder attached", `return e2e.all(".project-picker-item-attached").some((el) => el.innerText.includes("fresh-repo"));`, { timeoutMs: 20_000 });
  await bridge.waitFor("Next enabled", `const b = e2e.first(${JSON.stringify(PRIMARY)}); return !!b && !b.disabled;`, { timeoutMs: 20_000 });
  await bridge.click(PRIMARY);

  log("the branch step");
  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-unborn") || !!e2e.first(".session-creator-label-input, .session-creator-summary");`, { timeoutMs: 20_000 });
  const step = await bridge.eval(`return {
    note: e2e.norm(e2e.first(".session-creator-unborn")?.innerText ?? ""),
    primary: e2e.nameOf(e2e.first(${JSON.stringify(PRIMARY)}) ?? document.body),
    continueDisabled: !!e2e.first(".session-creator-btn-continue")?.disabled,
  };`);
  log(`  ${JSON.stringify(step)}`);
  await bridge.screenshot(join(evidenceDir, "01-branch-step.png"));
  check(step.note === "fresh-repo has no commits yet. Make a first commit, or continue without isolation.", "the step says the repository has no commits yet");
  check(step.primary === "Continue without isolation" && step.continueDisabled, "Continue is disabled and Continue without isolation is the primary");
  await bridge.click(PRIMARY);

  log("the summary");
  await bridge.waitFor("the summary", `return !!e2e.first(".session-creator-summary");`, { timeoutMs: 20_000 });
  const summary = await bridge.eval(`return e2e.norm(e2e.first(".session-creator-summary").innerText);`);
  log(`  ${summary}`);
  await bridge.screenshot(join(evidenceDir, "02-summary.png"));
  check(summary.includes("fresh-repo (no separate branch: no commits yet)"), "the summary says the folder gets no separate branch, and why");
  check(!/hermes\/task-/.test(summary), "no task branch is offered");
  await bridge.click(PRIMARY);
  await bridge.waitFor("the session", `return e2e.all(".session-item").length === 1;`, { timeoutMs: 30_000 }).catch(() => {});
  await sleep(2000);
  const after = await bridge.eval(`return { wizard: !!e2e.first(".session-creator"), rows: e2e.all(".session-item").length };`);
  const shown = await toasts(bridge);
  log(`  after Create: ${JSON.stringify(after)}; toasts: ${JSON.stringify(shown)}`);
  check(after.rows === 1 && !after.wizard, "the session is created in the folder");
  check(!shown.some((t) => /UnbornBranch|class=|code=|[0-9a-f]{8}-[0-9a-f]{4}-/.test(t)), "no libgit2 text or id is shown");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
