#!/usr/bin/env node
// Scenario (N11): a working-directory report (OSC 7) that reaches Hermes in
// two separate reads still updates the session's folder.
//
// A program in a plain terminal prints the start of the report, pauses for a
// second (so the two halves arrive as separate reads from the terminal), then
// prints the rest and keeps running. The status bar and the terminal must
// switch to the reported folder while the program is still running — so no
// later shell prompt can be what updated it.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N11-split-cwd-report.mjs

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";

await runScenario("N11-split-cwd-report", async ({ evidenceDir, log, assert, apps }) => {
  log("step 1: launch the test app with a private home folder");
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  log("step 2: create a plain terminal");
  const sessionId = await createPlainTerminal(bridge, log);
  const home = join(app.tmpDir, "home");
  const startCwd = (await bridge.eval(`return window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)}).cwd;`)) ?? "";
  log(`  terminal starts in: ${startCwd}`);

  // The folder the program reports. It exists, but the shell never enters it.
  const target = join(home, "split-target");
  mkdirSync(target, { recursive: true });
  const reported = realpathSync(target);
  writeFileSync(
    join(home, "split-report.sh"),
    [
      `printf '\\033]7;file://e2e-host${reported.slice(0, 12)}'`,
      "sleep 1",
      `printf '%s\\007' '${reported.slice(12)}'`,
      "echo split-report-sent",
      "sleep 30",
      "",
    ].join("\n"),
  );
  log(`  the program reports "${reported}" in two halves, one second apart`);

  log("step 3: run the program");
  await bridge.typeInTerminal(sessionId, "sh split-report.sh\n");
  await bridge.waitForTerminal(sessionId, /^split-report-sent$/, { timeoutMs: 15_000 });
  log("  the program printed both halves and is still running");

  log("step 4: the session's folder follows the report");
  const cwd = await bridge.waitFor(
    "the terminal's folder to become the reported one",
    `const c = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)}).cwd;
     return c === ${JSON.stringify(reported)} ? c : null;`,
    { timeoutMs: 10_000 },
  );
  assert(cwd === reported, `the terminal's folder is now ${cwd}`);
  const status = await bridge.waitFor(
    "the status bar to show the reported folder",
    `const el = e2e.all(".status-bar-item.mono").find((e) => (e.getAttribute("title") || "").includes(${JSON.stringify(reported)}));
     return el ? { text: el.innerText.trim(), title: el.getAttribute("title") } : null;`,
    { timeoutMs: 15_000 },
  );
  assert(status.text === "split-target", `the status bar shows "${status.text}" (${status.title})`);
  // The program sleeps for 30 s after the report, so no shell prompt (which
  // reports the shell's own folder, the home folder) has run since.
  await sleep(300);
  const shot = await bridge.screenshot(join(evidenceDir, "01-status-bar-after-split-report.png"));
  log(`  screenshot saved: ${shot.file}`);
});
