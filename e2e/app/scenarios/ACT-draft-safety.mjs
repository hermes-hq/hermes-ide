#!/usr/bin/env node
// Scenario ACT-draft-safety: a chip of the session action bar runs its
// command only when the agent waits and the person's line is empty, and
// never touches a draft.
//
// A fake Claude Code (tools/fake-agents/fake-cli.mjs, mode "prompts
// bracketed-paste": typed lines are prompts, and it turns bracketed paste
// on like the real TUI) records every prompt it is sent. On the real app:
//
//   1. the person types a draft ("fix the login bug") and clicks Review:
//      nothing is typed, the draft is intact (Enter sends exactly it), and
//      the bar says "Finish or clear your message first";
//   2. with an empty line, Review sends /code-review with Enter: the agent
//      takes it as a prompt;
//   3. while the agent works on a turn, the chips are disabled and say when
//      they will work; after the turn they work again;
//   4. New Chat (destructive) is not a chip: in the Commands list it asks
//      first, and sends /clear only once confirmed.
//
// Before the session action bar, the quick action erased the draft with
// Backspaces and typed its command over it: run against that build, step 1
// fails ("the draft was replaced").
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/ACT-draft-safety.mjs

import { join } from "node:path";
import { platform } from "node:os";
import { runScenario } from "../n11-steps.mjs";
import { writeTo } from "../qa-status-steps.mjs";
import {
  chipState,
  clickChip,
  filterCommands,
  keyInCommands,
  noticeOf,
  openCommands,
  promptsOf,
  sleep,
  startActionsApp,
  startAgentSession,
  waitUntilWaiting,
} from "../actions-steps.mjs";

const SCENARIO = "ACT-draft-safety";
const DRAFT = "fix the login bug";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  const { fx, bridge } = await startActionsApp("act-draft", evidenceDir, log, onCleanup, apps);
  const id = await startAgentSession(bridge, fx, { agentId: "claude", label: "Draft safety", log });
  const newBar = await bridge.eval(`return !!document.querySelector("[data-session-action]");`);
  log(`  this build has ${newBar ? "the session action bar" : "the old quick actions (negative control)"}`);

  log("step 1: a draft on the line, then a click on Review");
  await bridge.typeInTerminal(id, DRAFT);
  await bridge.waitForTerminal(id, new RegExp(DRAFT), { timeoutMs: 10_000 });
  await sleep(400);
  await clickChip(bridge, id, "review", "/review");
  await sleep(1500);
  assert(promptsOf(fx).length === 0, `nothing was sent to the agent (prompts: ${JSON.stringify(promptsOf(fx))})`);
  await bridge.screenshot(join(evidenceDir, "01-draft-notice.png"));
  // The person sends their draft: exactly what they typed must arrive.
  await bridge.typeInTerminal(id, "\n");
  const deadline = Date.now() + 10_000;
  while (promptsOf(fx).length === 0 && Date.now() < deadline) await sleep(150);
  const sent = promptsOf(fx);
  assert(sent.length === 1 && sent[0] === DRAFT, `the draft is intact: Enter sent ${JSON.stringify(sent)} (want ${JSON.stringify([DRAFT])}); the draft was not replaced`);
  await waitUntilWaiting(bridge, id);

  log("step 2: an empty line: Review sends its command with Enter");
  await clickChip(bridge, id, "review", "/review");
  const deadline2 = Date.now() + 10_000;
  while (promptsOf(fx).length < 2 && Date.now() < deadline2) await sleep(150);
  assert(promptsOf(fx)[1] === "/code-review", `the agent got /code-review as a prompt (prompts: ${JSON.stringify(promptsOf(fx))})`);
  await waitUntilWaiting(bridge, id);

  log("step 1b: the draft notice (clicked with text on the line again)");
  await bridge.typeInTerminal(id, "half a thought");
  await sleep(400);
  await clickChip(bridge, id, "plan", "/compact");
  const notice = await bridge.waitFor("the bar's notice", `const n = document.querySelector("[data-session-notice]"); return n ? e2e.norm(n.innerText) : null;`, { timeoutMs: 5_000 });
  assert(notice === "Finish or clear your message first", `the bar says why nothing was sent: "${notice}"`);
  assert(promptsOf(fx).length === 2, "still nothing typed over the draft");
  await bridge.screenshot(join(evidenceDir, "02-draft-notice.png"));
  // The person deletes it again (Backspace).
  await writeTo(bridge, id, "\x7f".repeat("half a thought".length));
  await sleep(300);

  log("step 3: while the agent works, the chips wait");
  await bridge.typeInTerminal(id, "work 5000\n");
  await bridge.waitFor("the agent to work", `return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(id)}).kind === "working";`, { timeoutMs: 10_000 });
  const busy = await chipState(bridge, id, "review");
  assert(busy?.disabled === true, `Review is disabled while the agent works (${JSON.stringify(busy)})`);
  assert(busy.title === "Available when Claude Code is waiting", `its tooltip says when it works: "${busy.title}"`);
  await bridge.screenshot(join(evidenceDir, "03-busy.png"));
  await waitUntilWaiting(bridge, id, 30_000);
  const idle = await chipState(bridge, id, "review");
  assert(idle?.disabled === false, "Review works again once the agent waits");
  log(`  notice now: ${await noticeOf(bridge, id)}`);

  log("step 4: New Chat asks first");
  const chipNames = await bridge.eval(`return [...document.querySelectorAll("[data-session-action]")].map((c) => c.getAttribute("aria-label"));`);
  assert(!chipNames.includes("New Chat"), `New Chat is never a chip (chips: ${JSON.stringify(chipNames)})`);
  const sections = await openCommands(bridge, id);
  assert(sections.at(-1) === "Session", `the destructive commands are last, under Session (${JSON.stringify(sections)})`);
  await filterCommands(bridge, "new chat");
  await sleep(200);
  log(`  the list now: ${JSON.stringify(await bridge.eval(`return { focus: document.activeElement?.getAttribute("role"), value: document.querySelector(".session-commands [role=combobox]")?.value, options: [...document.querySelectorAll(".session-commands [role=option]")].map((o) => o.dataset.command), active: document.querySelector(".session-commands [role=combobox]")?.getAttribute("aria-activedescendant") };`))}`);
  await keyInCommands(bridge, "Enter");
  const confirm = await bridge.waitFor("the confirm", `const c = document.querySelector(".session-commands-confirm"); return c ? e2e.norm(c.innerText) : null;`, { timeoutMs: 5_000 });
  assert(/Start a new chat\?/.test(confirm) && /reopen it with Resume/.test(confirm), `it asks first: "${confirm}"`);
  await bridge.screenshot(join(evidenceDir, "04-destructive-confirm.png"));
  const beforeConfirm = promptsOf(fx).length;
  assert(!promptsOf(fx).includes("/clear"), "nothing sent before the confirm");
  await bridge.eval(`return e2e.click(e2e.must(document.querySelector("[data-confirm-run]"), "the confirm button"));`);
  const deadline4 = Date.now() + 10_000;
  while (promptsOf(fx).length === beforeConfirm && Date.now() < deadline4) await sleep(150);
  assert(promptsOf(fx).at(-1) === "/clear", `confirmed: the agent got /clear (prompts: ${JSON.stringify(promptsOf(fx))})`);
});
