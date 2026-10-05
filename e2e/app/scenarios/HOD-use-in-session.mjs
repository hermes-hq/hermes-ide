#!/usr/bin/env node
// HOD-use-in-session: a library prompt is used in a Claude Code session and
// in a Codex session, both in Terminal mode, the same way: the rendered text
// arrives as one bracketed paste with no Enter, and the person sends it.
// Fake `claude` and `codex` (tools/fake-agents/fake-cli.mjs, in the
// `bracketed-paste` mode the real TUIs share) record what they receive.
//
//   - Required arguments block "Use in session" until they are filled; the
//     preview shows the text with the values in place.
//   - Use in session -> the Library closes, the Claude Code terminal shows
//     the paste ("[pasted N chars]"), and the agent has received no prompt:
//     nothing was sent. Enter in the terminal sends it: the agent's prompt
//     is exactly the rendered text.
//   - The same entry with other values into the Codex session: the same.
//   - Each use is counted on the device: the entry is on the Continue shelf
//     afterwards.
//
// Negative control: HERMES_E2E_HOD_NEGATIVE=no-bracketed starts the fakes
// without bracketed paste; Hermes then refuses to paste multi-line text into
// a program that would run each line, puts it on the clipboard, and the
// paste checks must fail.

import { join } from "node:path";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { chooseTarget, fillArg, invoke, libraryState, openEntry, openLibrary, search, waitPreview } from "../library-steps.mjs";

const NAME = "HOD-use-in-session";
const NEGATIVE = process.env.HERMES_E2E_HOD_NEGATIVE === "no-bracketed";
const ENTRY = "review-ai-generated-code";

const launchAgent = (bridge, agentId, cwd) =>
  bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId, cwd, label: `${agentId} session` })});`, { timeoutMs: 60_000 });

await runLauncherQa(
  NAME,
  async ({ bridge, fx, log, check, assert, evidenceDir }) => {
    const claudeId = await launchAgent(bridge, "claude", fx.repo);
    const codexId = await launchAgent(bridge, "codex", fx.repo);
    assert(!!claudeId && !!codexId, "a Claude Code and a Codex session started (Terminal mode)");
    for (const [id, name] of [
      [claudeId, "claude"],
      [codexId, "codex"],
    ]) {
      await bridge.waitFor(`the fake ${name} to be ready`, `return (window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || []).some((l) => l.includes("fake-cli: ready"));`, { timeoutMs: 45_000 });
    }
    const recordOf = (agent) => fx.records().find((r) => r.env?.HERMES_SESSION_ID === (agent === "claude" ? claudeId : codexId));
    log(`  fake launches: ${fx.records().map((r) => `${r.env?.HERMES_AGENT}@${r.env?.HERMES_SESSION_ID}`).join(", ")}`);

    for (const [sessionId, agent, diff] of [
      [claudeId, "claude", "diff --git a/src/auth.ts b/src/auth.ts\n+export const token = process.env.TOKEN;"],
      [codexId, "codex", "diff --git a/lib/cart.py b/lib/cart.py\n+total = sum(i.price for i in items)"],
    ]) {
      log(`— ${agent}`);
      await openLibrary(bridge);
      await search(bridge, "review ai generated code");
      await openEntry(bridge, ENTRY);
      const before = await libraryState(bridge);
      log(`  before the arguments: use disabled=${before.useDisabled}, blocked="${before.blocked}"`);
      check(before.useDisabled === true && before.blocked.length > 0, "a required argument blocks Use in session");
      await fillArg(bridge, "diff", diff);
      const preview = await waitPreview(bridge, diff.split("\n")[1]);
      check(preview.includes(diff), "the preview shows the text with the value in place");
      await chooseTarget(bridge, sessionId);
      await bridge.waitFor("Use in session enabled", `return e2e.first(".lib-use")?.disabled === false;`);
      await bridge.screenshot(join(evidenceDir, `01-${agent}-ready.png`));
      const promptsBefore = (recordOf(agent)?.prompts ?? []).length;
      await bridge.click(".lib-use");
      await bridge.waitFor("the Library to close", `return !e2e.first('[data-testid="library-view"]');`, { timeoutMs: 10_000 }).catch(() => null);
      const pasted = await bridge
        .waitFor(`the paste in the ${agent} terminal`, `const t = (window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || []).join("\\n"); const m = t.match(/\\[pasted (\\d+) chars\\]/g); return m ? m[m.length - 1] : false;`, { timeoutMs: 15_000 })
        .catch(() => null);
      log(`  terminal shows: ${pasted}`);
      await bridge.screenshot(join(evidenceDir, `02-${agent}-pasted.png`));
      const rendered = preview.trimEnd();
      check(!!pasted, `the ${agent} terminal got the text as one paste`);
      check(!!pasted && Number(pasted.match(/\d+/)[0]) === rendered.replace(/\r\n/g, "\n").length, `of exactly the rendered text (${rendered.length} chars)`);
      await sleep(1200);
      check((recordOf(agent)?.prompts ?? []).length === promptsBefore, "and nothing was sent: no Enter after it");
      await bridge.typeInTerminal(sessionId, "\r");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (recordOf(agent)?.prompts ?? []).length <= promptsBefore) await sleep(200);
      const rec = recordOf(agent);
      const sent = rec?.prompts?.[promptsBefore] ?? "";
      log(`  after Enter, ${agent} received ${sent.length} chars: ${JSON.stringify(sent.slice(0, 120))}…`);
      check(sent.trim() === rendered.trim(), `Enter sends it: ${agent}'s prompt is exactly the rendered text`);
      // The fake records the prompt before it prints its answer: wait for the line.
      const took = await bridge.waitForTerminal(sessionId, /prompt received/, { timeoutMs: 10_000 }).then(
        () => true,
        () => false,
      );
      check(took, `${agent} took it as a prompt`);
    }

    // Each use counted on the device: the entry is on the Continue shelf.
    const states = await invoke(bridge, "library_item_states");
    const state = states.find((s) => s.itemId === ENTRY);
    log(`  item state: ${JSON.stringify(state)}`);
    check(state?.useCount === 2, "both uses were counted on the device");
    await openLibrary(bridge);
    await bridge.eval(`const n = e2e.first('.lib-nav-item[data-nav="home"]'); if (n) e2e.click(n); return true;`);
    await bridge.waitFor("the Continue shelf", `return !!e2e.first('.lib-shelf[data-shelf="continue"] .lib-card[data-entry="${ENTRY}"]');`, { timeoutMs: 15_000 }).catch(() => null);
    const home = await libraryState(bridge);
    await bridge.screenshot(join(evidenceDir, "03-continue-shelf.png"));
    check(home.shelves.some((s) => s.id === "continue" && s.cards.some((c) => c.id === ENTRY)), "the entry is on the Continue shelf");
  },
  {
    tag: "hod-use",
    before: (fx) => {
      if (!NEGATIVE) fx.setFake("mode", "bracketed-paste");
    },
  },
);
