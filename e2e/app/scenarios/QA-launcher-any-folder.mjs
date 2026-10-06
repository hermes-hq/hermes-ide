#!/usr/bin/env node
// QA-launcher-any-folder: a session opens in any folder, git or not — on the
// REAL app, with fake agents.
//
//   1. ⌘N on a plain folder: no "not a git repository" row, no worktree or
//      branch to choose, a plain hint; Launch starts the agent IN that folder.
//      Its first prompt and its context file ($HERMES_CONTEXT) say the folder
//      is not a single git repository and that the agent may make a worktree
//      or branch in a repository inside it itself. No worktree is made, the
//      folder does not become a repository.
//   2. ⌘N on a parent folder holding two repositories: the agent starts in
//      the parent, the context names both repositories, and neither of them
//      gets a worktree.
//   3. The New Session wizard (⌘⇧N) on another plain folder: the folder step
//      says "not a git repository, the agent works directly in this folder",
//      there is no branch step, and the agent starts in the folder with the
//      same guidance.
//   4. The git panels step aside: the Review Desk shows its plain "No git
//      repository" state (no error), and no worktree error is raised.
//
// Negative control: a build before the change shows the not-git row on ⌘N
// and keeps Launch off, so step 1 fails at once.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invoke, launcherState, newTerminals, openLauncher, pressAppShortcut, setRepo, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

const GUIDANCE = "This folder is not a single git repository. If you need to change code inside a git repository in it, you may create a worktree or branch there yourself when it makes sense.";
const HINT = "Not a git repository: the agent works directly in this folder.";
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

await runLauncherQa("QA-launcher-any-folder", async ({ bridge, fx, log, check, assert, evidenceDir }) => {
  // ── Fixtures: a plain folder, a parent of two repositories, another plain folder ──
  const plain = join(fx.work, "notes");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "ideas.md"), "# ideas\n");
  const parent = join(fx.work, "projects");
  const nested = ["api", "web"].map((name) => {
    const repo = join(parent, name);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
    for (const args of [["config", "user.name", "Hermes Test"], ["config", "user.email", "test@example.com"], ["config", "commit.gpgsign", "false"]]) {
      execFileSync("git", ["-C", repo, ...args], { env: gitEnv });
    }
    writeFileSync(join(repo, "README.md"), `# ${name}\n`);
    execFileSync("git", ["-C", repo, "add", "."], { env: gitEnv });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"], { env: gitEnv });
    return repo;
  });
  const wizardFolder = join(fx.work, "drafts");
  mkdirSync(wizardFolder, { recursive: true });
  const worktreeCount = (repo) => execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { env: gitEnv, encoding: "utf8" }).split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length;

  /** The launch record of the fake agent started since `before`, with its context file read. */
  const startedSince = async (before) => {
    const all = await fx.waitForRecords(before + 1);
    const r = all[all.length - 1];
    const contextFile = r.env?.HERMES_CONTEXT ?? null;
    const context = contextFile && existsSync(contextFile) ? readFileSync(contextFile, "utf8") : "";
    const argv = (r.argv ?? []).join(" ");
    log(`  record: ${JSON.stringify({ agent: r.env?.HERMES_AGENT, cwd: r.cwd, contextFile })}`);
    return { r, argv, context };
  };
  const sessionIn = async (folder) => (await invoke(bridge, "get_sessions")).find((s) => fx.samePath(s.working_directory, folder)) ?? null;

  // ── 1. ⌘N on a plain folder ─────────────────────────────────────────
  log("step 1: ⌘N on a plain folder");
  await openLauncher(bridge);
  await setRepo(bridge, plain);
  await typeInto(bridge, ".task-launcher-task", "Tidy the ideas file");
  await bridge.waitFor("the plain-folder hint", `return !!e2e.first(".task-launcher-plain-folder");`, { timeoutMs: 20_000 });
  let st = await launcherState(bridge);
  const hint = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-plain-folder")?.innerText ?? "");`);
  log(`  launcher: project=${st.project} where=${JSON.stringify(st.where)} blocks=${JSON.stringify(st.blocks)} preview=${JSON.stringify(st.preview)} hint=${JSON.stringify(hint)}`);
  await bridge.screenshot(join(evidenceDir, "01-launcher-plain-folder.png"));
  assert(!st.blocks.some((b) => b.kind === "not-git"), "no 'not a git repository' row stops the launch");
  check(hint === HINT, "the launcher says the agent works directly in the folder");
  check(st.where === "", "there is no worktree or branch to choose");
  check(/\(no worktree\)$/.test(st.preview), "the preview says where it runs, with no worktree");
  await waitLaunchEnabled(bridge);
  let before = fx.records().length;
  let terms = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await newTerminals(bridge, terms, 1, "the agent's terminal");
  let got = await startedSince(before);
  check(fx.samePath(got.r.cwd, plain), "the agent runs in the plain folder itself");
  check(got.argv.includes("Tidy the ideas file") && got.argv.includes(GUIDANCE), "its first prompt carries the task and the git guidance");
  check(got.context.includes("## Git") && got.context.includes("not a git repository. Hermes made no worktree and no branch for it; you work directly in this folder."), "its context file says no worktree was made");
  check(got.context.includes("you may create a worktree or branch there yourself when it makes sense"), "its context file leaves git to the agent");
  check(!existsSync(join(plain, ".git")), "the folder was not made a repository");
  const s1 = await sessionIn(plain);
  check(!!s1, "the session's working folder is the plain folder");
  if (s1) {
    const projects = await invoke(bridge, "get_session_projects", { sessionId: s1.id });
    const links = [];
    for (const p of projects) links.push(await invoke(bridge, "git_session_worktree_info", { sessionId: s1.id, projectId: p.id }));
    log(`  session projects: ${JSON.stringify(projects.map((p) => p.path))}  worktree links: ${JSON.stringify(links)}`);
    check(projects.length === 1 && fx.samePath(projects[0].path, plain), "the plain folder is the session's project");
    check(links.every((l) => l === null), "the session has no worktree");
  }

  // ── 2. ⌘N on a parent folder of two repositories ────────────────────
  log("step 2: ⌘N on a parent folder holding two repositories");
  await openLauncher(bridge);
  await setRepo(bridge, parent);
  await typeInto(bridge, ".task-launcher-task", "Compare the two services");
  await bridge.waitFor("the plain-folder hint", `return !!e2e.first(".task-launcher-plain-folder");`, { timeoutMs: 20_000 });
  st = await launcherState(bridge);
  assert(!st.blocks.some((b) => b.kind === "not-git"), "the parent folder is accepted");
  await waitLaunchEnabled(bridge);
  before = fx.records().length;
  terms = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await newTerminals(bridge, terms, 1, "the agent's terminal");
  got = await startedSince(before);
  check(fx.samePath(got.r.cwd, parent), "the agent runs in the parent folder");
  check(got.context.includes("  - Git repositories inside it: api, web"), "the context names the repositories inside it");
  for (const repo of nested) check(worktreeCount(repo) === 1, `no worktree was made in ${repo.replace(fx.work, "<work>")}`);
  await bridge.screenshot(join(evidenceDir, "02-parent-folder.png"));

  // ── 3. The New Session wizard on a plain folder ────────────────────
  log("step 3: the New Session wizard (⌘⇧N) on another plain folder");
  await pressAppShortcut(bridge, { action: "file.new-session-advanced", pcKey: "h" });
  await bridge.waitFor("the wizard's agent step", `return !e2e.first(".task-launcher-sheet") && e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.click('.session-creator-provider-card[data-agent-id="claude"]');
  await bridge.eval(`const box = e2e.first(".session-creator-agent-view input[type=checkbox]"); if (box && box.checked) e2e.click(box); return true;`);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`, { timeoutMs: 20_000 });
  await typeInto(bridge, ".session-creator-scan-input", wizardFolder);
  await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  await bridge.waitFor("the folder picked", `return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("drafts"));`, { timeoutMs: 20_000 });
  const wizardHint = await bridge.waitFor("the not-git hint", `const r = e2e.first(".session-creator-nongit-row"); return r ? e2e.norm(r.innerText) : null;`, { timeoutMs: 20_000 });
  check(wizardHint === "drafts: not a git repository, the agent works directly in this folder.", `the folder step says so ("${wizardHint}")`);
  await bridge.screenshot(join(evidenceDir, "03-wizard-folder.png"));
  await bridge.waitFor("Next", `return !e2e.first(".session-creator-actions .session-creator-btn-primary").disabled;`, { timeoutMs: 20_000 });
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the confirm step", `return !!e2e.first(".session-creator-name");`, { timeoutMs: 20_000 });
  check(!(await bridge.exists(".session-creator-branch-multi")), "there is no branch step");
  before = fx.records().length;
  terms = await bridge.terminalIds();
  await bridge.clickWhenReady(`
    const buttons = e2e.all(".session-creator .session-creator-btn-primary");
    return e2e.click(e2e.must(buttons[buttons.length - 1], "Create session"));
  `);
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 60_000 });
  await newTerminals(bridge, terms, 1, "the wizard session's terminal");
  got = await startedSince(before);
  check(fx.samePath(got.r.cwd, wizardFolder), "the wizard's agent runs in the plain folder itself");
  check(got.argv.includes(GUIDANCE), "its first prompt carries the git guidance");
  check(got.context.includes("- drafts (") && got.context.includes("you work directly in this folder."), "its context file says no worktree was made");
  check(!existsSync(join(wizardFolder, ".git")), "the folder was not made a repository");

  // ── 4. The git panels step aside ───────────────────────────────────
  log("step 4: the Review Desk on the plain-folder session");
  await menuAction(bridge, "view.git-panel");
  await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`, { timeoutMs: 10_000 });
  const desk = await bridge.waitFor("the Review tab to finish loading", `
    const empty = e2e.first('.review-nav [data-empty="no-repository"]');
    const error = e2e.first(".review-nav .review-error");
    if (!empty && !error) return null;
    return { empty: empty ? e2e.norm(empty.innerText) : null, error: error ? e2e.norm(error.innerText) : null };
  `, { timeoutMs: 20_000 });
  log(`  the desk shows: ${JSON.stringify(desk)}`);
  await bridge.screenshot(join(evidenceDir, "04-review-desk.png"));
  check(desk.error === null, "the Review Desk shows no error");
  check(!!desk.empty, `it shows the plain no-repository state ("${desk.empty}")`);
  await sleep(500);
  const toasts = await bridge.eval(`return e2e.all(".toast").map((x) => e2e.norm(x.innerText));`);
  log(`  toasts: ${JSON.stringify(toasts)}`);
  check(!toasts.some((t) => /worktree|not a git|fatal/i.test(t)), "no worktree or git error is raised");
});
