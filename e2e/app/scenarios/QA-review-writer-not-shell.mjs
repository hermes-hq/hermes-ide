#!/usr/bin/env node
// QA-review-writer-not-shell (PLN-07): the Track panel's writer — the
// session "Send my edits" (r) types into — is the agent, never a plain
// shell. A shell opened in the repository BEFORE the agent's task used to
// win by age, and "Send my edits" typed the review line into zsh, which ran
// it as a command; the agent never got it.
//
//   1. a plain shell in the repository, then a "Current checkout" task with
//      fake claude in the same folder (a feature is created there)
//   2. the Track panel's badge names the agent ("Agent: Claude Code")
//   3. the questions file waits at its gate; the person edits it and presses
//      "Send my edits": the agent gets the line, the shell does not
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registryPath } from "../cap-steps.mjs";
import { launchApp } from "../harness.mjs";
import { HI, L, fakeAgents, launchTask, mkRepo, mkWork, onWindows, runScenario, sessionCwd, sleep } from "../review-steps.mjs";
import { rmSync } from "node:fs";

await runScenario("QA-review-writer-not-shell", async ({ evidenceDir, log, check }) => {
  const work = mkWork("writer");
  const { repo } = mkRepo(join(work, "demo-repo"), { "math.js": "export const sub = (a, b) => a - b;\n" });
  const fake = fakeAgents(work);
  // Windows terminals rebuild PATH from the registry (see N12): the fake
  // agents must be on it there too (CI runners only).
  const undoPath = registryPath(fake, log);
  const env = { ...fake.env, ...(process.env.HERMES_E2E_FREE_SPACE_BYTES ? { HERMES_E2E_FREE_SPACE_BYTES: process.env.HERMES_E2E_FREE_SPACE_BYTES } : {}) };
  const app = await launchApp(
    onWindows
      ? { runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, flagDefaults: null, env }
      : { runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir: join(work, "home"), flagDefaults: null, env },
  ).catch((e) => {
    undoPath?.();
    throw e;
  });
  try {
    const { bridge } = app;
    await L.completeTaskWelcome(bridge, repo);
    const shell = await bridge.eval(`return await window.__HERMES_E2E__.newTerminal({ label: "my shell", cwd: ${JSON.stringify(repo)} });`);
    log(`a plain shell first: ${shell}`);
    await sleep(2500);
    const agent = await launchTask(bridge, repo, "Add an add function", { currentCheckout: true });
    const wt = await sessionCwd(bridge, agent);
    log(`agent ${agent} in ${wt}`);
    await bridge.waitForTerminal(agent, /fake-cli: ready/, { timeoutMs: 20_000 });
    if (!existsSync(join(wt, ".hermes", "features"))) {
      execFileSync(HI, ["feature", "new", "add-an-add-function", "--track", "Light", "--no-branch"], { cwd: wt });
    }
    await bridge.clickByName("Track");
    await bridge.waitFor("the Track panel", `return !!e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase");`, { timeoutMs: 15_000 });
    const slug = readdirSync(join(wt, ".hermes", "features"))[0];
    const q = join(wt, ".hermes", "features", slug, "questions.md");
    writeFileSync(q, "# Questions\n\n- [ ] Which file?\n");
    execFileSync(HI, ["phase", "done"], { cwd: wt, env: { ...process.env, HERMES_AGENT: "claude" } });
    await bridge.waitFor("the gate to wait", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-gate") === "waiting";`);
    const badge = await bridge.eval(`return { text: e2e.norm(e2e.first(".track-role")?.innerText ?? ""), writer: e2e.first("[data-testid=track-panel]")?.getAttribute("data-writer") };`);
    log(`badge: ${JSON.stringify(badge)}`);
    check(badge.writer === agent, "the writer is the agent's session, not the older shell");
    check(/^Agent: Claude Code$|^Viewing Claude Code's track$/.test(badge.text), `the badge names the agent (${badge.text})`);

    writeFileSync(q, "# Questions\n\n- [x] Which file? — math.js\n");
    await sleep(1500);
    await bridge.click(".track-send-edits");
    await sleep(3000);
    const shellText = ((await bridge.readTerminal(shell)) ?? []).join("\n");
    const prompts = fake.records()[0]?.prompts ?? [];
    log(`shell tail:\n${shellText.split("\n").slice(-6).join("\n")}`);
    log(`agent prompts: ${JSON.stringify(prompts)}`);
    await bridge.screenshot(join(evidenceDir, "after-send.png"));
    check(!/hermes review:/.test(shellText), "the review line is not typed into the plain shell");
    check(prompts.some((p) => /hermes review/.test(p)), "the agent received the review line");
  } finally {
    if (app.isRunning()) await app.stop();
    undoPath?.();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
