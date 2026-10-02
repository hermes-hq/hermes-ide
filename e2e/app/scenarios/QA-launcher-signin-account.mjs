#!/usr/bin/env node
// QA-launcher-signin-account (ACC-01, ACC-13a): the launcher's Sign in for a
// signed-out account Hermes added ("Work") runs the CLI's sign-in in THAT
// account's profile (`claude auth login` with Work's CLAUDE_CONFIG_DIR),
// never an agent session in the default profile; the row names the
// account ("Your Work account for Claude Code is not signed in." with
// "Sign in to Work" and "Check again"); the task typed is still there when
// the launcher comes back.
//
// Negative control: a build before the fix starts a plain `claude` in the
// default profile (no auth login, no Work profile).

import { join } from "node:path";
import { invoke, launcherState, openLauncher, pickInMenu, typeInto } from "../launcher-steps.mjs";
import { logins, records } from "../cap-steps.mjs";
import { runAccountsQa, sleep } from "../qa-launcher-steps.mjs";

const TASK = "Refactor the billing module for the client";

await runAccountsQa("QA-launcher-signin-account", async ({ bridge, f, log, check, assert, evidenceDir }) => {
  const added = await invoke(bridge, "add_agent_account", { agentId: "claude", label: "Work" });
  const workDir = added.account.profileEnv.value;
  assert(added.account.signInState === "signed-out", "Work is a new, signed-out profile");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await pickInMenu(bridge, "agent", '[data-account-id="work"]');
  await bridge.waitFor("the signed-out row for Work", `return !!e2e.first('.task-launcher-block[data-kind="signed-out"][data-account-id="work"]');`, { timeoutMs: 20_000 });
  const row = await bridge.eval(`
    const r = e2e.first('.task-launcher-block[data-kind="signed-out"]');
    return { text: e2e.norm(r.querySelector("span")?.innerText ?? ""), buttons: [...r.querySelectorAll("button")].map((b) => e2e.norm(b.innerText)) };`);
  log(`  row: ${JSON.stringify(row)}`);
  check(row.text === "Your Work account for Claude Code is not signed in.", "the row names the account and the agent");
  check(row.buttons.includes("Sign in to Work") && row.buttons.includes("Check again"), "with Sign in to Work and Check again");
  await bridge.screenshot(join(evidenceDir, "01-work-signed-out.png"));

  const before = new Set(records(f).map((r) => r.file));
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all('.task-launcher-block[data-kind="signed-out"] button').find((b) => /Sign in to Work/.test(b.innerText)), "Sign in to Work"));`);
  const deadline = Date.now() + 30_000;
  while (!logins(f).some((l) => l.profileDir === workDir) && Date.now() < deadline) await sleep(250);
  const signIns = logins(f);
  const launches = records(f).filter((r) => !before.has(r.file));
  log(`  logins: ${JSON.stringify(signIns.map((l) => ({ argv: l.argv, inWork: l.profileDir === workDir })))}`);
  log(`  agent launches after Sign in: ${launches.length}`);
  check(signIns.some((l) => l.profileDir === workDir && l.argv.join(" ") === "auth login"), "Sign in ran `claude auth login` in the Work profile");
  check(launches.every((r) => r.profileDir === workDir), "no agent session was started in another profile");
  await bridge.screenshot(join(evidenceDir, "02-sign-in-terminal.png"));

  // The launcher comes back with the task once the sign-in terminal is closed (or on ⌘N).
  await openLauncher(bridge, { draft: "keep" });
  const again = await launcherState(bridge);
  log(`  launcher again: task="${again.task}" agent="${again.agent}"`);
  check(again.task === TASK, "the typed task is still there");
  check(/Work/.test(again.agent), "the Work account is still chosen");
});
