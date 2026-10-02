#!/usr/bin/env node
// QA-launcher-typed-model (ACC-11, ACC-13d): Claude Code takes any model id
// (a pinned version, a long-context variant), and its capabilities say so:
// the model menu has "or type a model id, e.g. claude-sonnet-4-5", and the
// typed id is what launches. The preset name offered for an added account
// names it ("Claude Code · Work · opus"). Antigravity, which has one Google
// sign-in per user, reads "Antigravity CLI · Google account", not "default
// profile".
//
// Negative control: a build before the fix offers only the aliases, names
// presets without the account and calls agy's sign-in "default profile".

import { join } from "node:path";
import { invoke, launcherState, openChip, openLauncher, pickInMenu, pressKey, typeInto, waitLaunchEnabled } from "../launcher-steps.mjs";
import { records, waitForRecord } from "../cap-steps.mjs";
import { runAccountsQa, sleep } from "../qa-launcher-steps.mjs";

const MODEL = "claude-sonnet-4-5-20250929";

await runAccountsQa(
  "QA-launcher-typed-model",
  async ({ bridge, f, log, check, evidenceDir }) => {
    const caps = await invoke(bridge, "get_agent_capabilities", { agentId: "claude", accountId: null });
    check(caps.acceptsTypedModel === true, `Claude takes a typed model (source ${caps.modelSource})`);
    await invoke(bridge, "add_agent_account", { agentId: "claude", label: "Work" });
    await openLauncher(bridge);
    await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
    await sleep(500);
    await openChip(bridge, "model");
    const field = await bridge.eval(`const el = e2e.first(".task-launcher-menu .task-launcher-model-text"); return el ? el.placeholder : null;`);
    log(`  typed-model field: ${JSON.stringify(field)}`);
    check(field === "or type a model id, e.g. claude-sonnet-4-5", "the model menu lets the person type a Claude model id");
    if (field) {
      await typeInto(bridge, ".task-launcher-menu .task-launcher-model-text", MODEL);
      await pressKey(bridge, ".task-launcher-menu .task-launcher-model-text", "Enter");
      await sleep(400);
      check((await launcherState(bridge)).model === `model: ${MODEL}`, "Enter confirms it; the chip shows it");
      await typeInto(bridge, ".task-launcher-task", "Pin the model version");
      await waitLaunchEnabled(bridge);
      const before = new Set(records(f).map((r) => r.file));
      await bridge.click(".task-launcher-launch");
      const rec = await waitForRecord(f, "the launch", (r) => !before.has(r.file), 30_000);
      log(`  launched with model ${rec.model}`);
      check(rec.model === MODEL, "the typed model is what the agent starts with");
    }

    await openLauncher(bridge);
    await pickInMenu(bridge, "agent", '[data-account-id="work"]');
    await pickInMenu(bridge, "model", '[data-model-id="opus"]');
    await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".task-launcher-save-preset"), "Save as preset…"));`);
    await bridge.waitFor("the preset name", `return !!e2e.first(".task-launcher-preset-name");`);
    const name = await bridge.eval(`return e2e.first(".task-launcher-preset-name").value;`);
    log(`  offered preset name: ${JSON.stringify(name)}`);
    check(name === "Claude Code · Work · opus", "the offered preset name says which account");
    await pressKey(bridge, ".task-launcher-preset-name", "Escape");

    await pickInMenu(bridge, "agent", '[data-agent-id="antigravity"]');
    await sleep(1500);
    const agy = (await launcherState(bridge)).agent;
    log(`  Antigravity chip: ${agy}`);
    check(/Antigravity.* · Google account/.test(agy), "Antigravity's one sign-in reads as its Google account");
    await bridge.screenshot(join(evidenceDir, "01-agy.png"));
  },
  { bins: ["claude", "agy"] },
);
