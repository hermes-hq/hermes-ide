#!/usr/bin/env node
// FIX-terminal-scroll-hold — reading scrollback is not interrupted.
//
//   1. a plain terminal prints 3,000 lines
//   2. scroll up with the mouse wheel. EXPECT: Hermes knows the view is
//      scrolled up, and the view is above the last page
//   3. the window is resized, which refits the terminal. EXPECT: the view
//      stays where it was instead of jumping to the bottom
//   4. scroll back to the bottom and print more. EXPECT: the view follows the
//      new output again
//
// Was broken: the "scrolled up" check compared the last page with itself, so
// it was never true; any refit (a resize, a session switch, the reply strip
// appearing) threw the view to the bottom while you were reading.
//
// Negative control: a build before the fix ends in RESULT: FAIL at step 2.

import { join } from "node:path";
import { launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";

const SCENARIO = "FIX-terminal-scroll-hold";
const LINES = 3000;

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);
const info = (bridge, id) => bridge.eval(`return window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});`);

async function resize(bridge, width, height) {
  await invoke(bridge, "plugin:window|set_size", { label: "main", value: { Logical: { width, height } } });
  await bridge.waitFor(`the window at ${width} × ${height}`, `return Math.abs(innerWidth - ${width}) <= 40 && innerHeight <= ${height} + 2;`, { timeoutMs: 10_000 });
}

/** Turn the mouse wheel over the terminal (negative = up). */
const wheel = (bridge, id, deltaY, times) =>
  bridge.eval(`
    const pane = e2e.all(".split-pane").find((p) => p.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(id)}) + '"]'));
    const el = pane?.querySelector(".xterm-screen");
    if (!el) return false;
    const r = el.getBoundingClientRect();
    for (let i = 0; i < ${times}; i++) {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: ${deltaY}, deltaMode: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    }
    return true;
  `);

await runScenario(SCENARIO, async ({ log, assert, apps, evidenceDir }) => {
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);
  await resize(bridge, 1000, 680);
  const id = await createPlainTerminal(bridge, log);

  log(`step 1: print ${LINES} lines`);
  await bridge.typeInTerminal(id, `node -e "for(let i=1;i<=${LINES};i++)console.log('scroll-line-'+i)"\n`);
  await bridge.waitForTerminal(id, new RegExp(`^scroll-line-${LINES}$`), { timeoutMs: 30_000 });
  await sleep(500);
  const atEnd = await info(bridge, id);
  log(`  rows=${atEnd.rows} viewportY=${atEnd.viewportY} baseY=${atEnd.baseY} scrolledUp=${atEnd.scrolledUp}`);
  assert(atEnd.viewportY === atEnd.baseY && atEnd.scrolledUp === false, "after the output the view is at the bottom");

  log("step 2: scroll up");
  assert(await wheel(bridge, id, -400, 6), "the terminal took the wheel");
  await sleep(400);
  const up = await info(bridge, id);
  log(`  viewportY=${up.viewportY} baseY=${up.baseY} scrolledUp=${up.scrolledUp}`);
  assert(up.viewportY < up.baseY, "the view moved above the last page");
  assert(up.scrolledUp === true, "Hermes knows the view is scrolled up");
  await bridge.screenshot(join(evidenceDir, "01-scrolled-up.png"));

  log("step 3: resize the window (refits the terminal)");
  await resize(bridge, 940, 640);
  await sleep(800);
  const after = await info(bridge, id);
  log(`  rows=${after.rows} viewportY=${after.viewportY} baseY=${after.baseY} scrolledUp=${after.scrolledUp}`);
  assert(after.rows !== up.rows || after.cols !== up.cols, "the resize refitted the terminal");
  assert(after.viewportY < after.baseY, "the view stayed in the scrollback instead of jumping to the bottom");
  await bridge.screenshot(join(evidenceDir, "02-after-resize.png"));

  log("step 4: back to the bottom, then more output");
  await wheel(bridge, id, 4000, 20);
  await bridge.waitFor("the view at the bottom", `const i = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)}); return i.viewportY === i.baseY && i.scrolledUp === false;`, { timeoutMs: 10_000 });
  await bridge.typeInTerminal(id, `node -e "for(let i=1;i<=200;i++)console.log('more-line-'+i)"\n`);
  await bridge.waitForTerminal(id, /^more-line-200$/, { timeoutMs: 30_000 });
  await sleep(500);
  const end = await info(bridge, id);
  log(`  viewportY=${end.viewportY} baseY=${end.baseY} scrolledUp=${end.scrolledUp}`);
  assert(end.viewportY === end.baseY, "the view follows new output at the bottom");
});
