#!/usr/bin/env node
// QA-close-idle-shell — closing a plain shell that sits at its prompt asked
// "A program is still running in it", and the closed session was missing from
// the start screen's recent sessions until a relaunch. EXPECT: an idle shell
// closes at once, and the start screen lists it right away; a shell running a
// command still asks.
import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { showSessionsPanel } from "../qa-git-steps.mjs";
import { newTerminal, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-close-idle-shell";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { bridge } = await startApp("qa-close", evidenceDir, log, onCleanup, apps);

  const clickClose = async (label) => {
    await showSessionsPanel(bridge);
    await bridge.clickWhenReady(`
    const row = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
    const b = row && [...row.querySelectorAll("button")].find((x) => /close/i.test(x.getAttribute("aria-label") || x.title || ""));
    return e2e.click(e2e.must(b, "the close button of ${label}"));
  `);
  };
  const rowGone = (label) => `return !e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));`;

  log("step 1: a shell at its prompt closes without asking");
  await newTerminal(bridge, "Idle shell");
  await clickClose("Idle shell");
  await bridge.waitFor("the session to close or ask", `return !!e2e.first(".close-dialog") || (() => { ${rowGone("Idle shell")} })();`, { timeoutMs: 10_000 });
  assert(!(await bridge.exists(".close-dialog")), "no 'Close session?' for a shell at its prompt");
  await bridge.waitFor("the session to be gone", rowGone("Idle shell"), { timeoutMs: 10_000 });

  log("step 2: the start screen lists it at once");
  await bridge.waitFor("the recent sessions to list it", `
    const l = e2e.first(".es-logbook");
    return !!l && l.innerText.includes("Idle shell");`, { timeoutMs: 10_000 }).catch(() => {});
  await bridge.screenshot(join(evidenceDir, "01-start-screen.png"));
  const logbook = await bridge.eval(`return e2e.first(".es-logbook")?.innerText ?? null;`);
  log(`  recent sessions: ${JSON.stringify(logbook)}`);
  assert(!!logbook && logbook.includes("Idle shell"), "the closed session is in the start screen's recent sessions without a relaunch");

  log("step 3: a shell running a command still asks");
  const busy = await newTerminal(bridge, "Busy shell");
  await bridge.typeInTerminal(busy, process.platform === "win32" ? "ping -n 600 127.0.0.1 > $null\r" : "sleep 600\n");
  await bridge.waitFor("the command to be running", `return !(await window.__TAURI_INTERNALS__.invoke("is_shell_foreground", { sessionId: ${JSON.stringify(busy)} }));`, { timeoutMs: 15_000 });
  await clickClose("Busy shell");
  await bridge.waitFor("the close confirmation", `return !!e2e.first(".close-dialog");`, { timeoutMs: 10_000 }).catch(() => {});
  await bridge.screenshot(join(evidenceDir, "02-busy-asks.png"));
  assert(await bridge.exists(".close-dialog"), "'Close session?' asks while a command runs");
  await bridge.click(".close-dialog .close-dialog-btn-confirm");
  await bridge.waitFor("the busy session to close", rowGone("Busy shell"), { timeoutMs: 10_000 });
});
