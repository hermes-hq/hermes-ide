#!/usr/bin/env node
// QA-host-mac-ctrl-c-split — macOS only. Ctrl+C on a Mac reaches the app as
// the Edit menu's "Send Interrupt" accelerator (the web view swallows the key
// itself), and the app sends it to a terminal. With two panes split, it went
// to whichever terminal was attached last instead of the one being typed in.
//
// EXPECT: two plain shells side by side, each running `sleep 600`; a click on
// the pane that was attached FIRST, then Edit ▸ Send Interrupt (the Ctrl+C
// accelerator, chosen through the app's real menu): that pane's command stops
// and its prompt is back, and the other pane's command keeps running, with no
// ^C in it.
//
// Negative control: a build without the fix ends in RESULT: FAIL (the
// interrupt stops the other pane's command).

import { platform } from "node:os";
import { join } from "node:path";
import { ScenarioSkip, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, pickPlainShellAndCreate, startApp, write } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-mac-ctrl-c-split";

const foreground = (bridge, id) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("is_shell_foreground", { sessionId: ${JSON.stringify(id)} });`);
const tail = async (bridge, id, n = 4) => ((await bridge.readTerminal(id)) ?? []).slice(-n);

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (platform() !== "darwin") throw new ScenarioSkip("the Send Interrupt menu accelerator for Ctrl+C exists on macOS only");
  const { bridge } = await startApp("qa-ctrl-c", evidenceDir, log, onCleanup, apps);

  log("step 1: two plain shells, split side by side");
  const first = await newTerminal(bridge, "First pane");
  await bridge.chooseMenuItem("view.split-horizontal");
  const before = await bridge.terminalIds();
  await pickPlainShellAndCreate(bridge, "split", log);
  const second = await bridge.waitFor(
    "the second pane's shell",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     if (ids.length !== 1) return null;
     const lines = window.__HERMES_E2E__.readTerminal(ids[0]) || [];
     return lines.some((l) => l.trim().length > 0) ? ids[0] : null;`,
    { timeoutMs: 30_000 },
  );
  const panes = await bridge.waitFor(
    "two panes, one shell each",
    `const panes = e2e.all(".split-pane").map((p) => p.querySelector("div[data-session-id]")?.getAttribute("data-session-id") ?? null);
     return panes.length === 2 && panes.includes(${JSON.stringify(first)}) && panes.includes(${JSON.stringify(second)}) ? panes : null;`,
    { timeoutMs: 15_000 },
  );
  log(`  panes: ${JSON.stringify(panes)}; attached first: ${first}, last: ${second}`);
  await sleep(800);

  log("step 2: a long command in each pane");
  await bridge.typeInTerminal(second, "sleep 600\n");
  await bridge.waitFor("the second pane's command to run", `return !(await window.__TAURI_INTERNALS__.invoke("is_shell_foreground", { sessionId: ${JSON.stringify(second)} }));`, { timeoutMs: 15_000 });
  await bridge.typeInTerminal(first, "sleep 600\n");
  await bridge.waitFor("the first pane's command to run", `return !(await window.__TAURI_INTERNALS__.invoke("is_shell_foreground", { sessionId: ${JSON.stringify(first)} }));`, { timeoutMs: 15_000 });
  const secondBefore = await tail(bridge, second);
  log(`  second pane before: ${JSON.stringify(secondBefore)}`);

  log("step 3: click the pane attached first");
  await bridge.clickWhenReady(`
    const host = e2e.must(document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(first)}) + '"]'), "the first pane's terminal");
    return e2e.click(e2e.must(host.querySelector(".xterm-screen"), "the first pane's screen"));
  `);
  const focus = await bridge.waitFor(
    "the first pane to hold the keyboard",
    `const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(first)}) + '"]');
     const a = document.activeElement;
     return host && a && host.contains(a) ? { active: a.className || a.tagName } : null;`,
    { timeoutMs: 5_000 },
  );
  log(`  keyboard focus: ${JSON.stringify(focus)}`);

  log("step 4: Ctrl+C (Edit ▸ Send Interrupt, the menu item its accelerator fires)");
  await bridge.chooseMenuItem("edit.send-interrupt");
  const stopped = await bridge
    .waitFor("the first pane's prompt to come back", `return await window.__TAURI_INTERNALS__.invoke("is_shell_foreground", { sessionId: ${JSON.stringify(first)} });`, { timeoutMs: 10_000 })
    .catch(() => false);
  await sleep(1500);
  await bridge.screenshot(join(evidenceDir, "01-after-ctrl-c.png"));
  log(`  first pane: ${JSON.stringify(await tail(bridge, first))}`);
  const secondAfter = await tail(bridge, second);
  log(`  second pane: ${JSON.stringify(secondAfter)}`);
  const secondRunning = !(await foreground(bridge, second));

  assert(stopped, "the focused (first) pane's command stopped: its shell is in front again");
  await bridge.typeInTerminal(first, "echo first-pane-prompt-back\n");
  await bridge.waitForTerminal(first, /^first-pane-prompt-back$/, { timeoutMs: 10_000 });
  log("  ok — the first pane takes the next command");
  assert(secondRunning, "the other pane's command is still running");
  assert(!secondAfter.some((l) => l.includes("^C")) && JSON.stringify(secondAfter) === JSON.stringify(secondBefore), "the other pane got nothing (no ^C, no new output)");

  // Leave nothing running for the quit.
  await write(bridge, second, "\x03");
});
