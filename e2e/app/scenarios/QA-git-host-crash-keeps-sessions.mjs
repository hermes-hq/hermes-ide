#!/usr/bin/env node
// QA-git (CHAOS-02): when the terminal service (hermes-pty-host) dies, the
// sessions it hosted stay listed, ended, with their output — and their
// worktrees are not deleted behind the person's back.
//
// Two tasks run (one in its own worktree). The session host is killed with
// SIGKILL. Both rows stay; one notice says "2 sessions ended. The terminal
// service stopped unexpectedly. …" with Restart and Close; the first
// session's output is still readable; the task's worktree folder is still
// on disk. Restart brings a working terminal back under the same session.
//
// macOS and Linux only (the session host is not used on Windows).
// Negative control: a build from before the fix ends in RESULT: FAIL (both
// sessions vanished within a second, with no notice).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { skipScenario } from "../harness.mjs";
import {
  L,
  endScenario,
  gitFixtures,
  invoke,
  launchTask,
  onWindows,
  scenarioContext,
  sleep,
  toasts,
  worktreeInfo,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-host-crash-keeps-sessions";
if (onWindows) skipScenario({ scenario: SCENARIO, reason: "the session host is not used on Windows" });
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("hostcrash", log);
/** The session host's pid, as the app reports it (null when none runs). */
const hostPid = async (bridge) => {
  const st = await invoke(bridge, "session_host_status");
  return st?.running && st.pid ? st.pid : null;
};
const killQuietly = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
};
let pidToKill = null;

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);
  // A plain shell (File → New Session Tab) and a task in its own worktree.
  const before = await bridge.terminalIds();
  await bridge.chooseMenuItem("file.new-session-tab");
  const [aId] = await L.newTerminals(bridge, before, 1, "the plain shell", 30_000);
  const a = { sessionId: aId };
  await bridge.waitForTerminal(a.sessionId, /%|\$|#|>/, { timeoutMs: 30_000 });
  await sleep(800);
  await bridge.typeInTerminal(a.sessionId, "echo important-output-alpha\n");
  await bridge.waitForTerminal(a.sessionId, /important-output-alpha/, { timeoutMs: 20_000 });
  const b = await launchTask(bridge, { task: "Refactor the parser", repo: fx.repo, log });
  const wt = await worktreeInfo(bridge, b.sessionId, project.id);
  await sleep(1500);
  const pid = await hostPid(bridge);
  log(`  session host pid: ${pid}`);
  check(pid !== null, "a session host runs the terminals");
  check((await bridge.eval(`return e2e.all(".session-item").length;`)) === 2, "two sessions are listed");

  log("step 1: kill the session host");
  killQuietly(pid);
  await bridge.waitFor("the notice", `return e2e.all(".toast").some((t) => /ended/.test(t.innerText));`, { timeoutMs: 20_000 });
  await sleep(1000);
  const after = await bridge.eval(`return { rows: e2e.all(".session-item").map((el) => e2e.norm(el.innerText)), ended: e2e.all(".session-item-destroyed").length };`);
  const notices = (await toasts(bridge)).filter((t) => /ended/.test(t));
  log(`  after: ${JSON.stringify(after)}; notices: ${JSON.stringify(notices)}`);
  await bridge.screenshot(join(evidenceDir, "01-after-host-crash.png"));
  check(after.rows.length === 2 && after.ended === 2, "both sessions are still listed, marked ended");
  check(notices.length === 1 && /^2 sessions ended\. The terminal service stopped unexpectedly\./.test(notices[0]), "one notice says what happened to both");
  check(/Restart/.test(notices[0] ?? "") && /Close/.test(notices[0] ?? ""), "the notice offers Restart and Close");
  const tail = await bridge.readTerminal(a.sessionId);
  check((tail || []).some((l) => l.includes("important-output-alpha")), "the first session's output is still readable");
  check(existsSync(wt.worktreePath), "the task's worktree folder is still on disk");

  log("step 2: Restart");
  await bridge.clickWhenReady(`const t = e2e.all(".toast").find((x) => /ended/.test(x.innerText)); const btn = t && e2e.all("button", t).find((x) => /Restart/.test(e2e.nameOf(x))); return btn ? e2e.click(btn) : false;`);
  await bridge.waitFor("the sessions to run again", `return e2e.all(".session-item-destroyed").length === 0 && e2e.all(".session-item").length === 2;`, { timeoutMs: 40_000 });
  // Show the first session: each restarted session takes the pane as it
  // starts, so the task's may be the one in view. Restart starts it again
  // under the same id, which replaces its terminal on screen: type once the
  // new one takes commands.
  const aRow = `.session-item[data-session-item-id="${a.sessionId}"]`;
  const showA = `if (document.querySelector('div[data-session-id="${a.sessionId}"]')) return true; const row = e2e.first(${JSON.stringify(aRow)}); return row ? e2e.click(row) : false;`;
  let ran = false;
  for (const deadline = Date.now() + 40_000; !ran && Date.now() < deadline; ) {
    try {
      await bridge.clickWhenReady(showA);
      await bridge.typeInTerminal(a.sessionId, "echo restarted-ok\n");
      await bridge.waitForTerminal(a.sessionId, /^restarted-ok/, { timeoutMs: 4_000 });
      ran = true;
    } catch {
      await sleep(500);
    }
  }
  check(ran, "the restarted terminal runs commands again");
  check(existsSync(wt.worktreePath), "the restarted task still has its worktree");
  pidToKill = await hostPid(bridge).catch(() => null);
} catch (e) {
  error = e;
}
await endScenario({
  ctx,
  app,
  error,
  scenario: SCENARIO,
  cleanup: () => {
    // Never leave a session host behind.
    if (pidToKill) killQuietly(pidToKill);
    fx.cleanup();
  },
});
