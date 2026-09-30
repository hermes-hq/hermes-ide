#!/usr/bin/env node
// Scenario F16: the three-step welcome and the agent doctor, on the REAL
// app, with fake `claude`, `codex` and `opencode` CLIs
// (tools/fake-agents/fake-cli.mjs) on the app's PATH. No real account.
//
//   run 1  fresh install: the taskLauncher (and agentCatalog, for OpenCode)
//          flags are turned on while the first welcome is still open, and
//          the app quits without finishing it.
//   run 2  the welcome is the new one, three screens:
//          1 Your agents — as in the classic welcome, the Privacy Policy
//            must be accepted first (same link): Continue waits for it and
//            says why. The doctor shows each fake's version and sign-in
//            state read from the CLI itself (Claude 2.1.300 signed in; Codex
//            0.100.0, below the catalog minimum, signed out, with Sign in;
//            OpenCode 1.18.2), signals and resume; "Usage stats: off"; no
//            Agent-view words. Sign in steps the welcome aside and opens a
//            terminal running the CLI; Back to setup returns.
//          2 Pick a repo — a folder that is not a repository cannot be
//            picked; the test repository can.
//          3 First task — Enter starts Claude in a terminal on a new
//            hermes/<slug> worktree with the task as its first prompt, and
//            the welcome is done (usage stats still off).
//          Settings > Agents shows the same doctor.
//   run 3+4  fresh install again, with no agent on the doctor's PATH: the
//          doctor says none was found, Continue is enabled once the Privacy
//          Policy is accepted (no agent does not block it), the last screen
//          offers a shell, and ⌘T opens another shell.
//   run 5  that profile again: the welcome is not shown again.
//   run 6+7  a profile that accepted the Privacy Policy in the classic
//          welcome (flag off) is not asked again once the flag is on.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_F16_FLAG=off   the flag stays off: the classic 4-step
//                             wizard shows instead.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F16-onboarding-doctor.mjs

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F16-onboarding-doctor";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const onMac = platform() === "darwin";
const FLAG_ON = (process.env.HERMES_E2E_F16_FLAG || "on") !== "off";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── Fixtures ────────────────────────────────────────────────────────

const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f16-")));
const repo = join(work, "f16-repo");
const plain = join(work, "not-a-repo");
const emptyBin = join(work, "no-agents");
mkdirSync(plain, { recursive: true });
mkdirSync(emptyBin, { recursive: true });
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hermes Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Hermes Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
git("config", "user.name", "Hermes Test");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "README.md"), "# f16\n");
git("add", ".");
git("commit", "-q", "-m", "initial");

const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
mkdirSync(fakeBin, { recursive: true });
mkdirSync(recordDir, { recursive: true });
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
const AGENTS = ["claude", "codex", "opencode"];
for (const agent of AGENTS) {
  if (onWindows) {
    writeFileSync(join(fakeBin, `${agent}.cmd`), `@set "HERMES_FAKE_AGENT=${agent}"\r\n@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
  } else {
    writeFileSync(join(fakeBin, agent), `#!/bin/sh\nHERMES_FAKE_AGENT=${agent} exec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
    chmodSync(join(fakeBin, agent), 0o755);
  }
}
const setFake = (file, value) => writeFileSync(join(recordDir, file), `${value}\n`);
setFake("version-claude", "2.1.300");
setFake("version-codex", "0.100.0");
setFake("version-opencode", "1.18.2");
setFake("auth-claude", "in");
setFake("auth-codex", "out");
setFake("auth-opencode", "in");

const isRealAgentDir = (dir) => AGENTS.some((a) => [a, `${a}.exe`, `${a}.cmd`].some((n) => existsSync(join(dir, n))));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !isRealAgentDir(d))].join(delimiter);
for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_") || name.startsWith("OPENAI_")) delete process.env[name];

const canEditRegistryPath = onWindows && process.env.GITHUB_ACTIONS === "true";
function addFakeBinToRegistryPath() {
  if (!canEditRegistryPath) return null;
  let old = null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    const m = out.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
    old = m ? m[1].trim() : "";
  } catch {
    old = null;
  }
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old ? `${old};${fakeBin}` : fakeBin, "/f"]);
  log("  (CI runner: added the fake agents' folder to the user's registry Path)");
  return () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    log("  (CI runner: restored the user's registry Path)");
  };
}
if (onWindows && !canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  log("RESULT: SKIP (Windows outside CI)");
  process.exit(0);
}

const records = () =>
  readdirSync(recordDir)
    .filter((f) => f.startsWith("launch-"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")));
async function waitForRecords(count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = records();
    if (all.length >= count) return all;
    if (Date.now() > deadline) throw new Error(`expected ${count} fake launch records, have ${all.length}`);
    await sleep(200);
  }
}
const samePath = (a, b) => {
  const norm = (p) => {
    try {
      p = realpathSync.native(p);
    } catch {
      /* gone */
    }
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
};

// ─── App steps ───────────────────────────────────────────────────────

const homes = [];
function newHome() {
  if (onWindows) return undefined;
  const h = mkdtempSync(join(tmpdir(), "hermes-e2e-f16-home-"));
  homes.push(h);
  return h;
}
function launch(run, homeDir, { first = false, env = {} } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  // The doctor looks for agents in the fakes' folder only (a test-build
  // override), so no CLI installed on the machine is ever run.
  const common = { runDir, log, env: { HERMES_FAKE_DIR: recordDir, HERMES_E2E_AGENT_PATH: fakeBin, ...env } };
  return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir });
}
const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);
const typeInto = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);
const step = (bridge) =>
  bridge.eval(`
    const d = e2e.first(".setup-dialog");
    return d ? { step: d.getAttribute("data-step"), title: e2e.norm(e2e.first(".setup-title")?.innerText), count: e2e.norm(e2e.first(".setup-step")?.innerText) } : null;
  `);
const doctorRow = (bridge, id) =>
  bridge.eval(`
    const tr = document.querySelector('tr.agent-doctor-row[data-agent-id=${JSON.stringify(id)}]');
    if (!tr) return null;
    const cells = {};
    for (const td of tr.querySelectorAll("td[data-col]")) cells[td.getAttribute("data-col")] = e2e.norm(td.innerText);
    return { installed: tr.getAttribute("data-installed"), signedIn: tr.getAttribute("data-signed-in"), cells, actions: [...tr.querySelectorAll(".agent-doctor-action")].map((b) => e2e.norm(b.innerText)) };
  `);

/** Run 1 of a fresh install: turn the flags on under the first welcome, quit without finishing it. */
async function freshInstallWithFlags(run, homeDir) {
  const app = await launch(run, homeDir, { first: true });
  await app.bridge.waitFor("the first-launch welcome", `return !!e2e.first(".onboarding-dialog, .setup-dialog");`, { timeoutMs: 30_000 });
  await invoke(app.bridge, "set_setting", {
    key: "feature_flag_overrides",
    value: JSON.stringify(FLAG_ON ? { taskLauncher: true, agentCatalog: true, launchHelper: false } : { agentCatalog: true, launchHelper: false }),
  });
  await app.stop();
}

/** Screen 1's Privacy Policy acceptance, as a person reads it. */
const policy = (bridge) =>
  bridge.eval(`
    const box = e2e.first("#setup-policy-accept");
    if (!box) return null;
    const link = e2e.first(".setup-policy-link");
    const cont = e2e.first(".setup-continue");
    return {
      label: e2e.norm(document.querySelector('label[for="setup-policy-accept"]')?.innerText),
      checked: box.checked,
      href: link?.getAttribute("href") ?? null,
      continueDisabled: !!cont?.disabled,
      hint: e2e.norm(e2e.first("#setup-policy-hint")?.innerText ?? ""),
      describedBy: cont?.getAttribute("aria-describedby") ?? null,
    };
  `);
/** Tick "I accept the Privacy Policy" the way a click does. */
async function acceptPolicy(bridge) {
  await bridge.click("#setup-policy-accept");
  await bridge.waitFor("Continue to be enabled", `return e2e.first("#setup-policy-accept")?.checked === true && !e2e.first(".setup-continue").disabled;`);
}

/** The classic four-step welcome, accepting its Privacy Policy. */
async function completeClassicWelcome(bridge) {
  await bridge.waitFor("the classic welcome", `return !!e2e.first(".onboarding-dialog");`, { timeoutMs: 30_000 });
  for (let i = 0; i < 3; i++) {
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, accept] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!accept.checked) e2e.click(accept);
    return true;
  `);
  await bridge.waitFor("Finish to be enabled", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the classic welcome to close", `return !e2e.first(".onboarding-backdrop");`);
}

async function waitForSetup(bridge) {
  await bridge.waitFor("the three-step welcome", `
    if (e2e.first(".onboarding-dialog")) throw new Error("the classic four-step wizard showed instead of the three-step welcome");
    return !!e2e.first(".setup-dialog");
  `, { timeoutMs: 30_000 });
}

let app;
let failed = false;
let undoRegistryPath = null;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}`);
  undoRegistryPath = addFakeBinToRegistryPath();
  const home1 = newHome();

  log("run 1: fresh install; flags on under the first welcome");
  await freshInstallWithFlags(1, home1);

  // ── run 2 ───────────────────────────────────────────────────────
  app = await launch(2, home1);
  let { bridge } = app;
  await waitForSetup(bridge);
  const seen = new Set();

  log("screen 1: Your agents — the doctor");
  let s = await step(bridge);
  seen.add(s.step);
  assert(s.step === "agents" && s.count === "Step 1 of 3", `screen 1 of 3 is "${s.title}"`);
  await bridge.waitFor("the doctor's answer", `return e2e.all("tr.agent-doctor-row[data-agent-id]").length >= 3 && !e2e.first('.agent-doctor[data-loading="true"]');`, { timeoutMs: 60_000 });
  const claude = await doctorRow(bridge, "claude");
  const codex = await doctorRow(bridge, "codex");
  const opencode = await doctorRow(bridge, "opencode");
  log(`  claude: ${JSON.stringify(claude)}`);
  log(`  codex: ${JSON.stringify(codex)}`);
  log(`  opencode: ${JSON.stringify(opencode)}`);
  assert(claude.installed === "true" && claude.cells.version === "2.1.300" && claude.cells["signed-in"] === "Yes", "Claude: installed, 2.1.300, signed in (asked from the CLI itself)");
  assert(claude.cells.signals === "Exact" && claude.cells.resume === "Yes", "Claude: exact signals, can resume");
  assert(codex.installed === "true" && /^0\.100\.0/.test(codex.cells.version) && /Needs 0\.145\.0 or newer/.test(codex.cells.version), "Codex: 0.100.0, flagged below the minimum version");
  assert(codex.cells["signed-in"] === "No" && codex.actions.includes("Sign in"), "Codex: signed out, with Sign in");
  assert(opencode.installed === "true" && opencode.cells.version === "1.18.2" && opencode.cells["signed-in"] === "Yes", "OpenCode: installed, 1.18.2, signed in");
  const gemini = await doctorRow(bridge, "gemini");
  assert(gemini && gemini.installed === "false" && gemini.actions.includes("Copy install command"), "an agent that is not installed offers its install command");
  assert(await bridge.eval(`return !!document.querySelector('tr.agent-doctor-row[data-agent-id="gemini"] .agent-doctor-badge.retired');`), "the retired Gemini CLI is flagged");
  assert(await bridge.eval(`return !!document.querySelector('tr.agent-doctor-row.custom');`), "the Custom agent has a row");
  log("  the Privacy Policy comes first, as in the classic welcome");
  const p0 = await policy(bridge);
  log(`  policy: ${JSON.stringify(p0)}`);
  assert(p0 && p0.label === "I accept the Privacy Policy" && p0.checked === false, "screen 1 asks to accept the Privacy Policy, unticked");
  assert(p0.href === "https://hermes-ide.com/legal", "the link is the same Privacy Policy the classic welcome links");
  assert(p0.continueDisabled && p0.hint === "Accept the Privacy Policy to continue" && p0.describedBy === "setup-policy-hint", "Continue waits for it, and says why (for a screen reader too)");
  await bridge.eval(`e2e.first(".setup-continue").click(); return true;`);
  await sleep(300);
  assert((await step(bridge)).step === "agents", "Continue does nothing until it is accepted");
  const texts = await bridge.eval(`return { usage: e2e.norm(e2e.first(".setup-usage")?.innerText), all: document.querySelector(".setup-dialog").innerText };`);
  assert(texts.usage === "Usage stats: off", "the usage stats line reads off");
  assert(!/agent view/i.test(texts.all), "no Agent-view words on the welcome");
  await bridge.screenshot(join(evidenceDir, "01-doctor.png"));

  log("  Sign in: the welcome steps aside and a terminal runs the CLI");
  let before = await bridge.terminalIds();
  await bridge.clickWhenReady(`
    const btn = document.querySelector('tr.agent-doctor-row[data-agent-id="codex"] .agent-doctor-sign-in');
    return e2e.click(e2e.must(btn, "codex Sign in"));
  `);
  await bridge.waitFor("the setup pill", `return !!e2e.first(".setup-pill") && !e2e.first(".setup-dialog");`);
  await bridge.waitFor("a terminal for signing in", `return window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id)).length === 1;`, { timeoutMs: 30_000 });
  const signInRec = (await waitForRecords(1)).at(-1);
  assert(!signInRec.prompt, "the CLI was started on its own, to sign in");
  await bridge.screenshot(join(evidenceDir, "02-signing-in.png"));
  setFake("auth-codex", "in");
  await bridge.click(".setup-resume");
  await waitForSetup(bridge);
  await bridge.waitFor("codex signed in after Check again", `return document.querySelector('tr.agent-doctor-row[data-agent-id="codex"]')?.getAttribute("data-signed-in") === "yes";`, { timeoutMs: 60_000 });
  log("  back to setup; the doctor now reports Codex signed in");
  await acceptPolicy(bridge);
  await bridge.screenshot(join(evidenceDir, "02b-policy-accepted.png"));
  await bridge.click(".setup-continue");

  log("screen 2: Pick a repo");
  await bridge.waitFor("screen 2", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
  s = await step(bridge);
  seen.add(s.step);
  assert(s.count === "Step 2 of 3", `screen 2 of 3 is "${s.title}"`);
  await typeInto(bridge, ".setup-repo-input", plain);
  await bridge.waitFor("the not-a-repository note", `return e2e.first(".setup-repo-state")?.getAttribute("data-git") === "false";`, { timeoutMs: 20_000 });
  assert(await bridge.eval(`return e2e.first(".setup-continue").disabled;`), "a folder that is not a repository cannot be picked");
  await typeInto(bridge, ".setup-repo-input", repo);
  await bridge.waitFor("the repository check", `return e2e.first(".setup-repo-state")?.getAttribute("data-git") === "true";`, { timeoutMs: 20_000 });
  await bridge.click(".setup-continue");

  log("screen 3: First task");
  await bridge.waitFor("screen 3", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task";`);
  s = await step(bridge);
  seen.add(s.step);
  assert(s.count === "Step 3 of 3", `screen 3 of 3 is "${s.title}"`);
  const TASK = "Add a contributing guide";
  await typeInto(bridge, ".task-launcher-task", TASK);
  // The agent chip: Claude Code.
  await bridge.waitFor("the agent menu", `
    if (e2e.first('.task-launcher-menu[data-menu="agent"]')) return true;
    const chip = e2e.first('[data-chip="agent"]');
    return chip ? (e2e.click(chip), false) : false;
  `, { timeoutMs: 30_000 });
  await bridge.waitFor("Claude Code in the agent menu", `const b = e2e.first('.task-launcher-menu [data-agent-id="claude"]'); return b ? e2e.click(b) : false;`);
  await bridge.waitFor("Launch to be ready", `const b = e2e.first(".task-launcher-launch"); return !!b && !b.disabled;`, { timeoutMs: 30_000 });
  // The project chip's menu shows the repository's path.
  await bridge.waitFor("the project menu", `
    if (e2e.first('.task-launcher-menu[data-menu="project"]')) return true;
    const chip = e2e.first('[data-chip="project"]');
    return chip ? (e2e.click(chip), false) : false;
  `);
  const repoShown = await bridge.eval(`return e2e.first(".task-launcher-repo").value;`);
  assert(samePath(repoShown, repo), "the first task runs in the repository picked on screen 2");
  await bridge.screenshot(join(evidenceDir, "03-first-task.png"));
  before = await bridge.terminalIds();
  const recsBefore = records().length;
  await bridge.eval(`
    const ta = e2e.first(".task-launcher-task");
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return true;
  `);
  await bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop, .setup-pill");`, { timeoutMs: 30_000 });
  const taskId = await bridge.waitFor("the first task's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 30_000 });
  const rec = (await waitForRecords(recsBefore + 1)).at(-1);
  assert(String(rec.argv.at(-1)).split(/\r?\n\r?\n|\s+Read the file at /)[0] === TASK, "Claude got the task as its first prompt");
  const projects = await invoke(bridge, "get_registered_projects");
  const project = projects.find((p) => samePath(p.path, repo));
  const wt = await invoke(bridge, "git_session_worktree_info", { sessionId: taskId, projectId: project.id });
  assert(wt && wt.branchName === "hermes/add-a-contributing-guide" && samePath(rec.cwd, wt.worktreePath), `it runs on its own worktree, branch ${wt?.branchName}`);
  await bridge.waitForTerminal(taskId, /prompt: Add a contributing guide/, { timeoutMs: 20_000 });
  assert(seen.size === 3, `a fresh install reached a running first task in ${seen.size} screens (${[...seen].join(", ")})`);
  const settings = await invoke(bridge, "get_settings");
  assert(settings.onboarding_completed === "true", "the welcome is done");
  assert(settings.telemetry_enabled !== "true", `usage stats stay off (${settings.telemetry_enabled})`);
  await bridge.screenshot(join(evidenceDir, "04-task-running.png"));

  log("Settings > Agents shows the same doctor");
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.clickWhenReady(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Agents");
    return e2e.click(e2e.must(tab, "Agents tab"));
  `);
  await bridge.waitFor("the doctor in Settings", `return !!document.querySelector('.settings-agents-doctor tr.agent-doctor-row[data-agent-id="claude"]');`, { timeoutMs: 30_000 });
  const inSettings = await bridge.eval(`return e2e.norm(document.querySelector('.settings-agents-doctor tr.agent-doctor-row[data-agent-id="claude"] td[data-col="version"]').innerText);`);
  assert(inSettings === "2.1.300", "Settings > Agents lists Claude 2.1.300 too");
  await bridge.screenshot(join(evidenceDir, "05-settings-agents.png"));
  await app.stop();

  // ── runs 3 and 4: no agents at all ───────────────────────────────
  const home2 = newHome();
  log("run 3: another fresh install; flags on");
  await freshInstallWithFlags(3, home2);
  log("run 4: no agent anywhere on the doctor's PATH");
  app = await launch(4, home2, { env: { HERMES_E2E_AGENT_PATH: emptyBin } });
  bridge = app.bridge;
  await waitForSetup(bridge);
  await bridge.waitFor("the doctor's answer", `return e2e.all("tr.agent-doctor-row[data-agent-id]").length >= 3 && !e2e.first('.agent-doctor[data-loading="true"]');`, { timeoutMs: 60_000 });
  const installed = await bridge.eval(`return e2e.all('tr.agent-doctor-row[data-installed="true"]').length;`);
  assert(installed === 0, "no agent is reported installed");
  assert(await bridge.exists(".agent-doctor-none"), "the doctor says none was found and a shell still works");
  assert((await policy(bridge))?.continueDisabled === true, "a fresh install asks for the Privacy Policy here too");
  await acceptPolicy(bridge);
  assert(await bridge.eval(`return !e2e.first(".setup-continue").disabled;`), "Continue stays enabled (no agent does not block it)");
  await bridge.screenshot(join(evidenceDir, "06-no-agents.png"));
  await bridge.click(".setup-continue");
  await bridge.waitFor("screen 2", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
  await bridge.click(".setup-skip");
  await bridge.waitFor("screen 3", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task";`);
  before = await bridge.terminalIds();
  await bridge.click(".setup-open-shell");
  await bridge.waitFor("the welcome to close and a shell to open", `
    return !e2e.first(".setup-backdrop") && window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id)).length === 1;
  `, { timeoutMs: 30_000 });
  before = await bridge.terminalIds();
  if (onMac) {
    await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "file.new-session-tab" } }); return true;`);
  } else {
    await bridge.eval(`
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
  }
  await bridge.waitFor("⌘T to open another shell", `return window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id)).length === 1;`, { timeoutMs: 30_000 });
  log("  ⌘T opened a shell");
  await bridge.screenshot(join(evidenceDir, "07-shell.png"));
  await app.stop();

  // ── run 5: this profile finished the welcome: not asked again ───────
  log("run 5: the same profile again: the welcome (and its Privacy Policy) is not shown again");
  app = await launch(5, home2, { env: { HERMES_E2E_AGENT_PATH: emptyBin } });
  await app.bridge.waitFor("the app UI", `return !!e2e.first(".topbar");`, { timeoutMs: 30_000 });
  await sleep(2000);
  assert(!(await app.bridge.exists(".setup-dialog, .onboarding-dialog, #setup-policy-accept")), "a profile that finished the welcome is not asked again");
  await app.stop();

  // ── runs 6 and 7: accepted in the classic welcome, then the new one ──
  const home3 = newHome();
  log("run 6: a profile that accepted the Privacy Policy in the classic welcome (flag off)");
  app = await launch(6, home3, { first: true });
  await completeClassicWelcome(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ taskLauncher: true, agentCatalog: true, launchHelper: false }) });
  await app.stop();
  log("run 7: the three-step welcome is on now; that profile is not asked again");
  app = await launch(7, home3);
  await app.bridge.waitFor("the app UI", `return !!e2e.first(".topbar");`, { timeoutMs: 30_000 });
  await sleep(2000);
  assert(!(await app.bridge.exists(".setup-dialog, .onboarding-dialog, #setup-policy-accept")), "a profile that accepted in the classic welcome is not asked again");
  await app.bridge.screenshot(join(evidenceDir, "08-existing-profile.png"));
  await app.stop();
  app = null;
} catch (err) {
  failed = true;
  log(`ERROR: ${err.stack || err.message || err}`);
  if (app) {
    try {
      await app.bridge.screenshot(join(evidenceDir, "failure.png"));
    } catch {
      /* no screenshot */
    }
  }
} finally {
  if (app) {
    try {
      await app.stop();
    } catch {
      /* already gone */
    }
  }
  if (undoRegistryPath) {
    try {
      undoRegistryPath();
    } catch (e) {
      log(`could not restore the registry Path: ${e.message}`);
    }
  }
  if (!failed) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* best effort */
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
