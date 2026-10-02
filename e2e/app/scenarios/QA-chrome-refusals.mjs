#!/usr/bin/env node
// Scenario QA-chrome-refusals: what Hermes remembers about a refused model,
// with fake `claude` and `codex` CLIs (tools/fake-agents) and a throwaway
// repository. No real account.
//
//   1. ACC-03: Claude refuses opus at a launch: the launcher shows it as
//      refused. Later opus launches and finishes a turn: it is offered
//      again. Refused once more, "Check again" in Settings > Agents forgets
//      the refusal too.
//   2. ACC-06: Codex's own default model (`model` in its config.toml under
//      CODEX_HOME, no -m on the launch) is refused: the banner names that
//      model and the file it is set in (CODEX_HOME's, not ~/.codex's), and the launcher's "default" no longer promises it
//      always works; it says the account refused it.
//
// Negative control (must end in RESULT: FAIL): a build of main before the
// fix (opus stays refused for good; the banner says "Codex refused its
// default model" and the launcher still says "always works").
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/QA-chrome-refusals.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { fakeEnv, invoke, launchWithChoice, onWindows, openAgentsSettings, closeSettings, registryPath, removeWork, setFake, setupFakes, waitForRecord } from "../cap-steps.mjs";
import { completeTaskWelcome, openChip, openLauncher, pickInMenu } from "../launcher-steps.mjs";
import { runScenario } from "../n11-steps.mjs";

const SCENARIO = "QA-chrome-refusals";

/** The test app with the real flag defaults; Windows keeps its data under %APPDATA% (a fresh one on the first run). */
function startApp(f, evidenceDir, log, run, { first = false, env = {} } = {}) {
  const common = { runDir: join(evidenceDir, `run-${run}`), log, env: { ...fakeEnv(f), ...env }, flagDefaults: {} };
  return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir: f.home });
}

/** A path as the app shows it: under the home folder as ~/… with "/" (Windows ignores case). */
function homeRelative(path) {
  const home = homedir().replace(/[\\/]+$/, "");
  const head = path.slice(0, home.length);
  const same = onWindows ? head.toLowerCase() === home.toLowerCase() : head === home;
  if (!same || !/[\\/]/.test(path.charAt(home.length))) return path;
  return `~/${path.slice(home.length + 1).replace(/\\/g, "/")}`;
}

const caps = (bridge, agentId) =>invoke(bridge, "get_agent_capabilities", { agentId, accountId: null, refresh: false });
const opusOf = async (bridge) => (await caps(bridge, "claude")).models.find((m) => m.id === "opus");

/** The launcher's model menu item for `modelId` of `agentId`: disabled, and its text. */
async function launcherModel(bridge, agentId, modelId) {
  await openLauncher(bridge);
  await pickInMenu(bridge, "agent", `[data-agent-id="${agentId}"]`);
  await openChip(bridge, "model");
  const item = await bridge.waitFor(`the ${modelId} item`, `
    const b = e2e.first('.task-launcher-menu [data-model-id="${modelId}"]');
    return b ? { off: b.disabled || b.getAttribute("aria-disabled") === "true", text: e2e.norm(b.innerText) } : null;
  `);
  await bridge.eval(`const t = document.activeElement || document.body; for (let i = 0; i < 2; i++) t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 10_000 }).catch(async () => {
    await bridge.eval(`e2e.first(".task-launcher-close")?.click(); return true;`);
  });
  return item;
}

await runScenario(SCENARIO, async ({ evidenceDir, log, apps, onCleanup }) => {
  const f = setupFakes("qa-refusals", ["claude", "codex"]);
  onCleanup(() => removeWork(f, log));
  const restorePath = registryPath(f, log);
  if (restorePath === null) {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI (the fakes need the registry Path)", log });
  }
  onCleanup(() => restorePath?.());
  setFake(f, "version", "claude", "2.1.284");
  setFake(f, "version", "codex", "0.145.0");
  // Codex's own default, as a person sets it in its config (a Codex home of
  // the test's own, signed in, so no real one is read or written).
  const codexHome = join(f.work, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.2-codex"\n');
  writeFileSync(join(codexHome, ".fake-auth"), "in\n");

  const problems = [];
  const check = (ok, message) => {
    log(`  ${ok ? "ok" : "FAILED"} — ${message}`);
    if (!ok) problems.push(message);
  };

  // The real flag defaults: the launcher and its welcome are on.
  const app = await startApp(f, evidenceDir, log, 1, { first: true, env: { CODEX_HOME: codexHome } });
  apps.push(app);
  const { bridge } = app;
  await completeTaskWelcome(bridge, f.repo);

  // ─── 1. a refusal is forgotten once the model works ────────────────
  log("step 1: Claude refuses opus, then opus works");
  setFake(f, "reject-models", "claude", "opus");
  const s1 = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "first try", modelId: "opus" });
  await bridge.waitFor("the refusal", `return !!e2e.first('.launch-rejected[data-session-id="${s1}"]');`, { timeoutMs: 40_000 });
  check((await opusOf(bridge))?.available === false, "after the refusal opus is marked refused");

  setFake(f, "reject-models", "claude", "");
  const s2 = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "second try, the plan was upgraded", modelId: "opus" });
  await waitForRecord(f, "the second launch started", (r) => r.env?.HERMES_SESSION_ID === s2 && r.hooksRan?.some((h) => h.event === "SessionStart"), 40_000);
  await sleep(1000);
  await bridge.typeInTerminal(s2, "ws"); // a prompt (UserPromptSubmit), then a finished turn (Stop)
  const rec = await waitForRecord(f, "the working launch's finished turn", (r) => r.env?.HERMES_SESSION_ID === s2 && r.hooksRan?.some((h) => h.event === "Stop"), 40_000);
  log(`  the second launch ran a turn: ${JSON.stringify(rec.hooksRan.map((h) => h.event))}, model ${rec.model}`);
  const back = await bridge
    .waitFor("opus offered again", `
      const c = await window.__TAURI_INTERNALS__.invoke("get_agent_capabilities", { agentId: "claude", accountId: null, refresh: false });
      return c.models.find((m) => m.id === "opus")?.available === true;
    `, { timeoutMs: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(back, "a model that has since launched and finished a turn is no longer marked refused");
  const item = await launcherModel(bridge, "claude", "opus");
  log(`  launcher opus: ${JSON.stringify(item)}`);
  check(!item.off, "the launcher offers opus again");
  await bridge.screenshot(join(evidenceDir, "01-opus-again.png"));

  log("step 1b: refused once more, Check again forgets it too");
  setFake(f, "reject-models", "claude", "opus");
  const s3 = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "third try", modelId: "opus" });
  await bridge.waitFor("the refusal", `return !!e2e.first('.launch-rejected[data-session-id="${s3}"]');`, { timeoutMs: 40_000 });
  setFake(f, "reject-models", "claude", "");
  check((await opusOf(bridge))?.available === false, "refused again: marked refused again");
  await openAgentsSettings(bridge);
  const hint = await bridge.eval(`return e2e.first(".agents-settings-refresh")?.title ?? "";`);
  check(/refused models again/.test(hint), `Check again says it also offers refused models again ("${hint}")`);
  await bridge.click(".agents-settings-refresh");
  await bridge.waitFor("the check to finish", `return e2e.first(".agents-settings")?.dataset.loading === "false";`, { timeoutMs: 60_000 });
  await sleep(500);
  const line = await bridge.eval(`return e2e.norm(e2e.first('.agents-settings-card[data-agent-id="claude"] .agents-settings-models')?.innerText ?? "");`);
  log(`  after Check again: "${line}"`);
  check((await opusOf(bridge))?.available === true && !/refused/.test(line), "Check again offers the refused model again");
  await closeSettings(bridge);

  // ─── 2. Codex's own default refused ────────────────────────────────
  log("step 2: Codex's default model (from its config.toml) is refused");
  setFake(f, "reject-models", "codex", "gpt-5.2-codex");
  const s4 = await launchWithChoice(bridge, { agentId: "codex", cwd: f.repo, task: "default model try" });
  await bridge.waitFor("the refusal", `return !!e2e.first('.launch-rejected[data-session-id="${s4}"]');`, { timeoutMs: 40_000 });
  const rec4 = await waitForRecord(f, "the codex launch", (r) => r.env?.HERMES_SESSION_ID === s4, 20_000);
  log(`  codex ran ${rec4.model} (no -m: ${!rec4.argv?.includes?.("-m")})`);
  const banner = await bridge.eval(`
    const b = e2e.first('.launch-rejected[data-session-id="${s4}"]');
    return { title: e2e.norm(b.querySelector(".launch-rejected-title").innerText), actions: [...b.querySelectorAll(".launch-rejected-action")].map((a) => a.dataset.action) };
  `);
  log(`  banner: ${JSON.stringify(banner)}`);
  // CODEX_HOME points Codex's default profile at the test's folder: the
  // banner names the file there, not the catalog's ~/.codex/config.toml.
  // Shown as the app shows paths: under the home folder as ~/…, with "/".
  const configFile = homeRelative(join(codexHome, "config.toml"));
  check(banner.title === `Codex's default model, gpt-5.2-codex (set in ${configFile}), isn't available on your default account`, `the banner names the default model and the config file CODEX_HOME points at ("${banner.title}")`);
  check(!banner.actions.includes("retry-default") && banner.actions.includes("pick-model"), "it offers another model, not the same default again");
  await bridge.screenshot(join(evidenceDir, "02-codex-default-banner.png"));
  const codex = await caps(bridge, "codex");
  const def = codex.models.find((m) => m.id === "default");
  log(`  codex default: ${JSON.stringify(def)}`);
  check(def?.available === true && def?.unavailableCode === "refused" && /gpt-5\.2-codex/.test(def?.unavailableReason ?? ""), "Hermes remembers the refused default, by name, and still lets it be chosen");
  const defItem = await launcherModel(bridge, "codex", "default");
  log(`  launcher default: ${JSON.stringify(defItem)}`);
  check(!/always works/.test(defItem.text), `the launcher no longer promises the default "always works" ("${defItem.text}")`);
  check(/refused/.test(defItem.text), "the launcher says the account refused it");
  await bridge.screenshot(join(evidenceDir, "03-launcher-default.png"));

  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
});
