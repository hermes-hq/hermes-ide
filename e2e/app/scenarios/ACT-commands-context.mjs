#!/usr/bin/env node
// Scenario ACT-commands-context: the Commands list is live data, and the
// context chip offers Compact when the window fills up.
//
// A fake Claude Code (mode "bracketed-paste": a paste and Enter is a prompt,
// and the keys c and k write a model call or a compaction to its transcript,
// as the real CLI does) in a project with its own command files:
//
//   1. the person's .claude/commands (a namespaced one with a frontmatter
//      description) and a skill are listed under "Your commands"; picking
//      one sends it to the agent;
//   2. a model call at 62 % of the window shows "Context 62%"; one at 82 %
//      turns the chip amber, "Compact · 82%", and a click sends /compact;
//   3. Recent lists what the person sent (and nothing they did not);
//   4. ⌘K lists the session's commands ("Run in <session>: Diff") and runs
//      one with the same rules;
//   5. screenshots of the bar and the list in a dark and a light theme.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/ACT-commands-context.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { runScenario } from "../n11-steps.mjs";
import { writeTo } from "../qa-status-steps.mjs";
import {
  chipState,
  filterCommands,
  keyInCommands,
  openCommands,
  promptsOf,
  resizeWindow,
  sleep,
  startActionsApp,
  startAgentSession,
  waitUntilWaiting,
} from "../actions-steps.mjs";

const SCENARIO = "ACT-commands-context";
/** A model whose window Claude Code states as 200k. */
const MODEL_200K = "claude-haiku-4-5-20251001";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  const { fx, bridge } = await startActionsApp("act-commands", evidenceDir, log, onCleanup, apps);
  await resizeWindow(bridge, 1300, 700);

  // The project's own commands, committed like a team's.
  const repo = fx.otherRepo;
  mkdirSync(join(repo, ".claude", "commands", "frontend"), { recursive: true });
  writeFileSync(join(repo, ".claude", "commands", "frontend", "component.md"), "---\ndescription: Scaffold a React component\nargument-hint: [name]\n---\nCreate the component $ARGUMENTS.\n");
  writeFileSync(join(repo, ".claude", "commands", "standup.md"), "# Write my standup from today's commits\n");
  mkdirSync(join(repo, ".claude", "skills", "release"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "release", "SKILL.md"), "---\nname: ship-release\ndescription: Cut and tag a release\n---\nSteps.\n");

  const id = await startAgentSession(bridge, fx, { agentId: "claude", label: "Commands", mode: "bracketed-paste", cwd: repo, log });
  const sent = () => promptsOf(fx);
  const waitSent = async (n, what) => {
    const deadline = Date.now() + 10_000;
    while (sent().length < n && Date.now() < deadline) await sleep(150);
    assert(sent().length >= n && sent()[n - 1] === what, `the agent got ${what} (prompts: ${JSON.stringify(sent())})`);
  };

  log("step 1: your commands");
  let sections = await openCommands(bridge, id);
  await bridge.waitFor("your commands", `return !!document.querySelector('.session-commands [data-command="/frontend:component"]');`, { timeoutMs: 10_000 });
  sections = await bridge.eval(`return [...document.querySelectorAll(".session-commands-section-title")].map((t) => e2e.norm(t.textContent));`);
  assert(JSON.stringify(sections) === JSON.stringify(["Pinned", "Your commands", "Built-in", "Session"]), `sections: ${JSON.stringify(sections)}`);
  const yours = await bridge.eval(`
    return [...document.querySelectorAll(".session-commands-section-yours [role=option]")].map((o) => ({ command: o.dataset.command, text: e2e.norm(o.innerText) }));`);
  log(`  your commands: ${JSON.stringify(yours)}`);
  assert(yours.map((y) => y.command).join(",") === "/frontend:component,/ship-release,/standup", "the namespaced command, the skill and the plain command are listed");
  assert(yours[0].text.includes("Scaffold a React component") && yours[0].text.includes("[name]"), "with the frontmatter description and argument hint");
  assert(yours[2].text.includes("Write my standup from today's commits"), "a file without frontmatter is described by its first line");
  await bridge.screenshot(join(evidenceDir, "01-commands-list-dark.png"));
  await bridge.eval(`document.documentElement.setAttribute("data-theme", "frosted-light"); return true;`);
  await sleep(400);
  await bridge.screenshot(join(evidenceDir, "02-commands-list-light.png"));
  await bridge.eval(`document.documentElement.removeAttribute("data-theme"); return true;`);
  await filterCommands(bridge, "component");
  await sleep(200);
  await keyInCommands(bridge, "Enter");
  await waitSent(1, "/frontend:component");
  await waitUntilWaiting(bridge, id);

  log("step 2: the context chip");
  const call = async (inputTokens) => {
    writeFileSync(join(fx.recordDir, "usage-next.json"), JSON.stringify({ model: MODEL_200K, input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 }));
    // The key the fake reads as "a model call"; Backspace keeps the
    // person's line empty, as after a real turn.
    await writeTo(bridge, id, "c");
    await bridge.waitForTerminal(id, new RegExp(`model call \\(${inputTokens} input tokens\\)`), { timeoutMs: 10_000 });
    await writeTo(bridge, id, "\r");
  };
  await call(124_000);
  await bridge.waitFor("Context 62%", `return document.querySelector('[data-session-action="context"]')?.getAttribute("aria-label") === "Context 62%";`, { timeoutMs: 10_000 });
  const low = await chipState(bridge, id, "context");
  assert(low.name === "Context 62%", `the gauge chip: "${low.name}"`);
  await bridge.screenshot(join(evidenceDir, "03-context-62.png"));
  await call(164_000);
  await bridge.waitFor("Compact · 82%", `return document.querySelector('[data-session-action="compact"]')?.getAttribute("aria-label") === "Compact · 82%";`, { timeoutMs: 10_000 });
  const amber = await bridge.eval(`const c = document.querySelector('[data-session-action="compact"]'); return { cls: c.className, text: e2e.norm(c.innerText) };`);
  assert(amber.cls.includes("h-chip--warning"), `at 82 % it is amber and offers Compact ("${amber.text}")`);
  await bridge.screenshot(join(evidenceDir, "04-compact-82-dark.png"));
  await bridge.eval(`document.documentElement.setAttribute("data-theme", "frosted-light"); return true;`);
  await sleep(400);
  await bridge.screenshot(join(evidenceDir, "05-compact-82-light.png"));
  await bridge.eval(`document.documentElement.removeAttribute("data-theme"); return true;`);
  await waitUntilWaiting(bridge, id);
  const before = sent().length;
  await bridge.eval(`return e2e.click(e2e.must(document.querySelector('[data-session-action="compact"]'), "Compact"));`);
  await waitSent(before + 1, "/compact");
  await waitUntilWaiting(bridge, id);

  log("step 3: Recent lists only what was sent");
  await openCommands(bridge, id);
  const recent = await bridge.eval(`return [...document.querySelectorAll(".session-commands-section-recent [role=option]")].map((o) => o.dataset.command);`);
  assert(JSON.stringify(recent) === JSON.stringify(["/compact", "/frontend:component"]), `Recent, newest first: ${JSON.stringify(recent)}`);
  await keyInCommands(bridge, "Escape");
  await bridge.waitFor("the list closed, the keyboard back on its trigger", `return !document.querySelector(".session-commands") && document.activeElement?.hasAttribute("data-session-commands");`, { timeoutMs: 5_000 });

  log("step 4: the command palette runs a session command");
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "view.command-palette" } }); return true;`);
  await bridge.waitFor("the palette", `return !!document.querySelector(".command-palette-input");`, { timeoutMs: 5_000 });
  await bridge.eval(`
    const input = document.querySelector(".command-palette-input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Run in Commands: Diff");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;`);
  const option = await bridge.waitFor("the session's Diff", `const o = [...document.querySelectorAll(".command-palette-item")].find((r) => r.innerText.includes("Run in Commands: Diff")); return o ? e2e.norm(o.innerText) : null;`, { timeoutMs: 5_000 });
  log(`  palette row: ${option}`);
  await bridge.screenshot(join(evidenceDir, "06-palette.png"));
  const beforePalette = sent().length;
  await bridge.eval(`return e2e.click([...document.querySelectorAll(".command-palette-item")].find((r) => r.innerText.includes("Run in Commands: Diff")));`);
  await waitSent(beforePalette + 1, "/diff");
});
