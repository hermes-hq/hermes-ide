#!/usr/bin/env node
// QA-launcher-default-signed-out (ACC-04): Claude's DEFAULT profile is
// signed out, the "Work" account Hermes added is signed in. On Work, the
// launcher does not say "Claude Code is signed out" and Launch is enabled
// (the agent doctor only checks the default profile); the agent menu says
// "default profile signed out · Work signed in". The task launches on Work.
//
// Negative control: a build before the fix blocks Work with the default
// profile's "signed out" row.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { invoke, launcherState, openChip, openLauncher, pickInMenu, typeInto } from "../launcher-steps.mjs";
import { records, setFake, waitForRecord } from "../cap-steps.mjs";
import { runAccountsQa, sleep } from "../qa-launcher-steps.mjs";

await runAccountsQa("QA-launcher-default-signed-out", async ({ bridge, f, log, check, assert, evidenceDir }) => {
  const added = await invoke(bridge, "add_agent_account", { agentId: "claude", label: "Work" });
  const workDir = added.account.profileEnv.value;
  writeFileSync(join(workDir, ".fake-auth"), "in\n");
  setFake(f, "auth", "claude", "out");
  await invoke(bridge, "agent_doctor", { includeBeta: true }).catch(() => null);
  const caps = await invoke(bridge, "get_agent_capabilities", { agentId: "claude", accountId: null, refresh: true });
  log(`  accounts: ${JSON.stringify(caps.accounts.map((a) => `${a.id}:${a.signInState}`))}`);
  assert(caps.accounts.find((a) => a.id === "work").signedIn && !caps.accounts.find((a) => a.id === "default").signedIn, "default is signed out, Work is signed in");

  await openLauncher(bridge);
  // The doctor is asked again by the sheet: the default profile reads signed out from now on.
  await sleep(1500);
  await openChip(bridge, "agent");
  const note = await bridge.eval(`return e2e.norm(e2e.first('.task-launcher-menu [data-agent-id="claude"]')?.innerText ?? "");`);
  log(`  agent menu: ${note}`);
  check(/default profile signed out · Work signed in/.test(note), "the agent menu says which profile is signed in");
  await typeInto(bridge, ".task-launcher-task", "Client work on the Work account");
  await pickInMenu(bridge, "agent", '[data-account-id="work"]');
  await sleep(1500);
  const st = await launcherState(bridge);
  log(`  launcher: ${JSON.stringify({ agent: st.agent, blocks: st.blocks, launchDisabled: st.launchDisabled })}`);
  await bridge.screenshot(join(evidenceDir, "01-work.png"));
  check(/Claude Code · Work/.test(st.agent), "Work is chosen");
  check(!st.blocks.some((b) => b.kind === "signed-out"), "no 'signed out' row for a signed-in account");
  check(!st.launchDisabled, "Launch is enabled");
  if (!st.launchDisabled) {
    const before = new Set(records(f).map((r) => r.file));
    await bridge.click(".task-launcher-launch");
    const rec = await waitForRecord(f, "the launch on Work", (r) => !before.has(r.file), 30_000);
    check(rec.profileDir === workDir, "the task runs in the Work profile");
  }
});
