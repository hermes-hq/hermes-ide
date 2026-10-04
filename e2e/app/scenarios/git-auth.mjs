#!/usr/bin/env node
// Scenario git-auth (README claim "git-auth"): Push from the Review Desk
// signs in to a password-protected remote the way git itself would — on the
// REAL app, against a local git remote served over HTTP that answers 401
// until it gets an accepted user and password (fixtures/git-http-server.mjs,
// git's own smart HTTP backend, like a hosted remote).
//
// A plain shell session on a throwaway repository whose `origin` is that
// remote. With ⌘G (the Review Desk's Changes section):
//   1. no credentials anywhere (no credential helper, no token): Push fails,
//      says authentication failed and lists the ways to sign in, and the
//      remote has nothing new;
//   2. a git credential helper configured in the user's git config (git's
//      own `store` helper holding the password): Push succeeds, the remote
//      has the branch at the session's commit, and the server saw the
//      helper's user;
//   3. a fresh start with GITHUB_TOKEN in the app's environment and no
//      helper: Push succeeds with the token (user x-access-token).
//
// macOS and Linux only: the app reads the user's git config from the home
// folder, and on the Windows runner the test app runs with the real home
// folder (its data lives under %APPDATA%), so a scenario cannot give it a
// git config of its own there without touching the runner's.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_GIT_AUTH_NEGATIVE=wrong-password stores a wrong password in
//   the helper: step 2's push is refused.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/git-auth.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { invoke, menuAction, setInput } from "../fleet-steps.mjs";
import { startGitHttpServer } from "../fixtures/git-http-server.mjs";

const SCENARIO = "git-auth";
const WRONG_PASSWORD = process.env.HERMES_E2E_GIT_AUTH_NEGATIVE === "wrong-password";
const USER = "hermes-e2e";
const PASSWORD = "helper-password-7f3a";
const TOKEN = "token-e2e-91c2";
const SECTION = ".review-changes .git-project-section";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (platform() === "win32") {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "the Windows test app runs with the real home folder, so it cannot be given a git config of its own", log });
  }
  log(`scenario: ${SCENARIO}   platform: ${platform()}${WRONG_PASSWORD ? "   helper holds a WRONG password (negative control)" : ""}`);
  // Nothing from this machine may sign in for the app: only what each step sets up.
  delete process.env.GITHUB_TOKEN;
  delete process.env.GIT_TOKEN;

  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-git-auth-")));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  const remotes = join(work, "remotes");
  const repo = join(work, "auth-repo");
  mkdirSync(remotes, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Hermes Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Hermes Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const gitIn = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv, encoding: "utf8" }).trim();
  const bare = join(remotes, "auth-remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: gitEnv });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  for (const [k, v] of [["user.name", "Hermes Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    gitIn(repo, "config", k, v);
  }
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "base");
  gitIn(repo, "push", "-q", bare, "main"); // straight to the folder: the remote starts with main

  const server = await startGitHttpServer({ root: remotes, accounts: { [USER]: PASSWORD, "x-access-token": TOKEN }, log });
  onCleanup(() => {
    server.close();
  });
  const remoteUrl = server.url("auth-remote.git");
  gitIn(repo, "remote", "add", "origin", remoteUrl);
  log(`  throwaway repo ${repo}; origin ${remoteUrl} (HTTP, Basic auth: 401 without an accepted user)`);
  const remoteRef = (branch) => {
    try {
      return gitIn(bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
    } catch {
      return null;
    }
  };

  /** A plain shell session on the repository through the New Session wizard; returns its worktree and branch. */
  async function shellSessionOnRepo(bridge) {
    const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";
    const clickPrimary = async () => {
      await bridge.clickWhenReady(`
        if (!e2e.first(".session-creator")) return { clicked: null };
        return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
      `);
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
    await clickPrimary();
    await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`, { timeoutMs: 20_000 });
    await setInput(bridge, ".session-creator-scan-input", repo);
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
    await bridge.waitFor("the repository to be selected", `
      return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("auth-repo"));
    `);
    for (let i = 0; i < 6 && (await bridge.exists(".session-creator")); i++) await clickPrimary();
    await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
    const sessionId = await bridge.waitFor("the new terminal", `
      const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
      return ids.length === 1 ? ids[0] : null;
    `, { timeoutMs: 20_000 });
    const session = (await invoke(bridge, "get_sessions")).find((s) => s.id === sessionId);
    const wt = realpathSync.native(session.working_directory);
    const branch = gitIn(wt, "rev-parse", "--abbrev-ref", "HEAD");
    assert(gitIn(wt, "remote", "get-url", "origin") === remoteUrl, `the session works in a checkout of the repository (${branch}) whose origin is the password-protected remote`);
    return { sessionId, wt, branch };
  }

  /** Commit one file in the worktree, as an agent's work would be. */
  function commitIn(wt, name) {
    writeFileSync(join(wt, name), `${name} from the session\n`);
    gitIn(wt, "add", name);
    gitIn(wt, "commit", "-q", "-m", `add ${name}`);
    return gitIn(wt, "rev-parse", "HEAD");
  }

  /** Press Push in the Changes section; returns { ok, text } from the toast or the section's error. */
  async function push(bridge) {
    // Mark what an earlier press left on screen, so only this press's outcome counts.
    await bridge.eval(`document.querySelectorAll(".review-changes-toast, ${SECTION} .git-error").forEach((t) => { t.dataset.e2eStale = "1"; }); return true;`);
    await bridge.waitFor("the Push button", `return !!e2e.first(${JSON.stringify(`${SECTION} .git-btn-push`)});`, { timeoutMs: 15_000 });
    await bridge.click(`${SECTION} .git-btn-push`);
    return bridge.waitFor("the push to finish", `
      const err = e2e.first(${JSON.stringify(`${SECTION} .git-error:not([data-e2e-stale])`)});
      if (err && e2e.norm(err.innerText)) return { ok: false, text: e2e.norm(err.innerText) };
      const toast = e2e.first(".review-changes-toast:not([data-e2e-stale])");
      if (toast && /push/i.test(toast.innerText)) return { ok: true, text: e2e.norm(toast.innerText) };
      return null;
    `, { timeoutMs: 60_000 });
  }

  async function openChanges(bridge) {
    await menuAction(bridge, "view.git-panel");
    await bridge.waitFor("the Review Desk's Changes section", `return !!e2e.first(${JSON.stringify(SECTION)});`, { timeoutMs: 15_000 });
  }

  // ── Launch 1: no token in the environment ─────────────────────────
  const home1 = join(work, "home-1");
  mkdirSync(home1, { recursive: true });
  const app1 = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir: home1 });
  apps.push(app1);
  await completeOnboarding(app1.bridge, log);
  const s1 = await shellSessionOnRepo(app1.bridge);
  const head1 = commitIn(s1.wt, "b.txt");
  await openChanges(app1.bridge);

  log("step 1: no credential helper and no token: Push is refused and says how to sign in");
  const seenBefore1 = server.seen.length;
  const refused = await push(app1.bridge);
  log(`  push said: ${refused.text}`);
  assert(!refused.ok, "the push failed");
  assert(/authentication failed/i.test(refused.text), "it says authentication failed");
  assert(/credential manager/i.test(refused.text) && /GITHUB_TOKEN/.test(refused.text) && /ssh/i.test(refused.text), "it lists the ways to sign in (SSH key, Git Credential Manager, GITHUB_TOKEN)");
  assert(remoteRef(s1.branch) === null, "git: the remote has no copy of the session's branch");
  const tried1 = server.seen.slice(seenBefore1);
  assert(tried1.length > 0 && tried1.every((r) => !r.accepted), `the remote was asked and let nothing through (${tried1.length} request(s))`);
  await app1.bridge.screenshot(join(evidenceDir, "01-no-credentials.png"));

  log("step 2: a git credential helper in the user's git config: Push signs in with it");
  const store = join(home1, "git-credentials");
  writeFileSync(store, `http://${USER}:${WRONG_PASSWORD ? "not-the-password" : PASSWORD}@127.0.0.1:${server.port}\n`);
  writeFileSync(join(home1, ".gitconfig"), `[credential]\n\thelper = store --file ${store}\n`);
  log(`  ~/.gitconfig: credential.helper = store --file ${store}`);
  const seenBefore2 = server.seen.length;
  const pushed = await push(app1.bridge);
  log(`  push said: ${pushed.text}`);
  assert(pushed.ok, "the push succeeded");
  assert(remoteRef(s1.branch) === head1, `git: the remote has ${s1.branch} at the session's commit`);
  const users2 = [...new Set(server.seen.slice(seenBefore2).filter((r) => r.accepted).map((r) => r.user))];
  assert(users2.length === 1 && users2[0] === USER, `the remote let in the helper's user (${users2.join(", ")})`);
  await app1.bridge.screenshot(join(evidenceDir, "02-credential-helper.png"));
  await app1.stop();

  // ── Launch 2: GITHUB_TOKEN in the environment, no helper ──────────
  log("step 3: a fresh start with GITHUB_TOKEN set and no credential helper: Push signs in with the token");
  const home2 = join(work, "home-2");
  mkdirSync(home2, { recursive: true });
  const app2 = await launchApp({ runDir: join(evidenceDir, "run-2"), log, home: "private", homeDir: home2, env: { GITHUB_TOKEN: TOKEN } });
  apps.push(app2);
  await completeOnboarding(app2.bridge, log);
  const s2 = await shellSessionOnRepo(app2.bridge);
  const head2 = commitIn(s2.wt, "c.txt");
  await openChanges(app2.bridge);
  const seenBefore3 = server.seen.length;
  const tokenPush = await push(app2.bridge);
  log(`  push said: ${tokenPush.text}`);
  assert(tokenPush.ok, "the push succeeded");
  assert(remoteRef(s2.branch) === head2, `git: the remote has ${s2.branch} at the session's commit`);
  const users3 = [...new Set(server.seen.slice(seenBefore3).filter((r) => r.accepted).map((r) => r.user))];
  assert(users3.length === 1 && users3[0] === "x-access-token", `the remote let in the token (user ${users3.join(", ")})`);
  await app2.bridge.screenshot(join(evidenceDir, "03-github-token.png"));
});
