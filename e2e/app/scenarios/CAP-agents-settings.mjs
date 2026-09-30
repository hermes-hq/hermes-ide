#!/usr/bin/env node
// Scenario CAP-agents-settings: Settings > Agents, accounts, presets and the
// usual launch combination (2.0 launch contract), with fake `claude`,
// `codex` and `agy` CLIs that answer the capability probes like the real
// ones (tools/fake-agents/fake-cli.mjs).
//
//   1. Settings > Agents shows each installed agent: version, the "Verified
//      on a real install" badge (Claude, Codex, Antigravity), its accounts
//      and whether they are signed in (Claude's plan, never an e-mail),
//      what can be chosen at launch (Claude's aliases and effort levels,
//      Codex's own model list, Antigravity's), and exact status.
//   2. + Add account on Claude: a name, "Add and sign in" creates the
//      profile folder (in the test's profile root), opens a terminal running
//      `claude auth login` with CLAUDE_CONFIG_DIR set to it; after the
//      sign-in, Check again shows the account signed in.
//   3. Presets saved by the launcher are listed; one whose model the agent
//      no longer offers says what changes at launch; Rename and Delete work
//      from the screen and stick.
//   4. The usual combination of a repository is its most frequent recent
//      launch (a tie goes to the most recent); another repository falls back
//      to the global usual; a stored model that is gone comes back as the
//      default model, flagged; after three identical launches "Save as
//      preset?" is offered once, and never again once dismissed.
//
// Negative control: HERMES_E2E_CAP_NEGATIVE=1 signs the fake Claude out, so
// step 1's "the default Claude account is signed in" FAILS.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/CAP-agents-settings.mjs

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { createLogger, finishScenario, outDir, sleep, skipScenario } from "../harness.mjs";
import {
  agentCard,
  closeSettings,
  completeOnboarding,
  invoke,
  launch,
  logins,
  openAgentsSettings,
  registryPath,
  removeWork,
  setFake,
  setupFakes,
} from "../cap-steps.mjs";

const SCENARIO = "CAP-agents-settings";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const NEGATIVE = process.env.HERMES_E2E_CAP_NEGATIVE === "1";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const f = setupFakes("cap-settings", ["claude", "codex", "agy"]);
const restorePath = registryPath(f, log);
if (restorePath === null) {
  log("this scenario needs the fake agents on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}
setFake(f, "version", "claude", "2.1.284");
setFake(f, "version", "codex", "0.145.0");
setFake(f, "version", "antigravity", "1.0.6");
if (NEGATIVE) setFake(f, "auth", "claude", "out");

/** A launch choice as the launcher builds it. */
const choice = (over = {}) => ({
  agentId: "claude",
  accountId: "default",
  approvalModeId: "acceptEdits",
  modelId: "opus",
  effort: "high",
  extraArgs: "",
  prefix: "",
  channels: [],
  where: { kind: "new-worktree", baseBranch: "main", branch: "hermes/some-task" },
  trackAsFeature: false,
  ...over,
});

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}${NEGATIVE ? " (NEGATIVE CONTROL: the fake Claude is signed out)" : ""}`);
  app = await launch(f, evidenceDir, log, 1, { first: true });
  const { bridge } = app;
  await completeOnboarding(bridge);

  // ─── 1. what each agent offers ─────────────────────────────────────
  log("step 1: Settings > Agents");
  await openAgentsSettings(bridge);
  const claude = await agentCard(bridge, "claude");
  const codex = await agentCard(bridge, "codex");
  const agy = await agentCard(bridge, "antigravity");
  log(`  claude: ${JSON.stringify(claude)}`);
  log(`  codex: ${JSON.stringify(codex)}`);
  log(`  agy: ${JSON.stringify(agy)}`);
  assert(claude && codex && agy, "a card per installed agent (Claude Code, Codex, Antigravity)");
  assert([claude, codex, agy].every((c) => c.verified === "true" && c.verifiedText === "✓ Verified on a real install"), "all three are marked verified on a real install");
  assert(!(await bridge.exists('.agents-settings-card[data-agent-id="copilot"]')), "agents that are not installed have no card");
  assert(claude.accounts.length === 1 && claude.accounts[0].id === "default" && claude.accounts[0].state === "signed-in", "the default Claude account is signed in");
  assert(claude.accounts[0].text.includes("Max plan") && !/@|example\.com|Fake Org/.test(claude.accounts[0].text), `Claude's plan is shown, never the e-mail or org ("${claude.accounts[0].text}")`);
  assert(claude.models === "Models: default, opus, sonnet, haiku, opusplan", `Claude's aliases ("${claude.models}")`);
  assert(claude.effort === "Effort: low · medium · high · xhigh · max", `Claude's effort levels ("${claude.effort}")`);
  assert(claude.approval.startsWith("Approval: Ask · Accept edits · Plan first · Auto"), `Claude's approval modes ("${claude.approval}")`);
  assert(claude.status === "exact" && claude.canAdd, "exact status; accounts can be added");
  assert(codex.models === "Models: from Codex's own list (3)" && codex.accounts[0].text.startsWith("Default profile · ChatGPT account · signed in"), `Codex: its own model list, its ChatGPT sign-in ("${codex.models}")`);
  assert(agy.models === "Models: from Antigravity CLI's own list (3)" && agy.note === "One account per computer user (Antigravity has no profiles)" && !agy.canAdd, "Antigravity: its model list, one account per user, no Add account");
  await bridge.screenshot(join(evidenceDir, "01-agents.png"));

  // ─── 2. add an account ─────────────────────────────────────────────
  log("step 2: + Add account on Claude opens its sign-in in a new profile");
  const idsBefore = await bridge.terminalIds();
  await bridge.click('.agents-settings-card[data-agent-id="claude"] .agents-settings-add');
  await bridge.waitFor("the account name field", `return !!e2e.first('.agents-settings-card[data-agent-id="claude"] .agents-settings-add-name');`);
  await bridge.eval(`
    const el = e2e.first('.agents-settings-card[data-agent-id="claude"] .agents-settings-add-name');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "Work");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await bridge.click('.agents-settings-card[data-agent-id="claude"] .agents-settings-add-confirm');
  const profile = join(f.profileRoot, ".claude-work");
  const login = await (async () => {
    const deadline = Date.now() + 40_000;
    for (;;) {
      const l = logins(f).find((x) => x.profileDir === profile);
      if (l) return l;
      if (Date.now() > deadline) throw new Error(`no sign-in ran in ${profile} (logins: ${JSON.stringify(logins(f))})`);
      await sleep(200);
    }
  })();
  assert(existsSync(profile) && statSync(profile).isDirectory(), "the profile folder was created, in the test's profile root");
  if (platform() !== "win32") assert((statSync(profile).mode & 0o777) === 0o700, "private to the user (0700)");
  assert(login.argv.join(" ") === "auth login" && login.profileEnv === "CLAUDE_CONFIG_DIR", "a terminal ran `claude auth login` with CLAUDE_CONFIG_DIR set to it");
  const idsAfter = await bridge.terminalIds();
  assert(idsAfter.some((id) => !idsBefore.includes(id)), "in a terminal session of its own");
  await bridge.screenshot(join(evidenceDir, "02-sign-in-terminal.png"));
  await openAgentsSettings(bridge);
  await bridge.click(".agents-settings-refresh");
  await bridge.waitFor("Work signed in", `
    const a = e2e.first('.agents-settings-card[data-agent-id="claude"] .agents-settings-account[data-account-id="work"]');
    return a && a.dataset.signedIn === "signed-in" ? e2e.norm(a.innerText) : null;
  `, { timeoutMs: 40_000 });
  const claude2 = await agentCard(bridge, "claude");
  const work = claude2.accounts.find((a) => a.id === "work");
  assert(work.text.startsWith("Work · Max plan · signed in · profile "), `Check again: Work is signed in ("${work.text}")`);
  const defaultStill = claude2.accounts.find((a) => a.id === "default");
  assert(defaultStill.state === "signed-in", "the default profile was left alone");
  assert(readdirSync(f.profileRoot).join(",") === ".claude-work", "no other profile folder was created");
  await bridge.screenshot(join(evidenceDir, "03-work-signed-in.png"));

  // ─── 3. presets ────────────────────────────────────────────────────
  log("step 3: presets from the launcher, listed, renamed, deleted");
  const deep = await invoke(bridge, "save_launch_preset", { name: "Claude deep", choice: choice({ accountId: "work" }) });
  const stale = await invoke(bridge, "save_launch_preset", { name: "Codex old", choice: choice({ agentId: "codex", approvalModeId: "auto", modelId: "gpt-retired", effort: "ultra" }) });
  log(`  saved: ${JSON.stringify(deep)}`);
  assert(deep.launchable && deep.issues.length === 0, "a valid preset reads back unchanged");
  log(`  stale preset: ${JSON.stringify(stale.issues)}`);
  assert(stale.launchable && stale.effective.modelId === "default" && stale.issues[0].field === "model", "a preset whose model is gone launches the default model, flagged");
  assert(stale.effective.effort === "xhigh" && stale.issues.some((i) => i.field === "effort" && i.now === "xhigh"), "and the nearest effort the default takes");
  await closeSettings(bridge);
  await openAgentsSettings(bridge);
  const rows = await bridge.eval(`return e2e.all(".agents-settings-preset").map((p) => ({ id: p.dataset.presetId, name: e2e.norm(p.querySelector(".agents-settings-preset-name")?.innerText ?? ""), choice: e2e.norm(p.querySelector(".agents-settings-preset-choice").innerText), issues: e2e.norm(p.querySelector(".agents-settings-preset-issues")?.innerText ?? "") }));`);
  log(`  listed: ${JSON.stringify(rows)}`);
  assert(rows.length === 2 && rows[0].name === "Claude deep" && rows[0].choice === "Claude Code · work · opus · high · acceptEdits", "the presets are listed with their choice");
  assert(rows[1].issues.startsWith("Changed at launch: gpt-retired is not offered by Codex any more; using the default model"), `the stale one says what changes ("${rows[1].issues}")`);
  await bridge.click(`.agents-settings-preset[data-preset-id="${deep.id}"] .agents-settings-preset-rename`);
  await bridge.eval(`
    const el = e2e.first('.agents-settings-preset[data-preset-id="${deep.id}"] .agents-settings-preset-name-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "Claude deep work");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await bridge.click(`.agents-settings-preset[data-preset-id="${deep.id}"] .agents-settings-preset-save`);
  await bridge.waitFor("the new name", `return e2e.norm(e2e.first('.agents-settings-preset[data-preset-id="${deep.id}"] .agents-settings-preset-name')?.innerText ?? "") === "Claude deep work";`);
  await bridge.click(`.agents-settings-preset[data-preset-id="${stale.id}"] .agents-settings-preset-delete`);
  await bridge.waitFor("the deleted preset to go", `return !e2e.first('.agents-settings-preset[data-preset-id="${stale.id}"]');`);
  const stored = await invoke(bridge, "list_launch_presets");
  assert(stored.length === 1 && stored[0].name === "Claude deep work", "rename and delete stuck");
  await bridge.screenshot(join(evidenceDir, "04-presets.png"));
  await closeSettings(bridge);

  // ─── 4. the usual combination ──────────────────────────────────────
  log("step 4: the usual combination per repository");
  const repoA = f.repo;
  const repoB = join(f.work, "other-repo");
  const A = choice({ modelId: "sonnet", effort: "medium" });
  const B = choice({ agentId: "codex", approvalModeId: "auto", modelId: "gpt-fake-luna", effort: "medium" });
  const fresh = await invoke(bridge, "get_usual_launch_choice", { repo: repoA });
  assert(fresh.source === "catalog" && fresh.choice.agentId === "claude" && fresh.choice.modelId === "default" && fresh.choice.approvalModeId === "acceptEdits", "with no history: the catalog default (Claude, default model, its safety default)");
  for (const c of [A, A, B, B]) await invoke(bridge, "remember_launch_choice", { choice: { ...c, where: { ...c.where, branch: `hermes/task-${Math.random().toString(36).slice(2, 7)}` } }, repo: repoA });
  const tie = await invoke(bridge, "get_usual_launch_choice", { repo: repoA });
  assert(tie.source === "repo" && tie.choice.agentId === "codex" && tie.count === 2, "a tie goes to the most recent combination (Codex)");
  assert(tie.choice.where.kind === "new-worktree" && tie.choice.where.branch === "", "the branch is left for the next task to name");
  const third = await invoke(bridge, "remember_launch_choice", { choice: A, repo: repoA });
  assert(third.count === 3 && third.suggestPreset === true, "the third identical launch offers Save as preset?");
  const usualA = await invoke(bridge, "get_usual_launch_choice", { repo: repoA });
  assert(usualA.choice.agentId === "claude" && usualA.choice.modelId === "sonnet" && usualA.count === 3, "the most frequent combination wins (Claude sonnet, 3)");
  await invoke(bridge, "dismiss_preset_suggestion", { choice: A, repo: repoA });
  const fourth = await invoke(bridge, "remember_launch_choice", { choice: A, repo: repoA });
  assert(fourth.count === 4 && fourth.suggestPreset === false, "dismissed: never offered again for that combination");
  const other = await invoke(bridge, "get_usual_launch_choice", { repo: repoB });
  assert(other.source === "global" && other.choice.modelId === "sonnet", "a repository without history gets the global usual");
  await invoke(bridge, "remember_launch_choice", { choice: choice({ agentId: "codex", approvalModeId: "auto", modelId: "gpt-gone", effort: "max" }), repo: repoB });
  const checked = await invoke(bridge, "get_usual_launch_choice", { repo: repoB });
  log(`  stored gone model: ${JSON.stringify(checked.issues)}`);
  assert(checked.source === "repo" && checked.choice.modelId === "default" && checked.launchable, "a stored model that is gone comes back as the default model");
  assert(checked.issues.some((i) => i.field === "model" && i.was === "gpt-gone"), "flagged with the reason");
  const remembered = await invoke(bridge, "get_remembered_launch_choice", { agentId: "claude", accountId: "default" });
  assert(remembered?.choice.modelId === "sonnet", "the choice is remembered per agent and account");

  const exit = await app.stop();
  assert(exit.code === 0, "the app quit cleanly");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) await app.stop();
  try {
    cpSync(f.recordDir, join(evidenceDir, "fake-records"), { recursive: true });
  } catch {
    /* nothing recorded */
  }
  restorePath?.();
  removeWork(f, log);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
