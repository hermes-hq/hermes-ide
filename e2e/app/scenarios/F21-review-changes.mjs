#!/usr/bin/env node
// Scenario F21 (regression audit item 4, #126 #177): the Review Desk's
// Changes section gives back the git actions the replaced panels had — on
// the REAL app, against a throwaway repository with a local bare remote.
//
// A plain shell session is started on the repository (its own hermes/
// worktree, as every new task gets). Two files are changed in its worktree.
// With ⌘G (the menu route):
//   1. the Changes section sits at the top of the Review tab and lists both
//      files as changed, on the session's branch;
//   2. Stage on one file stages exactly that file (git says so);
//   3. the commit message box starts from a draft: a plain shell has no
//      turns, so it is only the subject (from the branch), labelled "Commit
//      message" and never the branch's totals; Commit makes a commit with
//      exactly that message and only the staged file; the other file is
//      still changed;
//   4. Discard on the other file asks first: Cancel leaves it changed, and
//      only Confirm restores it;
//   5. Push puts the branch on the bare remote; a commit pushed there from
//      another clone comes back with Pull;
//   6. the branch name opens the branch switcher; picking another branch
//      checks it out (git says so) and the section follows;
//   7. the Repository tab still has the log (with the commit), and the stash.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_F21C_FLAG=off starts the app with the reviewDesk flag off:
//     ⌘G opens the old git panel and there is no Review Desk.
//   HERMES_E2E_F21C_NEGATIVE=no-section keeps the flag on, so the Review
//     Desk opens, but a style rule hides its Changes section: the desk is
//     there without the section.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F21-review-changes.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_FLAG_DEFAULTS, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { invoke, menuAction, setInput } from "../fleet-steps.mjs";

const SCENARIO = "F21-review-changes";
const FLAG_ON = (process.env.HERMES_E2E_F21C_FLAG || "on") !== "off";
const NO_SECTION = process.env.HERMES_E2E_F21C_NEGATIVE === "no-section";
const onWindows = platform() === "win32";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   reviewDesk flag: ${FLAG_ON ? "on" : "OFF (negative control)"}${NO_SECTION ? "   Changes section HIDDEN (negative control)" : ""}`);

  // ── A throwaway repository and a local bare remote (synthetic identity) ──
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f21c-")));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  const repo = join(work, "f21c-repo");
  const remote = join(work, "f21c-remote.git");
  const other = join(work, "other-clone");
  const homeDir = join(work, "home");
  mkdirSync(homeDir, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Hermes Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Hermes Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const gitIn = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv, encoding: "utf8" }).trim();
  const BASE = { "a.txt": "alpha\n", "b.txt": "bravo\n" };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: gitEnv });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  for (const [k, v] of [["user.name", "Hermes Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    gitIn(repo, "config", k, v);
  }
  for (const [rel, text] of Object.entries(BASE)) writeFileSync(join(repo, rel), text);
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "base");
  gitIn(repo, "remote", "add", "origin", remote);
  gitIn(repo, "push", "-q", "origin", "main");
  log(`  throwaway repo ${repo}, bare remote ${remote}`);

  const env = {};
  const flagDefaults = FLAG_ON ? E2E_FLAG_DEFAULTS : { ...E2E_FLAG_DEFAULTS, reviewDesk: false };
  const app = await (onWindows
    ? launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, env, flagDefaults })
    : launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir, env, flagDefaults }));
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  // ── A plain shell session on the repository (its own worktree) ─────
  log("a plain shell session on the test repository");
  const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";
  const clickPrimary = async (what) => {
    const r = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return { clicked: null };
      return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
    `);
    log(`  wizard ${what}: ${r.clicked === null ? "already closed" : `clicked "${r.clicked}"`}`);
    await sleep(300);
  };
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.click(".activity-bar-left > .activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await clickPrimary("agent");
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`, { timeoutMs: 20_000 });
  await setInput(bridge, ".session-creator-scan-input", repo);
  await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  await bridge.waitFor("the test repo to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f21c-repo"));
  `);
  await clickPrimary("folder");
  for (let i = 0; i < 6 && (await bridge.exists(".session-creator")); i++) {
    await bridge.eval(`
      const el = e2e.first('input.session-creator-name[placeholder="Session name (optional)"]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      el.focus();
      setter.call(el, "changes");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await clickPrimary(`step ${i + 1}`);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const sessionId = await bridge.waitFor("the new terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  const session = (await invoke(bridge, "get_sessions")).find((s) => s.id === sessionId);
  const wt = realpathSync.native(session.working_directory);
  const branch = gitIn(wt, "rev-parse", "--abbrev-ref", "HEAD");
  log(`  session ${sessionId} works in ${wt} on ${branch}`);
  assert(gitIn(wt, "rev-parse", "--show-toplevel").length > 0, "the session works in a git checkout of the test repo");

  // Two changed files, as an agent would leave them.
  writeFileSync(join(wt, "a.txt"), "alpha\nchanged by the agent\n");
  writeFileSync(join(wt, "b.txt"), "bravo\nchanged by the agent\n");
  // Not trimmed: the first column is the index state, often a space.
  const changed = () =>
    execFileSync("git", ["-C", wt, "status", "--porcelain"], { env: gitEnv, encoding: "utf8" }).split("\n").filter(Boolean).sort();
  assert(JSON.stringify(changed()) === JSON.stringify([" M a.txt", " M b.txt"]), `git: two files changed, none staged (${JSON.stringify(changed())})`);

  // ── 1. ⌘G: the Changes section ─────────────────────────────────────
  log("step 1: ⌘G opens the Review Desk with its Changes section on top");
  await menuAction(bridge, "view.git-panel");
  await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`, { timeoutMs: 10_000 });
  if (NO_SECTION) {
    await bridge.eval(`
      const s = document.createElement("style");
      s.textContent = ".review-changes { display: none !important; }";
      document.head.appendChild(s);
      return true;
    `);
    log("  negative control: the Changes section is hidden; the desk is open");
  }
  const SECTION = ".review-changes .git-project-section";
  const rowsNow = () => bridge.eval(`
    return e2e.all(${JSON.stringify(SECTION + " .git-file-row")}).map((r) => r.dataset.area + ":" + r.dataset.path).sort();
  `);
  await bridge.waitFor("both files in Changes", `
    const rows = e2e.all(${JSON.stringify(SECTION + " .git-file-row")}).map((r) => r.dataset.area + ":" + r.dataset.path).sort();
    return rows.join(",") === "unstaged:a.txt,unstaged:b.txt";
  `, { timeoutMs: 15_000 });
  const layout = await bridge.eval(`
    const nav = e2e.first(".review-nav");
    const s = e2e.first(${JSON.stringify(SECTION)});
    return { first: nav.firstElementChild?.className ?? "", branch: s.dataset.branch, title: e2e.norm(e2e.first(".review-changes-title").innerText), visible: e2e.visible(s) };
  `);
  assert(layout.first.includes("review-changes") && layout.visible, `the Changes section is the first thing in the Review tab (${layout.first})`);
  assert(/^changes$/i.test(layout.title), `it is titled "${layout.title}"`);
  assert(layout.branch === branch, `it shows the session's branch (${layout.branch})`);
  await bridge.screenshot(join(evidenceDir, "01-changes.png"));

  const clickRowButton = (path, name) =>
    bridge.clickWhenReady(`
      const row = e2e.first(${JSON.stringify(SECTION)} + ' .git-file-row[data-path="${path}"]');
      const b = row && [...row.querySelectorAll("button")].find((x) => e2e.norm(x.innerText) === ${JSON.stringify(name)});
      return e2e.click(e2e.must(b, "${name} on ${path}"));
    `);

  // ── 2. Stage one of the two ────────────────────────────────────────
  log("step 2: stage a.txt only");
  await clickRowButton("a.txt", "Stage");
  await bridge.waitFor("a.txt staged in the section", `
    return e2e.first(${JSON.stringify(SECTION)} + ' .git-file-row[data-path="a.txt"]')?.dataset.area === "staged";
  `);
  assert(gitIn(wt, "diff", "--cached", "--name-only") === "a.txt", "git: exactly a.txt is staged");
  assert(JSON.stringify(await rowsNow()) === JSON.stringify(["staged:a.txt", "unstaged:b.txt"]), "the section shows a.txt staged and b.txt changed");

  // ── 3. Commit with the drafted message ─────────────────────────────
  log("step 3: commit with the drafted message (no turns: the subject only)");
  const draft = await bridge.waitFor("the drafted commit message", `
    const box = e2e.first(${JSON.stringify(SECTION)} + " textarea.git-commit-textarea");
    return box && box.value.trim() ? { value: box.value, label: e2e.norm(e2e.first(${JSON.stringify(SECTION)} + " .git-commit-label")?.innerText ?? "") } : null;
  `);
  log(`  drafted: ${JSON.stringify(draft.value)}`);
  assert(/^commit message$/i.test(draft.label), `no turns, so the box is labelled "${draft.label}", not "drafted from the turns"`);
  assert(draft.value.trim().length > 0 && !draft.value.includes("undefined"), "the draft has a subject line");
  assert(!draft.value.trim().includes("\n") && !/Changes:/.test(draft.value), "the draft is only the subject, not the branch's totals");
  await bridge.clickWhenReady(`
    const b = [...document.querySelectorAll(${JSON.stringify(SECTION + " .git-btn-commit")})][0];
    return e2e.click(e2e.must(b, "Commit"));
  `);
  await bridge.waitFor("the commit to land", `
    return e2e.all(${JSON.stringify(SECTION + " .git-file-row")}).map((r) => r.dataset.path).join(",") === "b.txt";
  `, { timeoutMs: 15_000 });
  const message = gitIn(wt, "log", "-1", "--format=%B");
  assert(message === draft.value.trim(), `git: the commit message is the draft (${JSON.stringify(message)})`);
  assert(gitIn(wt, "show", "--name-only", "--format=", "HEAD") === "a.txt", "git: the commit holds only a.txt");
  assert(JSON.stringify(changed()) === JSON.stringify([" M b.txt"]), "git: b.txt is still changed");
  await bridge.screenshot(join(evidenceDir, "02-committed.png"));

  // ── 4. Discard asks first ──────────────────────────────────────────
  log("step 4: discard b.txt — Cancel keeps it, Confirm restores it");
  await clickRowButton("b.txt", "Discard");
  await sleep(500);
  assert(readFileSync(join(wt, "b.txt"), "utf8").includes("changed by the agent"), "a first press only asks: b.txt is untouched");
  await bridge.screenshot(join(evidenceDir, "03-discard-asks.png"));
  await clickRowButton("b.txt", "Cancel");
  await sleep(500);
  assert(readFileSync(join(wt, "b.txt"), "utf8").includes("changed by the agent"), "Cancel: b.txt is untouched");
  await clickRowButton("b.txt", "Discard");
  await clickRowButton("b.txt", "Confirm");
  await bridge.waitFor("b.txt to leave the section", `
    return e2e.all(${JSON.stringify(SECTION + " .git-file-row")}).length === 0;
  `, { timeoutMs: 15_000 });
  assert(readFileSync(join(wt, "b.txt"), "utf8") === BASE["b.txt"], "Confirm: b.txt is back to the committed text");
  assert(changed().length === 0, "git: nothing is changed any more");

  // ── 5. Push, then Pull against the bare remote ─────────────────────
  log("step 5: push to the bare remote, then pull a commit made elsewhere");
  await bridge.click(`${SECTION} .git-btn-push`);
  await bridge.waitFor("the push to finish", `
    const t = e2e.first(".review-changes-toast");
    return t ? e2e.norm(t.innerText) : null;
  `, { timeoutMs: 20_000 });
  const pushed = gitIn(remote, "rev-parse", `refs/heads/${branch}`);
  assert(pushed === gitIn(wt, "rev-parse", "HEAD"), `git: the bare remote has ${branch} at the commit`);
  execFileSync("git", ["clone", "-q", "-b", branch, remote, other], { env: gitEnv });
  gitIn(other, "config", "commit.gpgsign", "false");
  writeFileSync(join(other, "c.txt"), "charlie from another clone\n");
  gitIn(other, "add", "c.txt");
  gitIn(other, "commit", "-q", "-m", "a commit from elsewhere");
  gitIn(other, "push", "-q", "origin", branch);
  const upstreamTip = gitIn(other, "rev-parse", "HEAD");
  await sleep(1200); // let the toast of the push go
  await bridge.click(`${SECTION} .git-btn-pull`);
  // A fast-forward moves the branch first and checks the files out after,
  // so wait for both before asserting either.
  const pulledFile = () => {
    try {
      return readFileSync(join(wt, "c.txt"), "utf8");
    } catch {
      return "";
    }
  };
  let pulled = false;
  for (let i = 0; i < 100 && !(pulled && pulledFile().startsWith("charlie")); i++) {
    pulled = gitIn(wt, "rev-parse", "HEAD") === upstreamTip;
    if (!(pulled && pulledFile().startsWith("charlie"))) await sleep(200);
  }
  assert(pulled, "git: Pull fast-forwarded the branch to the commit made elsewhere");
  assert(pulledFile().startsWith("charlie"), "the pulled file is in the worktree");

  // ── 6. Branch switch ───────────────────────────────────────────────
  log("step 6: switch branch from the branch name");
  gitIn(wt, "branch", "side");
  await bridge.click(`${SECTION} .git-project-branch-clickable`);
  const item = await bridge.waitFor("the branch switcher", `
    const it = e2e.all(".git-branch-selector .git-branch-item").find((el) => e2e.norm(el.innerText).replace(/^\\*/, "").trim().startsWith("side"));
    if (!it) return null;
    const r = it.getBoundingClientRect();
    const s = e2e.first(${JSON.stringify(SECTION)}).getBoundingClientRect();
    return { visible: e2e.visible(it), top: Math.round(r.top), sectionTop: Math.round(s.top), sectionBottom: Math.round(s.bottom) };
  `, { timeoutMs: 10_000 });
  log(`  switcher item at y=${item.top} (section ${item.sectionTop}..${item.sectionBottom})`);
  assert(item.visible, "the switcher lists the other branch");
  await bridge.screenshot(join(evidenceDir, "04-branch-switcher.png"));
  await bridge.clickWhenReady(`
    const it = e2e.all(".git-branch-selector .git-branch-item").find((el) => e2e.norm(el.innerText).replace(/^\\*/, "").trim().startsWith("side"));
    return e2e.click(e2e.must(it, "the side branch"));
  `);
  await bridge.waitFor("the section to follow the switch", `
    return e2e.first(${JSON.stringify(SECTION)})?.dataset.branch === "side";
  `, { timeoutMs: 15_000 });
  assert(gitIn(wt, "rev-parse", "--abbrev-ref", "HEAD") === "side", "git: the worktree is on side");

  // ── 7. Log and stash stay in the Repository tab ────────────────────
  log("step 7: the Repository tab keeps the log and the stash");
  await bridge.clickWhenReady(`
    const tab = e2e.all(".review-tab").find((el) => e2e.norm(el.innerText) === "Repository");
    return e2e.click(e2e.must(tab, "the Repository tab"));
  `);
  const repoTab = await bridge.waitFor("the log with the commit", `
    const p = e2e.first(".review-repo-project");
    if (!p) return null;
    const text = p.textContent;
    return text.includes(${JSON.stringify(draft.value.split("\n")[0].trim())}) ? { stash: !!p.querySelector(".git-stash-section") } : null;
  `, { timeoutMs: 15_000 });
  assert(repoTab.stash, "the stash is there too");
  await bridge.screenshot(join(evidenceDir, "05-repository-tab.png"));
});
