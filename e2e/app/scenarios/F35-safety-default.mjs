#!/usr/bin/env node
// Scenario: F35 — one safety default across vendors.
//
// Proves, on the REAL app, with a fake agent started as Claude and as Codex
// (the launch line is the one Hermes builds for them; the program is ours,
// see ../agent-setup-steps.mjs):
//
//   1. A new Claude session starts in the mapped default: the wizard
//      preselects "Accept edits" (marked Hermes default), and the agent runs
//      with --permission-mode acceptEdits. No "Looser than default" chip.
//   2. A new Codex session starts in its mapping: --sandbox workspace-write
//      --ask-for-approval on-request. No chip.
//   3. A Claude session launched with a looser flag
//      (--dangerously-skip-permissions, typed as a custom flag) shows the
//      "Looser than default" chip, naming the flag. The chip is read from the
//      running agent's command line, not from the wizard.
//   4. A program that only mentions the agent on its command line
//      (`node notes.mjs claude --dangerously-skip-permissions`) is not taken
//      for the agent: no chip.
//
// Negative control: HERMES_E2E_NEGATIVE=1 launches the third session without
// the looser flag; the run must end in RESULT: FAIL (no chip appears).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F35-safety-default.mjs

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { launcher, launchWithCatalogFlag, onWindows, quitFakeAgent, readChips, startAgentSession, writeFakeAgent } from "../agent-setup-steps.mjs";

const NEGATIVE = process.env.HERMES_E2E_NEGATIVE === "1";
const LOOSER_FLAG = "--dangerously-skip-permissions";

await runScenario("F35-safety-default", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`platform: ${process.platform}${NEGATIVE ? "   NEGATIVE CONTROL: the looser flag is left out" : ""}`);
  const fake = writeFakeAgent("f35");
  onCleanup(fake.cleanup);
  const root = mkdtempSync(join(tmpdir(), "hermes-e2e-f35-"));
  onCleanup(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const project = join(root, "f35-project");
  mkdirSync(project, { recursive: true });
  const homeDir = onWindows ? undefined : join(root, "home");

  log("step 1: launch with the agentCatalog flag on");
  const app = await launchWithCatalogFlag({ launch: launcher({ evidenceDir, log, homeDir }), log, apps });
  const { bridge } = app;

  /** The chips once the agent's command line has been read (the chip polls it). */
  const settledChips = (agent) => bridge.waitFor(`the ${agent} safety state`, `
    const c = e2e.first(".agent-setup-chips");
    return c && c.getAttribute("data-agent-id") === ${JSON.stringify(agent)} && c.getAttribute("data-safety") !== "unknown"
      ? c.getAttribute("data-safety") : null;
  `, { timeoutMs: 20_000 });

  /** No looser chip, for several polls in a row. */
  async function assertStaysDefault(agent) {
    for (let i = 0; i < 4; i++) {
      const c = await readChips(bridge);
      assert(c?.safety === "default" && !c.looser, `${agent}: no "Looser than default" chip (poll ${i + 1}: ${JSON.stringify(c)})`);
      await sleep(1_000);
    }
  }

  log("step 2: a new Claude session starts in the mapped default");
  const claude = await startAgentSession(bridge, log, { agent: "claude", prefix: fake.prefixFor("claude"), folders: [project], label: "F35 claude" });
  assert(claude.wizard.pillIsHermesDefault && claude.wizard.flags === "--permission-mode acceptEdits", "the wizard preselected Accept edits, marked Hermes default");
  assert(/^FAKE-AGENT claude --permission-mode acceptEdits\b/.test(claude.bannerLine), "Claude runs with --permission-mode acceptEdits");
  await settledChips("claude");
  await assertStaysDefault("Claude");
  await bridge.screenshot(join(evidenceDir, "01-claude-default.png"));
  await quitFakeAgent(bridge, claude.sessionId);

  log("step 3: a new Codex session starts in the mapped default");
  const codex = await startAgentSession(bridge, log, { agent: "codex", prefix: fake.prefixFor("codex"), folders: [project], label: "F35 codex" });
  assert(codex.wizard.pillIsHermesDefault && codex.wizard.flags === "--sandbox workspace-write --ask-for-approval on-request", "the wizard preselected Codex's sandboxed mode, marked Hermes default");
  assert(/^FAKE-AGENT codex --sandbox workspace-write --ask-for-approval on-request$/.test(codex.bannerLine), "Codex runs with --sandbox workspace-write --ask-for-approval on-request");
  await settledChips("codex");
  await assertStaysDefault("Codex");
  await bridge.screenshot(join(evidenceDir, "02-codex-default.png"));
  await quitFakeAgent(bridge, codex.sessionId);

  log("step 4: a Claude session launched with a looser flag");
  const looser = await startAgentSession(bridge, log, {
    agent: "claude",
    prefix: fake.prefixFor("claude"),
    suffix: NEGATIVE ? "" : LOOSER_FLAG,
    folders: [project],
    label: "F35 looser",
  });
  if (!NEGATIVE) assert(looser.bannerLine.includes(LOOSER_FLAG), `the agent really runs with ${LOOSER_FLAG}`);
  const chip = await bridge.waitFor('the "Looser than default" chip', `
    const c = e2e.first(".agent-setup-chips .agent-safety-chip");
    return c ? { text: e2e.norm(c.innerText), title: c.getAttribute("title") } : null;
  `, { timeoutMs: 15_000 });
  log(`  chip: ${JSON.stringify(chip)}`);
  assert(chip.text === "Looser than default", "the chip says Looser than default");
  assert(chip.title.includes(LOOSER_FLAG), "the chip names the flag");
  await bridge.settle();
  await bridge.screenshot(join(evidenceDir, "03-claude-looser.png"));

  log("step 5: the chip goes away once the looser agent exits");
  await quitFakeAgent(bridge, looser.sessionId);
  await bridge.waitFor("the chip to go away", `return !e2e.first(".agent-setup-chips .agent-safety-chip");`, { timeoutMs: 15_000 });
  log("  ok — no chip once no agent runs looser");

  log("step 6: a program that only mentions claude on its command line is not an agent");
  await bridge.typeInTerminal(looser.sessionId, `${fake.prefixFor("notes")} claude ${LOOSER_FLAG}\n`);
  await bridge.waitForTerminal(looser.sessionId, new RegExp(`^FAKE-AGENT claude ${LOOSER_FLAG}\\s*$`), { timeoutMs: 30_000 });
  for (let i = 0; i < 4; i++) {
    const c = await readChips(bridge);
    assert(c && !c.looser && c.safety === "unknown", `no agent is read from "notes.mjs claude ${LOOSER_FLAG}" (poll ${i + 1}: ${JSON.stringify(c)})`);
    await sleep(1_000);
  }
  await quitFakeAgent(bridge, looser.sessionId);
});
