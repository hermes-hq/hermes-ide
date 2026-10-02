#!/usr/bin/env node
// QA-launcher-models-per-account (ACC-02): the launcher's model list and its
// launch check follow the CHOSEN account. Codex has two accounts, the
// default profile and "Personal". gpt-fake-old is refused on the default
// account only, gpt-fake-luna on Personal only (each by a real refused
// launch). On Codex · Personal the launcher offers gpt-fake-old and shows
// gpt-fake-luna as refused; a model the account refuses is moved off with
// a note when the account is picked.
//
// Negative control: a build before the fix always shows the default
// account's models (old refused, luna offered).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { invoke, openChip, openLauncher, pickInMenu } from "../launcher-steps.mjs";
import { launchWithChoice, setFake } from "../cap-steps.mjs";
import { runAccountsQa, sleep } from "../qa-launcher-steps.mjs";

const modelMenu = (bridge) =>
  bridge.eval(`return Object.fromEntries(e2e.all(".task-launcher-menu [data-model-id]").map((b) => [b.dataset.modelId, { off: b.disabled || b.getAttribute("aria-disabled") === "true", text: e2e.norm(b.innerText) }]));`);

async function refuse(bridge, f, model, accountId) {
  setFake(f, "reject-models", "codex", model);
  const sid = await launchWithChoice(bridge, { agentId: "codex", cwd: f.repo, task: `try ${model}`, modelId: model, accountId });
  await bridge.waitFor(`the refusal of ${model}`, `return !!e2e.first('.launch-rejected[data-session-id="${sid}"]');`, { timeoutMs: 30_000 });
  setFake(f, "reject-models", "codex", "");
  return sid;
}

await runAccountsQa(
  "QA-launcher-models-per-account",
  async ({ bridge, f, log, check, assert, evidenceDir }) => {
    const added = await invoke(bridge, "add_agent_account", { agentId: "codex", label: "Personal" });
    writeFileSync(join(added.account.profileEnv.value, ".fake-auth"), "in\n");
    await refuse(bridge, f, "gpt-fake-old", "default");
    await refuse(bridge, f, "gpt-fake-luna", "personal");
    // Not refresh: a refresh is Check again, which forgets the agent's refusals (ACC-03).
    const personal = await invoke(bridge, "get_agent_capabilities", { agentId: "codex", accountId: "personal", refresh: false });
    const bp = Object.fromEntries(personal.models.map((m) => [m.id, m.available]));
    log(`  backend, Personal: ${JSON.stringify(bp)}`);
    assert(bp["gpt-fake-old"] === true && bp["gpt-fake-luna"] === false, "the backend knows each account's refusals");

    await openLauncher(bridge);
    await pickInMenu(bridge, "agent", '[data-agent-id="codex"]');
    await sleep(800);
    await pickInMenu(bridge, "model", '[data-model-id="gpt-fake-luna"]');
    await sleep(400);
    await pickInMenu(bridge, "agent", '[data-account-id="personal"]');
    await bridge.waitFor("Codex · Personal", `return /Codex · Personal/.test(e2e.norm(e2e.first('[data-chip="agent"]').innerText));`);
    await sleep(1500);
    const st = await bridge.eval(`return { model: e2e.norm(e2e.first('[data-chip="model"]').innerText), note: e2e.norm(e2e.first('.task-launcher-fallback[data-source="account"]')?.innerText ?? "") };`);
    log(`  after picking Personal with gpt-fake-luna chosen: ${JSON.stringify(st)}`);
    check(!/gpt-fake-luna/.test(st.model), "the model Personal refuses is not kept");
    check(/Not available with Personal/.test(st.note), "and the launcher says why");
    await openChip(bridge, "model");
    const menu = await modelMenu(bridge);
    log(`  model menu for Codex · Personal: ${JSON.stringify(menu)}`);
    await bridge.screenshot(join(evidenceDir, "01-personal-models.png"));
    check(menu["gpt-fake-old"] && !menu["gpt-fake-old"].off, "gpt-fake-old is offered on Personal (only the default account refused it)");
    check(menu["gpt-fake-luna"] && menu["gpt-fake-luna"].off, "gpt-fake-luna is shown as refused on Personal");
  },
  { bins: ["codex"] },
);
