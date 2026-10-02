#!/usr/bin/env node
// QA-host-restored-scrollback (CHAOS-03) — the grey "restored" history a
// terminal shows after a relaunch used to be built from raw read chunks: a
// command typed at the prompt came back one letter per line ("e", "c", "h",
// "o", ...). EXPECT: the typed command comes back on one line.
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-restored-scrollback";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, app, bridge } = await startApp("qa-scroll", evidenceDir, log, onCleanup, apps);
  const sid = await newTerminal(bridge, "history");
  await bridge.typeInTerminal(sid, "echo restore-me-please\n");
  await bridge.waitForTerminal(sid, /^restore-me-please/);
  await sleep(2500);
  log(`  quit: ${JSON.stringify(await app.stop())}`);
  const app2 = await fx.launch(evidenceDir, 2);
  apps.push(app2);
  const b2 = app2.bridge;
  await b2.waitFor("the restored terminal", `return window.__HERMES_E2E__.terminalIds().length === 1;`, { timeoutMs: 30_000 });
  const id = (await b2.terminalIds())[0];
  await b2.waitForTerminal(id, /session restored/, { timeoutMs: 20_000 });
  await sleep(1000);
  const lines = (await b2.readTerminal(id)).map((l) => l.trimEnd());
  const upto = lines.findIndex((l) => l.includes("session restored"));
  const restored = lines.slice(0, upto);
  log(`  restored part:\n${restored.map((l) => "    |" + l).join("\n")}`);
  await b2.screenshot(join(evidenceDir, "01-restored.png"));
  const oneLetter = restored.filter((l) => l.trim().length === 1).length;
  assert(restored.some((l) => l.includes("echo restore-me-please")), "the typed command is restored on one line");
  assert(oneLetter < 2, `no command is spread one letter per line (${oneLetter} one-letter lines)`);
});
