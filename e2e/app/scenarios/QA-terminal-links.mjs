#!/usr/bin/env node
// QA-terminal-links — clicking a link in the terminal opened nothing. Claude
// Code prints its links as OSC 8 hyperlinks, which xterm sent to confirm() +
// window.open(): neither does anything in the app's web view. EXPECT: a click
// on an OSC 8 hyperlink and a click on a plain URL each ask the system to
// open that URL (recorded by the test build instead of starting a browser).
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-terminal-links";
const OSC8_URL = "https://example.com/osc8-link";
const PLAIN_URL = "https://example.com/plain-link";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { bridge } = await startApp("qa-links", evidenceDir, log, onCleanup, apps);
  const sid = await newTerminal(bridge, "links");

  // Record the links a click opens instead of starting a browser. confirm()
  // answers no, so xterm's own fallback (the bug) opens nothing either.
  await bridge.eval(`
    window.__openedUrls = window.__HERMES_E2E__.captureTerminalLinks();
    window.confirm = () => false;
    return true;`);

  const screen =
    "\x1b[2J\x1b[H" +
    `\x1b]8;;${OSC8_URL}\x1b\\open-the-osc8-link\x1b]8;;\x1b\\\r\n` +
    `${PLAIN_URL}\r\n`;
  assert(await bridge.eval(`return await window.__HERMES_E2E__.writeToView(${JSON.stringify(sid)}, ${JSON.stringify(screen)});`),
    "the links are on the terminal's screen");
  await sleep(500);
  await bridge.screenshot(join(evidenceDir, "01-links.png"));

  /** Hover a cell, then press and release there, as a person clicking. */
  const clickCell = (col, row) => bridge.eval(`
    const p = window.__HERMES_E2E__.cellPoint(${JSON.stringify(sid)}, ${col}, ${row});
    if (!p) return false;
    const el = document.elementFromPoint(p.x, p.y);
    if (!el) return false;
    const at = { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, view: window, button: 0 };
    el.dispatchEvent(new MouseEvent("mousemove", at));
    await new Promise((r) => setTimeout(r, 400));
    el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.dispatchEvent(new MouseEvent("click", at));
    return true;`);

  const opened = () => bridge.eval(`return window.__openedUrls;`);

  assert(await clickCell(3, 0), "clicked the OSC 8 hyperlink");
  await bridge.waitFor("the OSC 8 link to be opened", `return window.__openedUrls.includes(${JSON.stringify(OSC8_URL)});`, { timeoutMs: 5_000 })
    .catch(() => {});
  log(`  opened after the OSC 8 click: ${JSON.stringify(await opened())}`);
  assert((await opened()).includes(OSC8_URL), "a click on an OSC 8 hyperlink opens its URL");

  // Move away first so the next hover is a fresh one.
  await bridge.eval(`
    const p = window.__HERMES_E2E__.cellPoint(${JSON.stringify(sid)}, 0, 5);
    document.elementFromPoint(p.x, p.y)?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: p.x, clientY: p.y }));
    return true;`);
  assert(await clickCell(5, 1), "clicked the plain URL");
  await bridge.waitFor("the plain URL to be opened", `return window.__openedUrls.includes(${JSON.stringify(PLAIN_URL)});`, { timeoutMs: 5_000 })
    .catch(() => {});
  log(`  opened after the plain-URL click: ${JSON.stringify(await opened())}`);
  assert((await opened()).includes(PLAIN_URL), "a click on a plain URL opens it");
});
