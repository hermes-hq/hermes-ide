#!/usr/bin/env node
// Scenario FIX-branch-case: a new branch whose name differs from an existing
// one only in letter case never becomes that branch. On the REAL app, with
// fake `claude` and `codex` CLIs (tools/fake-agents) and a throwaway
// repository (main, develop one commit ahead, feature/inbox). No real account.
//
// On macOS and Windows git keeps `Develop` and `develop` in one file: asking
// for a new branch Develop used to hand back develop, and a commit in the
// session moved develop. Hermes now treats such a name as taken, on every OS:
//
//   1. the ⌘N launcher: a new-worktree branch "Develop" is blocked, the row
//      names develop, and offers the existing develop on purpose;
//   2. the New Session creator's New branch form: "Develop" shows "already
//      exists" naming develop, Continue is held back, and it offers "Use the
//      existing develop"; a folder differing only in case (Feature/x next to
//      feature/inbox) is refused too;
//   3. the backend on its own (git_create_worktree, as any caller would ask):
//      "Develop" as a new branch, and "Develop" as an existing one, are
//      refused; no branch, no worktree, develop does not move;
//   4. choosing the existing develop on purpose works: the session's worktree
//      is on develop (exactly), and only then does a commit there move it.
//
// Negative control (must end in RESULT: FAIL): a build of main before the fix
// (the form accepts "Develop" as new, and the backend checks develop out).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-branch-case.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep } from "../harness.mjs";
import { completeTaskWelcome, expandOptions, launcherFixtures, openLauncher, typeInto } from "../launcher-steps.mjs";

const SCENARIO = "FIX-branch-case";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);

// Every check is made and logged; the scenario fails at the end if any did.
const problems = [];
function check(condition, message) {
  if (condition) log(`  ok — ${message}`);
  else {
    log(`  FAILED — ${message}`);
    problems.push(message);
  }
}

const fx = launcherFixtures("fixcase", log);
const gitIn = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Hermes Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
const branches = () => fx.git("branch", "--list", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean);
const FORM = `
  const b = e2e.first(".session-creator-footer-actions .session-creator-btn-primary");
  const f = e2e.first(".branch-selector-field-input");
  return {
    continueDisabled: !!b?.disabled,
    error: e2e.norm(e2e.first(".branch-selector-validation-error")?.innerText || ""),
    value: f ? f.value : null,
    invalid: f ? f.getAttribute("aria-invalid") : null,
    useExisting: e2e.first(".branch-selector-use-existing")?.getAttribute("data-branch") ?? null,
  };`;

let app = null;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  const developBefore = fx.git("rev-parse", "develop");
  const branchesBefore = branches();
  log(`  repository branches: ${branchesBefore.join(", ")}; develop at ${developBefore.slice(0, 8)}`);

  // The real flag defaults: the three-step welcome and the ⌘N launcher.
  app = await fx.launch(evidenceDir, 1, { first: true, flagDefaults: {} });
  const { bridge } = app;
  const project = await completeTaskWelcome(bridge, fx.repo);

  log("step 1: the ⌘N launcher blocks a new branch Develop next to develop");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Case check");
  await expandOptions(bridge);
  await bridge.clickWhenReady(`const w = e2e.first('.task-launcher-options [data-where="new-worktree"]'); return w ? (w.getAttribute("aria-checked") === "true" || e2e.click(w)) : false;`);
  await typeInto(bridge, ".task-launcher-options .task-launcher-branch", "Develop");
  const row = await bridge
    .waitFor("the branch row", `
      const r = e2e.first('.task-launcher-block[data-kind="branch-exists"]');
      return r ? { clash: r.getAttribute("data-clash"), existing: r.getAttribute("data-existing"), text: e2e.norm(r.innerText), launchDisabled: !!e2e.first(".task-launcher-launch")?.disabled } : false;
    `, { timeoutMs: 20_000 })
    .catch(() => null);
  log(`  launcher row: ${JSON.stringify(row)}`);
  check(row && row.clash === "case" && row.existing === "develop", "the launcher says Develop is the existing branch develop");
  check(row && row.launchDisabled, "Launch is held back");
  check(row && /Use the existing develop/.test(row.text), "it offers the existing develop on purpose");
  if (row) {
    await bridge.click(".task-launcher-use-existing");
    const where = await bridge.waitFor("the where chip on develop", `const t = e2e.norm(e2e.first('[data-chip="where"]')?.innerText ?? ""); return /develop/.test(t) ? t : false;`, { timeoutMs: 10_000 }).catch(() => null);
    const left = await bridge.eval(`return e2e.all(".task-launcher-block").map((b) => b.getAttribute("data-kind"));`);
    check(!!where && !left.includes("branch-exists"), `choosing it switches to the existing branch develop (${where}; rows left: ${JSON.stringify(left)})`);
  }
  await bridge.screenshot(join(evidenceDir, "01-launcher.png"));

  log("step 2: the New Session creator's New branch form");
  await bridge.click(".task-launcher-advanced");
  await bridge.waitFor("the creator's agent step", `return !e2e.first(".task-launcher-sheet") && e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.click('.session-creator-provider-card[data-agent-id="claude"]');
  await bridge.eval(`const box = e2e.first(".session-creator-agent-view input[type=checkbox]"); if (box && box.checked) e2e.click(box); return true;`);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the folder step", `return e2e.all(".session-creator-list .project-picker-item").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`const r = e2e.all(".session-creator-list .project-picker-item").find((x) => x.innerText.includes("launcher-repo")); e2e.must(r, "the repository row"); return r.classList.contains("project-picker-item-attached") ? true : e2e.click(r);`);
  await bridge.waitFor("the repository picked", `return e2e.all(".session-creator-list .project-picker-item-attached").length === 1;`);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-branch-multi");`, { timeoutMs: 30_000 });
  await bridge.waitFor("a default branch", `return !!e2e.first(".session-creator-branch-selected-label");`, { timeoutMs: 20_000 });
  await sleep(300);
  await bridge.clickWhenReady(`return e2e.first(".branch-selector-body") ? true : e2e.click(e2e.must(e2e.first(".session-creator-branch-project-header"), "the project header"));`);
  await bridge.waitFor("the branch picker", `return !!e2e.first(".branch-selector-tabs");`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".branch-selector-tabs [role=radio]")[1], "New branch"));`);
  await bridge.waitFor("the New branch form", `return !!e2e.first(".branch-selector-field-input");`);

  for (const [typed, want] of [["Develop", "develop"], ["DEVELOP", "develop"], ["develop", "develop"], ["Feature/new", null]]) {
    await typeInto(bridge, ".branch-selector-field-input", typed);
    await sleep(600);
    const s = await bridge.eval(FORM);
    log(`  "${typed}" → ${JSON.stringify(s)}`);
    check(!!s.error && s.continueDisabled && s.invalid === "true", `"${typed}": an error, and Continue is held back`);
    if (want) {
      check(s.error.includes(want) && /already exists/.test(s.error), `"${typed}": the error names the existing branch ${want}`);
      check(s.useExisting === want, `"${typed}": "Use the existing ${want}" is offered`);
    } else {
      check(s.error.includes("feature/inbox"), `"${typed}": the error names feature/inbox (same folder in another case)`);
      check(s.useExisting === null, `"${typed}": no branch to use instead`);
    }
  }
  // Enter does not create it either.
  await typeInto(bridge, ".branch-selector-field-input", "Develop");
  await sleep(400);
  await bridge.eval(`e2e.first(".branch-selector-field-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true;`);
  await sleep(400);
  const afterEnter = await bridge.eval(`return { step: !!e2e.first(".session-creator-branch-multi"), label: e2e.norm(e2e.first(".session-creator-branch-selected-label")?.innerText || "") };`);
  check(afterEnter.step && !/Develop/.test(afterEnter.label), `Enter keeps the step, and Develop is not the chosen branch (${JSON.stringify(afterEnter)})`);
  await bridge.screenshot(join(evidenceDir, "02-form.png"));

  log("step 3: the backend refuses Develop by itself (new, or as an existing branch)");
  for (const createBranch of [true, false]) {
    const r = await bridge.eval(`
      try {
        const out = await window.__TAURI_INTERNALS__.invoke("git_create_worktree", { sessionId: "fixcase-direct-${createBranch ? "new" : "old"}", projectId: ${JSON.stringify(project.id)}, branchName: "Develop", createBranch: ${createBranch}, fromRemote: null });
        return { ok: true, out };
      } catch (e) { return { ok: false, error: String(e) }; }
    `);
    log(`  git_create_worktree(Develop, createBranch: ${createBranch}) → ${JSON.stringify(r)}`);
    check(!r.ok && /BRANCH_NAME_CLASH/.test(r.error ?? "") && /'develop'/.test(r.error ?? ""), `createBranch ${createBranch}: refused, naming develop`);
  }
  check(JSON.stringify(branches()) === JSON.stringify(branchesBefore), `no branch was made (${branches().join(", ")})`);
  check(!fx.worktrees().some((w) => /develop/i.test(w.branch ?? "")), "no worktree is on develop or Develop");
  check(fx.git("rev-parse", "develop") === developBefore, "develop has not moved");

  log("step 4: choosing the existing develop on purpose");
  await typeInto(bridge, ".branch-selector-field-input", "Develop");
  await bridge.clickWhenReady(`const b = e2e.first(".branch-selector-use-existing"); return b ? e2e.click(b) : false;`, { timeoutMs: 10_000 }).catch(() => log("  (no Use the existing button)"));
  const label = await bridge.waitFor("develop chosen", `const t = e2e.norm(e2e.first(".session-creator-branch-selected-label")?.innerText || ""); return /^develop$/.test(t) ? t : false;`, { timeoutMs: 10_000 }).catch(() => null);
  check(label === "develop", `the chosen branch is the existing develop, not a new one (${label})`);
  if (label === "develop") {
    await bridge.click(".session-creator-footer-actions .session-creator-btn-primary");
    await bridge.waitFor("the confirm step", `return !!e2e.first(".session-creator-name");`, { timeoutMs: 20_000 });
    const summary = await bridge.eval(`return e2e.norm(e2e.first(".session-creator-summary")?.innerText || "");`);
    log(`  confirm: ${summary}`);
    check(/Branch:\s*develop(?! \(new\))/.test(summary), "the confirm step shows develop, not (new)");
    const before = await bridge.terminalIds();
    await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".session-creator-footer-actions .session-creator-btn-primary, .session-creator-actions .session-creator-btn-primary"), "Create session"));`);
    await bridge.waitFor("the creator to close", `return !e2e.first(".session-creator");`, { timeoutMs: 30_000 });
    await bridge.waitFor("the session's terminal", `const ids = window.__HERMES_E2E__.terminalIds().filter((i) => !${JSON.stringify(before)}.includes(i)); return ids.length === 1 ? ids[0] : null;`, { timeoutMs: 30_000 });
    let onDevelop = null;
    for (let i = 0; i < 50 && !onDevelop; i++) {
      onDevelop = fx.worktrees().find((w) => w.branch === "develop") ?? null;
      if (!onDevelop) await sleep(200);
    }
    log(`  worktrees: ${JSON.stringify(fx.worktrees())}`);
    check(!!onDevelop, "the session's worktree is on develop, exactly");
    check(!fx.worktrees().some((w) => w.branch === "Develop"), "no worktree is on Develop");
    check(fx.git("rev-parse", "develop") === developBefore, "develop has not moved yet");
    if (onDevelop) {
      writeFileSync(join(onDevelop.path, "CHOSEN.md"), "work on develop, chosen on purpose\n");
      gitIn(onDevelop.path, "add", "CHOSEN.md");
      gitIn(onDevelop.path, "commit", "-q", "-m", "chosen work");
      check(fx.git("rev-parse", "develop") === gitIn(onDevelop.path, "rev-parse", "HEAD"), "a commit in the chosen session moves develop, as chosen");
    }
  }
  check(!branches().includes("Develop"), `git never got a branch Develop (${branches().join(", ")})`);
  await bridge.screenshot(join(evidenceDir, "03-session.png"));
  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
  log("all checks passed");
} catch (err) {
  failed = true;
  log(`ERROR: ${err.stack || err.message || err}`);
  try {
    await app?.bridge.screenshot(join(evidenceDir, "failure.png"));
  } catch {
    /* none */
  }
} finally {
  if (app) await app.stop();
  fx.cleanup();
}
finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
