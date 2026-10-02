#!/usr/bin/env node
// QA-host-font-size-zero (CHAOS-01) — a terminal font size of "0" in the
// settings (a typo, a hand-edited setting, a synced value) used to freeze
// the window for good on the next launch: the terminal size was computed
// as Infinity columns. EXPECT: the window answers and the terminal draws,
// at a usable size, with the size kept between 8 and 40.
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-font-size-zero";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, app, bridge } = await startApp("qa-font", evidenceDir, log, onCleanup, apps);
  await newTerminal(bridge, "before");
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "font_size", value: "0" }); return true;`);
  log("font_size set to '0'; relaunch");
  await app.stop();
  const app2 = await fx.launch(evidenceDir, 2);
  apps.push(app2);
  const b2 = app2.bridge;
  await sleep(3000);
  const started = Date.now();
  const ok = await b2.eval(`return !!e2e.first(".topbar");`, { timeoutMs: 8000 }).catch((e) => {
    log(`  eval: ${e.message}`);
    return false;
  });
  log(`  the page answered in ${Date.now() - started} ms: ${ok}`);
  assert(ok, "the window renders and answers");
  const id = await newTerminal(b2, "after");
  const info = await b2.eval(`return window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});`);
  log(`  terminal: ${JSON.stringify(info)}`);
  await b2.screenshot(join(evidenceDir, "01-relaunch.png"));
  assert(Number.isFinite(info?.cols) && info.cols >= 10 && info.cols < 1000, "the terminal has a usable width");
  await b2.typeInTerminal(id, "echo font-ok\n");
  await b2.waitForTerminal(id, /^font-ok/, { timeoutMs: 15_000 });
  log("  ok — typing works");
});
