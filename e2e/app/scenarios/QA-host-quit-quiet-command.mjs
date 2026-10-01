#!/usr/bin/env node
// QA-host-quit-quiet-command (CHAOS-11) — a command that runs but prints
// nothing (a silent migration, `sleep`, an idle REPL) used to count as idle,
// and quitting stopped it without asking. EXPECT: the terminal's foreground
// is the command, not the shell, so quitting asks; "Keep running" keeps it,
// and the question says "A program is still running", not "agent" (CHAOS-19).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, onWindows, pidAlive, quitAndReadQuestion, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-quit-quiet-command";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows has no session host to keep the command running", log });
  const { fx, app, bridge } = await startApp("qa-quiet", evidenceDir, log, onCleanup, apps);
  const pidFile = join(fx.work, "job.pid");
  let pid = null;
  onCleanup(() => {
    if (pid && pidAlive(pid)) process.kill(pid, "SIGKILL");
  });
  const sid = await newTerminal(bridge, "quiet");
  await bridge.typeInTerminal(sid, `sh -c 'echo $$ > "${pidFile}"; exec sleep 300'\n`);
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(100);
  pid = Number(readFileSync(pidFile, "utf8"));
  await sleep(2500);
  log(`  silent job pid ${pid}`);
  const question = await quitAndReadQuestion(app);
  log(`  quit question: ${question ?? "(none: the app just quit)"}`);
  if (question) {
    await bridge.screenshot(join(evidenceDir, "01-question.png"));
    const rows = await bridge.eval(`return e2e.all(".quit-dialog-session").map((r) => ({ kind: r.dataset.kind, text: e2e.norm(r.innerText) }));`);
    log(`  rows: ${JSON.stringify(rows)}`);
    await bridge.click('[data-testid="quit-with-agents-dialog"] .quit-dialog-btn-keep');
  }
  await app.stop({ stopPrograms: false });
  await sleep(1500);
  const alive = pidAlive(pid);
  log(`  silent job alive after the quit: ${alive}`);
  assert(!!question, "quitting asks before stopping the running command");
  assert(/A program is still running/.test(question) && !/agent/i.test(question), "it calls it a program, not an agent");
  assert(alive, "Keep running kept it running");
});
