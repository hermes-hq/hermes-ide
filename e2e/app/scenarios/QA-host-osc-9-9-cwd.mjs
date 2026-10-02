#!/usr/bin/env node
// QA-host-osc-9-9-cwd (XP-06) — PowerShell prompts (Windows Terminal's shell
// integration, oh-my-posh) print `OSC 9;9;"<folder>"` at every prompt. It
// used to read as a terminal notification: the terminal showed "needs an
// answer" with `9;"C:\..."` as the question. EXPECT: it sets the session's
// folder and is never a notification; other ConEmu codes say nothing; a
// plain OSC 9 notification still is one.
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, onWindows, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-osc-9-9-cwd";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "prints the sequences with printf (sh); the parsing is the same on every OS", log });
  const { bridge } = await startApp("qa-osc99", evidenceDir, log, onCleanup, apps);
  const sid = await newTerminal(bridge, "pwsh-like");
  const state = () =>
    bridge.eval(`
      const id = ${JSON.stringify(sid)};
      return { status: window.__HERMES_E2E__.sessionStatus(id), attention: window.__HERMES_E2E__.sessionEventSnapshot(id)?.attention ?? null,
        inbox: window.__HERMES_E2E__.inboxItems().filter((i) => i.sessionId === id).map((i) => i.kind),
        cwd: (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((s) => s.id === id)?.working_directory };`);
  log("step 1: three prompts' worth of OSC 9;9, then prompt marks and a progress bar");
  await bridge.typeInTerminal(sid, `for d in 'C:\\Work\\proj' 'D:\\work'; do printf '\\033]9;9;"%s"\\033\\\\' "$d"; sleep 0.3; done; printf '\\033]9;12\\007\\033]9;4;1;50\\007'; echo osc-done; sleep 4\n`);
  await bridge.waitForTerminal(sid, /^osc-done/, { timeoutMs: 10_000 });
  // Read before the next prompt: the shell integration then reports the
  // real folder again (OSC 7).
  await sleep(800);
  const after = await state();
  log(`  after: ${JSON.stringify(after)}`);
  await bridge.screenshot(join(evidenceDir, "01-after-osc-9-9.png"));
  assert(after.status.kind !== "needs_answer" && after.attention === null, "no notification and no 'needs an answer'");
  assert(after.cwd === "D:\\work", "the session's folder is the last one reported");

  log("step 2: a plain OSC 9 notification is still one");
  await bridge.typeInTerminal(sid, `printf '\\033]9;Build finished\\007'; echo note-done\n`);
  await bridge.waitForTerminal(sid, /^note-done/, { timeoutMs: 10_000 });
  await sleep(1500);
  const note = await state();
  log(`  after: ${JSON.stringify(note)}`);
  assert(note.attention === "Build finished", "a real notification still reaches Hermes");
});
