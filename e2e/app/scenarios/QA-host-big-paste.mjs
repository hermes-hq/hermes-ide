#!/usr/bin/env node
// QA-host-big-paste (CHAOS-05) — pasting more than 4 MB into a terminal in
// the session host used to be dropped whole, without a word: the paste went
// to the host as one frame, over the host's frame limit. EXPECT: every byte
// reaches the program.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, onWindows, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-big-paste";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "the 4 MB frame limit is the session host's (macOS, Linux)", log });
  const { fx, bridge } = await startApp("qa-paste", evidenceDir, log, onCleanup, apps);
  const outFile = join(fx.work, "pasted.txt");
  const sid = await newTerminal(bridge, "paste");
  const hosted = await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((s) => s.id === ${JSON.stringify(sid)})?.hosted;`);
  assert(hosted === true, "the terminal lives in the session host");
  await bridge.typeInTerminal(sid, `stty -icanon; cat > '${outFile}'\n`);
  await sleep(1000);
  const len = await bridge.eval(`
    const ta = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"] textarea.xterm-helper-textarea');
    const line = "paste-line-" + "y".repeat(88) + "\\n";
    const text = line.repeat(Math.round(5 * 1048576 / line.length));
    const dt = new DataTransfer(); dt.setData("text/plain", text);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return text.length;`, { timeoutMs: 60_000 });
  log(`  pasted ${len} bytes into \`cat > file\``);
  let size = 0;
  for (let i = 0; i < 40 && size < len; i++) {
    await sleep(1000);
    size = existsSync(outFile) ? statSync(outFile).size : 0;
  }
  log(`  the program received ${size} bytes`);
  await bridge.screenshot(join(evidenceDir, "01-after-paste.png"));
  assert(size === len, `all ${len} pasted bytes reached the program`);
  await bridge.typeInTerminal(sid, "\x04");
});
