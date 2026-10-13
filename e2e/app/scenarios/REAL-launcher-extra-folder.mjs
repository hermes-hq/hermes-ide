#!/usr/bin/env node
// Scenario REAL-launcher-extra-folder (local only): a folder added from the
// ⌘N launcher's project menu as an extra folder reaches the REAL `claude`
// CLI, which can read a file in it. Isolated test build, fresh profile.
//
// It runs only on a machine with a signed-in `claude` on PATH, macOS or
// Linux, and never in CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs lists
// it as excluded). One tiny turn on sonnet at low effort.
//
// Two throwaway repositories: main-repo, and extra-repo with SENTINEL.txt
// holding a random token. extra-repo is a project; its checkbox in the
// project menu adds it to the task (the same steps as
// QA-launcher-extra-folder, with the real claude instead of the fake).
//
// What must hold:
//   - the project chip says "main-repo +1" and the Also line names extra-repo;
//   - the running claude carries exactly one `--add-dir <extra-repo>`, and no
//     --add-dir points at main-repo or its worktree;
//   - claude, asked to reply with SENTINEL.txt's contents, prints the token
//     in the terminal;
//   - ~/.claude/settings.json is byte-identical before and after.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-launcher-extra-folder.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";

const SCENARIO = "REAL-launcher-extra-folder";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const MODEL = "sonnet";
const EFFORT = "low";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const which = (name) => {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
};
const claudeBin = which("claude");
if (IS_CI || platform() === "win32" || !claudeBin) {
  log(`needs a real, signed-in claude on PATH, macOS or Linux, and no CI (CI=${process.env.CI ?? ""}, claude=${claudeBin || "none"})`);
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "real claude not available here, or CI", log });
}

const home = homedir();
const guarded = [join(home, ".claude", "settings.json")].filter(existsSync);
const before = new Map(guarded.map((f) => [f, readFileSync(f)]));

// Two sibling repositories in one throwaway folder (an extra folder may not sit inside the main one).
const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-real-extra-")));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
function makeRepo(name, files) {
  const repo = join(work, name);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  git("config", "user.name", "Hermes Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  for (const [file, text] of Object.entries(files)) writeFileSync(join(repo, file), text);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { repo, git };
}
const TOKEN = `SENTINEL-${randomBytes(8).toString("hex")}`;
const main = makeRepo("main-repo", { "README.md": "# main-repo\n\nA scratch repository for a Hermes test. Nothing here matters.\n" });
const extra = makeRepo("extra-repo", { "README.md": "# extra-repo\n", "SENTINEL.txt": `${TOKEN}\n` });

const TASK = `Read the file SENTINEL.txt in ${extra.repo} and reply with only its contents.`;

const typeInto = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);
async function pickInMenu(bridge, chip, item) {
  await bridge.waitFor(`the ${chip} menu`, `
    if (e2e.first('.task-launcher-menu[data-menu="${chip}"]')) return true;
    const c = e2e.first('[data-chip="${chip}"]');
    return c && !c.disabled ? (e2e.click(c), false) : false;
  `);
  if (item) await bridge.waitFor(`${item} in the ${chip} menu`, `const el = e2e.first('.task-launcher-menu ${item}'); return el && !el.disabled ? e2e.click(el) : false;`);
}

async function threeStepWelcome(bridge) {
  await bridge.waitFor("the first-launch welcome", `return !!e2e.first(".setup-dialog, .onboarding-dialog");`, { timeoutMs: 30_000 });
  await bridge.click("#setup-policy-accept");
  await bridge.waitFor("Continue", `return !e2e.first(".setup-continue").disabled;`);
  await bridge.click(".setup-continue");
  await bridge.waitFor("the repository step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
  await bridge.click(".setup-skip");
  await bridge.waitFor("the task step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task";`);
  await bridge.click(".setup-finish");
  await bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

function processes() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}
async function findLaunchTree(sessionId, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = processes();
    const byPid = new Map(all.map((p) => [p.pid, p]));
    const hi = all.find((p) => new RegExp(`(^|/)hi run ${sessionId}(\\s|$)`).test(p.command));
    const claude = hi && all.find((p) => p.ppid === hi.pid && /claude/.test(p.command));
    if (hi && claude) return { hi, claude, shell: byPid.get(hi.ppid) ?? null };
    if (Date.now() > deadline) throw new Error(`no \`hi run ${sessionId}\` with a claude child within ${timeoutMs} ms`);
    await sleep(250);
  }
}
async function waitForStrip(bridge, sessionId, kinds, { confidence = null, timeoutMs = 120_000 } = {}) {
  return bridge.waitFor(`the strip to show ${kinds.join("/")}`, `
    const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]');
    if (!el || !${JSON.stringify(kinds)}.includes(el.dataset.statusKind)) return null;
    if (${JSON.stringify(confidence)} !== null && el.dataset.confidence !== ${JSON.stringify(confidence)}) return null;
    return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, text: e2e.norm(el.innerText) };
  `, { timeoutMs, intervalMs: 100 });
}
async function answerTrustPrompt(bridge, sessionId, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = (await bridge.readTerminal(sessionId)) ?? [];
    if (lines.some((l) => /trust/i.test(l))) {
      const yesBelow = lines.some((l) => /❯\s*No, exit/.test(l));
      await sleep(500);
      if (yesBelow) {
        await bridge.eval(`
          const host = document.querySelector('div[data-session-id="${sessionId}"]');
          const ta = e2e.must(host && host.querySelector("textarea.xterm-helper-textarea"), "terminal input");
          for (const type of ["keydown", "keyup"]) {
            const ev = new KeyboardEvent(type, { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true, composed: true, view: window });
            Object.defineProperty(ev, "keyCode", { get: () => 40 });
            Object.defineProperty(ev, "which", { get: () => 40 });
            ta.dispatchEvent(ev);
          }
          return true;
        `);
        await sleep(300);
      }
      await bridge.typeInTerminal(sessionId, "\n");
      return true;
    }
    const kind = await bridge.eval(`return e2e.first('.session-status-strip[data-strip-session="${sessionId}"]')?.dataset.statusKind ?? null;`);
    if (kind && kind !== "starting") return false;
    await sleep(250);
  }
  return false;
}


let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   claude: ${spawnSync(claudeBin, ["--version"], { encoding: "utf8" }).stdout.trim()}   model ${MODEL}, effort ${EFFORT}`);
  log(`  main: ${main.repo}   extra: ${extra.repo}   token: ${TOKEN}`);
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, tmp: "shared", flagDefaults: null });
  const { bridge } = app;
  await threeStepWelcome(bridge);

  // The project menu offers a checkbox only on projects: extra-repo becomes one first (as QA-launcher-extra-folder does).
  const other = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("create_project", ${JSON.stringify({ path: extra.repo, name: null })});`);
  log(`  extra-repo project: ${other.id} ${other.path}`);

  log("step 1: ⌘N, Claude, the main project, extra-repo's checkbox, model, effort, the task");
  if (platform() === "darwin") {
    await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "file.new-session" } }); return true;`);
  } else {
    await bridge.eval(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); return true;`);
  }
  await bridge.waitFor("the launcher's starting choice", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
  // Extra folders need an agent that takes them: Claude first.
  await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await pickInMenu(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", main.repo);
  await bridge.clickWhenReady(`
    const row = e2e.all(".task-launcher-menu [data-project-path]").find((r) => e2e.norm(r.querySelector(".launcher-pm-name")?.textContent ?? "") === "extra-repo");
    const box = e2e.must(row?.querySelector(".launcher-pm-check"), "extra-repo's checkbox");
    return box.checked ? true : e2e.click(box);
  `);
  await bridge.waitFor("extra-repo in the task", `return !!e2e.first(".task-launcher-extras [data-extra-path]");`, { timeoutMs: 20_000 });
  await bridge.eval(`e2e.first(".launcher-pm-input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
  await sleep(300);
  const chip = await bridge.eval(`return e2e.norm(e2e.first('[data-chip="project"]')?.innerText ?? "");`);
  const also = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-extras")?.innerText ?? "");`);
  const alsoPaths = await bridge.eval(`return e2e.all(".task-launcher-extras [data-extra-path]").map((el) => el.getAttribute("data-extra-path"));`);
  log(`  chip: ${chip}   also: ${also}   paths: ${JSON.stringify(alsoPaths)}`);
  assert(chip === "main-repo +1", "the project chip says main-repo +1");
  assert(also.includes("extra-repo") && alsoPaths.length === 1 && realpathSync.native(alsoPaths[0]) === extra.repo, "the Also line lists extra-repo");
  await pickInMenu(bridge, "model", `[data-model-id="${MODEL}"]`);
  await pickInMenu(bridge, "effort", `[data-effort="${EFFORT}"]`);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await bridge.waitFor("Launch to be enabled", `const b = e2e.first(".task-launcher-launch"); return !!b && !b.disabled;`, { timeoutMs: 60_000 });
  const preview = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-command")?.textContent ?? "");`);
  log(`  Hermes will run: ${preview}`);
  // acceptEdits lets claude read files in its working folders (the --add-dir ones too) without asking.
  assert(preview.startsWith("claude --permission-mode acceptEdits") && preview.includes(`--model ${MODEL}`) && preview.includes(`--effort ${EFFORT}`), "the launcher runs claude in acceptEdits with the model and the effort");
  await bridge.screenshot(join(evidenceDir, "01-launcher.png"));

  log("step 2: Enter");
  const idsBefore = await bridge.terminalIds();
  await bridge.eval(`const ta = e2e.first(".task-launcher-task"); ta.focus(); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true;`);
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
  const [sid] = await bridge.waitFor("the task's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(idsBefore)}.includes(id));
    return ids.length >= 1 ? ids : null;
  `, { timeoutMs: 30_000 });
  const launchDir = join(app.dataDir, "launch", sid);
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(launchDir, "launch.json")) && Date.now() < deadline) await sleep(200);
  const spec = JSON.parse(readFileSync(join(launchDir, "launch.json"), "utf8"));
  log(`  launch: program ${spec.program}; cwd ${spec.cwd ?? "?"}; args ${JSON.stringify(spec.args.map((a) => (a.length > 120 ? `${a.slice(0, 120)}…` : a)))}`);

  log("step 3: the running claude carries exactly one --add-dir, extra-repo's");
  const tree = await findLaunchTree(sid);
  log(`  hi    : ${tree.hi.pid} ${tree.hi.command.slice(0, 120)}`);
  log(`  claude: ${tree.claude.pid} ${tree.claude.command}`);
  assert(tree.claude.ppid === tree.hi.pid, "claude is the helper's child, not a command typed into the shell");
  // The paths are throwaway temp folders with no spaces: ps's flat command line splits on whitespace safely.
  const argv = tree.claude.command.split(/\s+/);
  const addDirs = argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : a.startsWith("--add-dir=") ? [a.slice(10)] : []));
  const real = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  log(`  --add-dir in the running claude: ${JSON.stringify(addDirs)}`);
  assert(addDirs.length === 1 && real(addDirs[0]) === extra.repo, `exactly one --add-dir, ${extra.repo}`);
  const specAddDirs = spec.args.flatMap((a, i) => (a === "--add-dir" ? [spec.args[i + 1]] : []));
  assert(specAddDirs.length === 1 && real(specAddDirs[0]) === extra.repo, "the launch spec has the same single --add-dir");
  const mainDirs = main
    .git("worktree", "list", "--porcelain")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => real(l.slice(9)));
  log(`  main-repo and its worktrees: ${JSON.stringify(mainDirs)}`);
  const inside = (p, root) => p === root || p.startsWith(`${root}/`);
  assert(addDirs.every((d) => !mainDirs.some((m) => inside(real(d), m))), "no --add-dir points at main-repo or its worktree");

  log("step 4: claude reads SENTINEL.txt in extra-repo and prints the token");
  await answerTrustPrompt(bridge, sid);
  let seen = null;
  let approvals = 0;
  const until = Date.now() + 240_000;
  while (!seen && Date.now() < until) {
    const lines = (await bridge.readTerminal(sid)) ?? [];
    seen = lines.find((l) => l.includes(TOKEN)) ?? (lines.join("").includes(TOKEN) ? "(wrapped across lines)" : null);
    if (seen) break;
    const kind = await bridge.eval(`return e2e.first('.session-status-strip[data-strip-session="${sid}"]')?.dataset.statusKind ?? null;`);
    if (kind === "needs_approval" && approvals < 3) {
      approvals++;
      log("  claude asks for approval: yes");
      await sleep(800);
      await bridge.typeInTerminal(sid, "\n");
      await sleep(1500);
      continue;
    }
    await sleep(500);
  }
  const screen = (await bridge.readTerminal(sid)) ?? [];
  writeFileSync(join(evidenceDir, "terminal.txt"), `${screen.join("\n")}\n`);
  await bridge.screenshot(join(evidenceDir, "02-answer.png"));
  log(`  approvals asked: ${approvals}`);
  assert(!!seen, `the terminal shows the token ${TOKEN}: ${JSON.stringify(seen?.trim?.() ?? seen)}`);
  const done = await waitForStrip(bridge, sid, ["done_unread", "idle"], { timeoutMs: 120_000 }).catch(() => null);
  log(`  strip after the turn: ${JSON.stringify(done)}`);
  await bridge.typeInTerminal(sid, "/exit\n");
  await sleep(1500);
  const exit = await app.stop();
  app = null;
  assert(exit.code === 0, "the app quit cleanly");
  for (const f of guarded) assert(Buffer.compare(before.get(f), readFileSync(f)) === 0, `${f.replace(home, "~")} is byte-identical before and after`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch {
    /* no screenshot */
  }
} finally {
  if (app?.isRunning()) await app.stop();
  rmSync(work, { recursive: true, force: true });
  for (const f of guarded) {
    if (Buffer.compare(before.get(f), readFileSync(f)) !== 0) {
      writeFileSync(f, before.get(f));
      log(`  restored ${f.replace(home, "~")}`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
