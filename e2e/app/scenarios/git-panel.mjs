#!/usr/bin/env node
// Scenario (README "Git Integration"): the Review Desk lists a project's
// staged, unstaged and untracked files, stages and unstages them, and shows
// the diff of the file you click — on the REAL app, against a throwaway
// repository.
//
// A plain shell session is started on the repository (its own hermes/
// worktree, as every new task gets). In its worktree two tracked files are
// changed and one new file is added. With ⌘G:
//   1. the Changes section lists a.txt and b.txt as changed and c.txt as
//      untracked (and git agrees);
//   2. Stage on b.txt stages it (git says so) and the row moves to staged;
//      Unstage on it puts it back (git's index is empty again);
//   3. clicking b.txt in the Changes section shows b.txt's diff: its removed
//      line marked "-" and its added line marked "+", and nothing of a.txt;
//      clicking a.txt then shows a.txt's diff instead.
// Commit, discard, push and pull from the same section are proven by
// F21-review-changes.mjs.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_GIT_PANEL_NEGATIVE=no-diff hides the diff lines with a style
//   rule: the files are listed, but no diff is shown.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/git-panel.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { invoke, menuAction, setInput } from "../fleet-steps.mjs";

const SCENARIO = "git-panel";
const NO_DIFF = process.env.HERMES_E2E_GIT_PANEL_NEGATIVE === "no-diff";
const onWindows = platform() === "win32";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NO_DIFF ? "   diff lines HIDDEN (negative control)" : ""}`);

  // ── A throwaway repository (synthetic identity) ────────────────────
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-gitpanel-")));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  const repo = join(work, "gitpanel-repo");
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
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  for (const [k, v] of [["user.name", "Hermes Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    gitIn(repo, "config", k, v);
  }
  writeFileSync(join(repo, "a.txt"), "alpha one\nalpha two\nalpha three\n");
  writeFileSync(join(repo, "b.txt"), "bravo one\nbravo two\nbravo three\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "base");
  log(`  throwaway repo ${repo}`);

  const app = await (onWindows
    ? launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true })
    : launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir }));
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
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("gitpanel-repo"));
  `);
  await clickPrimary("folder");
  for (let i = 0; i < 6 && (await bridge.exists(".session-creator")); i++) {
    await bridge.eval(`
      const el = e2e.first('input.session-creator-name[placeholder="Session name (optional)"]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      el.focus();
      setter.call(el, "git-panel");
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
  log(`  session ${sessionId} works in ${wt}`);
  assert(gitIn(wt, "rev-parse", "--show-toplevel").length > 0, "the session works in a git checkout of the test repo");

  // Two tracked files changed (one line replaced in each) and a new file.
  writeFileSync(join(wt, "a.txt"), "alpha one\nalpha TWO from the agent\nalpha three\n");
  writeFileSync(join(wt, "b.txt"), "bravo one\nbravo TWO from the agent\nbravo three\n");
  writeFileSync(join(wt, "c.txt"), "charlie, a new file\n");
  const status = () =>
    execFileSync("git", ["-C", wt, "status", "--porcelain"], { env: gitEnv, encoding: "utf8" }).split("\n").filter(Boolean).sort();
  assert(JSON.stringify(status()) === JSON.stringify([" M a.txt", " M b.txt", "?? c.txt"]), `git: two files changed and one untracked (${JSON.stringify(status())})`);

  // ── 1. ⌘G: staged / unstaged / untracked ───────────────────────────
  log("step 1: ⌘G lists the changed and the untracked files");
  await menuAction(bridge, "view.git-panel");
  await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`, { timeoutMs: 10_000 });
  if (NO_DIFF) {
    await bridge.eval(`
      const s = document.createElement("style");
      s.textContent = ".review-hunks { display: none !important; }";
      document.head.appendChild(s);
      return true;
    `);
    log("  negative control: diff lines are hidden");
  }
  const SECTION = ".review-changes .git-project-section";
  const rowsNow = () => bridge.eval(`
    return e2e.all(${JSON.stringify(SECTION + " .git-file-row")}).map((r) => r.dataset.area + ":" + r.dataset.path).sort();
  `);
  await bridge.waitFor("all three files in Changes", `
    const rows = e2e.all(${JSON.stringify(SECTION + " .git-file-row")}).map((r) => r.dataset.area + ":" + r.dataset.path).sort();
    return rows.join(",") === "unstaged:a.txt,unstaged:b.txt,untracked:c.txt";
  `, { timeoutMs: 15_000 });
  const groups = await bridge.eval(`
    return e2e.all(${JSON.stringify(SECTION + " .git-file-group-label")}).map((g) => e2e.norm(g.innerText));
  `);
  log(`  groups: ${JSON.stringify(groups)}`);
  assert(groups.some((g) => /^untracked \(1\)$/i.test(g)), `c.txt is listed under its own Untracked group (${JSON.stringify(groups)})`);
  assert(JSON.stringify(await rowsNow()) === JSON.stringify(["unstaged:a.txt", "unstaged:b.txt", "untracked:c.txt"]), "a.txt and b.txt are listed as changed, c.txt as untracked");
  await bridge.screenshot(join(evidenceDir, "01-listed.png"));

  const clickRowButton = (path, name) =>
    bridge.clickWhenReady(`
      const row = e2e.first(${JSON.stringify(SECTION)} + ' .git-file-row[data-path="${path}"]');
      const b = row && [...row.querySelectorAll("button")].find((x) => e2e.norm(x.innerText) === ${JSON.stringify(name)});
      return e2e.click(e2e.must(b, "${name} on ${path}"));
    `);

  // ── 2. Stage, then unstage ──────────────────────────────────────────
  log("step 2: stage b.txt, then unstage it");
  await clickRowButton("b.txt", "Stage");
  await bridge.waitFor("b.txt staged in the section", `
    return e2e.first(${JSON.stringify(SECTION)} + ' .git-file-row[data-path="b.txt"]')?.dataset.area === "staged";
  `);
  assert(gitIn(wt, "diff", "--cached", "--name-only") === "b.txt", "git: exactly b.txt is staged");
  assert(JSON.stringify(await rowsNow()) === JSON.stringify(["staged:b.txt", "unstaged:a.txt", "untracked:c.txt"]), "the section shows b.txt staged");
  await bridge.screenshot(join(evidenceDir, "02-staged.png"));
  await clickRowButton("b.txt", "Unstage");
  await bridge.waitFor("b.txt back to changed", `
    return e2e.first(${JSON.stringify(SECTION)} + ' .git-file-row[data-path="b.txt"]')?.dataset.area === "unstaged";
  `);
  assert(gitIn(wt, "diff", "--cached", "--name-only") === "", "git: nothing is staged after Unstage");
  assert(JSON.stringify(status()) === JSON.stringify([" M a.txt", " M b.txt", "?? c.txt"]), "git: b.txt is still changed in the working tree");

  // ── 3. Click a file: its diff ───────────────────────────────────────
  const diffOf = () => bridge.eval(`
    const head = e2e.first(".review-main-head .review-main-path");
    const lines = e2e.all(".review-hunks .review-line").filter((l) => e2e.visible(l));
    return {
      head: head ? e2e.norm(head.innerText) : null,
      paths: [...new Set(lines.map((l) => l.dataset.path))],
      lines: lines.map((l) => (l.querySelector(".review-line-mark")?.textContent ?? "?") + (l.querySelector(".review-line-text")?.textContent ?? "")),
    };
  `);
  const showsDiff = (file, word) => `
    const lines = e2e.all('.review-hunks .review-line[data-path="${file}"]').filter((l) => e2e.visible(l));
    const text = lines.map((l) => (l.querySelector(".review-line-mark")?.textContent ?? "") + (l.querySelector(".review-line-text")?.textContent ?? ""));
    return text.includes("-${word} two") && text.includes("+${word} TWO from the agent") ? text : null;
  `;
  for (const [file, word, other] of [["b.txt", "bravo", "a.txt"], ["a.txt", "alpha", "b.txt"]]) {
    log(`step 3: click ${file} in the Changes section`);
    await bridge.clickWhenReady(`
      const row = e2e.first(${JSON.stringify(SECTION)} + ' .git-file-row[data-path="${file}"]');
      return e2e.click(e2e.must(row, "the ${file} row"));
    `);
    await bridge.waitFor(`${file}'s diff`, showsDiff(file, word), { timeoutMs: 10_000 }).catch(() => null);
    const diff = await diffOf();
    log(`  shown: ${JSON.stringify(diff)}`);
    assert(diff.lines.includes(`-${word} two`), `${file}: the removed line is shown marked "-"`);
    assert(diff.lines.includes(`+${word} TWO from the agent`), `${file}: the added line is shown marked "+"`);
    assert(diff.paths.length === 1 && diff.paths[0] === file, `only ${file}'s lines are shown, nothing of ${other} (${JSON.stringify(diff.paths)})`);
    await bridge.screenshot(join(evidenceDir, `03-diff-${file}.png`));
  }
});
