#!/usr/bin/env node
// QA-launcher-preset-account-held (ACC-05): a preset saved for the "Work"
// account (a client's paid seat) never launches on the default profile by
// itself once Work's sign-in has expired. The launcher keeps the preset on
// Work, says 'The preset "Client X" uses your Work account, which is signed
// out.' with "Sign in to Work" and "Use the default profile this time", and
// Launch waits; only that explicit choice launches on the default profile.
//
// Negative control: a build before the fix swaps to the default profile
// with a one-line note and keeps Launch enabled.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invoke, launcherState, openLauncher, typeInto, waitLaunchEnabled } from "../launcher-steps.mjs";
import { records, waitForRecord } from "../cap-steps.mjs";
import { runAccountsQa, sleep } from "../qa-launcher-steps.mjs";

await runAccountsQa("QA-launcher-preset-account-held", async ({ bridge, f, log, check, assert, evidenceDir }) => {
  const added = await invoke(bridge, "add_agent_account", { agentId: "claude", label: "Work" });
  const workDir = added.account.profileEnv.value;
  writeFileSync(join(workDir, ".fake-auth"), "in\n");
  await invoke(bridge, "get_agent_capabilities", { agentId: "claude", accountId: null, refresh: true });
  const preset = await invoke(bridge, "save_launch_preset", {
    name: "Client X",
    choice: { agentId: "claude", accountId: "work", approvalModeId: "acceptEdits", modelId: "opus", effort: "high", extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch: "", branch: "" }, trackAsFeature: false },
  });
  assert(preset.launchable && preset.issues.length === 0, "the preset is saved for Work while Work is signed in");
  // Work's sign-in expires.
  rmSync(join(workDir, ".fake-auth"));
  await invoke(bridge, "get_agent_capabilities", { agentId: "claude", accountId: null, refresh: true });
  const checked = (await invoke(bridge, "list_launch_presets")).find((p) => p.name === "Client X");
  check(checked && !checked.launchable, "the backend marks the preset not launchable as it is (its account is signed out)");

  await openLauncher(bridge);
  await bridge.waitFor("the Client X preset", `return !!e2e.all(".task-launcher-preset").find((b) => /Client X/.test(b.innerText));`);
  await bridge.eval(`e2e.click(e2e.all(".task-launcher-preset").find((b) => /Client X/.test(b.innerText))); return true;`);
  await sleep(800);
  await typeInto(bridge, ".task-launcher-task", "Fix the client's invoice export");
  await sleep(800);
  const st = await launcherState(bridge);
  log(`  after the preset: ${JSON.stringify({ agent: st.agent, blocks: st.blocks, launchDisabled: st.launchDisabled })}`);
  await bridge.screenshot(join(evidenceDir, "01-preset-held.png"));
  check(/Claude Code · Work/.test(st.agent), "the preset stays on Work");
  const held = st.blocks.find((b) => b.kind === "account-held");
  check(!!held && held.text.startsWith('The preset "Client X" uses your Work account, which is signed out.'), "the row names the preset and the account (labels, not ids)");
  check(!!held && /Sign in to Work/.test(held.text) && /Use the default profile this time/.test(held.text), "with Sign in to Work and Use the default profile this time");
  check(st.launchDisabled, "Launch waits");

  const before = new Set(records(f).map((r) => r.file));
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".task-launcher-use-default"), "Use the default profile this time"));`);
  await waitLaunchEnabled(bridge);
  const now = await launcherState(bridge);
  check(/default profile/.test(now.agent), "the default profile is used this time, said in the chip");
  await bridge.click(".task-launcher-launch");
  const rec = await waitForRecord(f, "the launch", (r) => !before.has(r.file), 30_000);
  log(`  launched: profileDir=${rec.profileDir ?? "(default)"} model=${rec.model}`);
  check(rec.profileDir !== workDir, "and runs there only because the person said so");
  const again = (await invoke(bridge, "list_launch_presets")).find((p) => p.name === "Client X");
  check(again?.choice.accountId === "work", "the preset itself still names Work");
});
