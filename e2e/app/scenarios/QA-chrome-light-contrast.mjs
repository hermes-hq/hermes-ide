#!/usr/bin/env node
// Scenario QA-chrome-light-contrast (NEWCOMER-17): in the Frosted Light
// theme every text a newcomer meets keeps WCAG AA contrast (4.5:1, 3:1 for
// large text), measured on screen as painted (e2e/app/a11y.mjs
// contrastAudit): the welcome, the session pane with a Claude task (its
// Compose button and command count), and Settings > Agents (Verified,
// Exact status, + Add account). On the REAL app with a fake `claude`.
//
// Negative control (must end in RESULT: FAIL): a build of main before the
// fix (five texts between 3.08:1 and 3.94:1).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/QA-chrome-light-contrast.mjs

import { join } from "node:path";
import { contrastAudit } from "../a11y.mjs";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { fakeEnv, invoke, launchWithChoice, onWindows, openAgentsSettings, registryPath, removeWork, setFake, setupFakes } from "../cap-steps.mjs";
import { completeTaskWelcome } from "../launcher-steps.mjs";
import { runScenario } from "../n11-steps.mjs";

const SCENARIO = "QA-chrome-light-contrast";

/** The test app with the real flag defaults; Windows keeps its data under %APPDATA% (a fresh one on the first run). */
function startApp(f, evidenceDir, log, run, { first = false, env = {} } = {}) {
  const common = { runDir: join(evidenceDir, `run-${run}`), log, env: { ...fakeEnv(f), ...env }, flagDefaults: {} };
  return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir: f.home });
}

await runScenario(SCENARIO, async ({ evidenceDir, log, apps, onCleanup }) => {
  const f = setupFakes("qa-light", ["claude"]);
  onCleanup(() => removeWork(f, log));
  const restorePath = registryPath(f, log);
  if (restorePath === null) {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI (the fakes need the registry Path)", log });
  }
  onCleanup(() => restorePath?.());
  setFake(f, "version", "claude", "2.1.300");

  const low = {};
  const audit = async (bridge, label, selector) => {
    const found = await contrastAudit(bridge, selector);
    log(`  ${label}: ${found.length} text(s) below AA ${JSON.stringify(found.slice(0, 8))}`);
    if (found.length) low[label] = found;
    await bridge.screenshot(join(evidenceDir, `${label}.png`));
  };

  log("the Frosted Light theme, set before the first window paints");
  let app = await startApp(f, evidenceDir, log, 1, { first: true });
  apps.push(app);
  await app.bridge.waitFor("the welcome", `return !!e2e.first(".setup-dialog");`, { timeoutMs: 30_000 });
  await invoke(app.bridge, "set_setting", { key: "theme", value: "frosted-light" });
  await app.stop();
  apps.length = 0;
  app = await startApp(f, evidenceDir, log, 2);
  apps.push(app);
  const { bridge } = app;
  await bridge.waitFor("the light welcome", `return !!e2e.first(".setup-dialog") && document.documentElement.getAttribute("data-theme") === "frosted-light";`, { timeoutMs: 30_000 });
  await bridge.waitFor("the doctor's answer", `return e2e.first(".agent-doctor")?.dataset.loading === "false" && e2e.all("tr.agent-doctor-row").length > 0;`, { timeoutMs: 60_000 });
  await audit(bridge, "01-welcome", ".setup-dialog");
  await completeTaskWelcome(bridge, f.repo);

  log("a Claude task in a terminal");
  await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "Add a contributing guide" });
  await bridge.waitFor("the session's actions bar", `return !!e2e.first(".pab-compose-btn");`, { timeoutMs: 30_000 }).catch(() => log("  (no Compose button on this session)"));
  await sleep(1500);
  await audit(bridge, "02-main-with-task", null);

  log("Settings > Agents");
  await openAgentsSettings(bridge);
  await sleep(500);
  await audit(bridge, "03-settings-agents", '[role="dialog"]');

  const total = Object.values(low).reduce((n, l) => n + l.length, 0);
  if (total) throw new Error(`${total} text(s) below WCAG AA in the light theme: ${JSON.stringify(low)}`);
  log("  ok — every audited text meets WCAG AA in the light theme");
});
