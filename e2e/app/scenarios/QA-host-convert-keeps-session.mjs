#!/usr/bin/env node
// QA-host-convert-keeps-session — Convert to agent on a terminal Claude task
// closed the session outright: it left the sidebar (its agent started anyway,
// with nothing to show it), and the close deleted the task's worktree, with
// every uncommitted and untracked file in it, before recreating it from the
// branch.
//
// EXPECT: a task (fake Claude in a terminal, in its own worktree) with an
// edited tracked file and a new untracked file; the pane header's right-click
// menu offers "Convert to agent (!)"; choosing it and confirming leaves the
// session in the sidebar, now showing Agent view, the agent runs in the same
// worktree, and both files are still there as they were.
//
// The agent is a fake bridge (e2e/app/fixtures/fake-claude-bridge.mjs through
// HERMES_BRIDGE_PATH), the terminal Claude the fake CLI (tools/fake-agents).
//
// Negative control: a build without the fix ends in RESULT: FAIL (the session
// leaves the sidebar and the untracked file is gone).

import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness.mjs";
import {
  L,
  endScenario,
  gitAs,
  gitFixtures,
  invoke,
  launchTask,
  scenarioContext,
  sessionLabel,
  showSessionsPanel,
  sleep,
  worktreeInfo,
  worktreesOf,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-host-convert-keeps-session";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;

const fx = gitFixtures("convert", log);
const bridgeCopy = join(fx.work, "fake-claude-bridge.mjs");
copyFileSync(join(REPO_ROOT, "e2e", "app", "fixtures", "fake-claude-bridge.mjs"), bridgeCopy);
const bridgeLog = join(fx.work, "fake-bridge.ndjson");
const bridgeEvents = () =>
  existsSync(bridgeLog) ? readFileSync(bridgeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
// One spelling per folder (macOS: /var is /private/var).
const norm = (p) => {
  let s = String(p ?? "");
  try {
    s = realpathSync.native(s);
  } catch {
    /* gone: compare as given */
  }
  return s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
};

const UNTRACKED = "notes-before-convert.md";
const UNTRACKED_TEXT = "written before Convert to agent\n";
const EDITED_TEXT = "# launcher-repo\n\nan edit nobody committed\n";

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir, 1, { env: { HERMES_BRIDGE_PATH: bridgeCopy, HERMES_FAKE_BRIDGE_LOG: bridgeLog } });
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);

  log("step 1: a Claude task in its own worktree, in a terminal");
  const r = await launchTask(bridge, { task: "Convert me to Agent view", log });
  const sid = r.sessionId;
  const label = await sessionLabel(bridge, sid);
  const wt = await worktreeInfo(bridge, sid, project.id);
  const session = (await invoke(bridge, "get_sessions")).find((s) => s.id === sid);
  log(`  task "${label}" (${sid}) on ${wt.branchName} in ${wt.worktreePath}; agent=${session?.ai_provider} mode=${session?.mode}`);
  if (!session || session.ai_provider !== "claude" || session.mode !== "terminal") {
    throw new Error(`the launcher did not start a terminal Claude session: ${JSON.stringify({ ai_provider: session?.ai_provider, mode: session?.mode })}`);
  }
  if (norm(wt.worktreePath) === norm(fx.repo)) throw new Error("the task runs in the main checkout, not in a worktree of its own");

  log("step 2: uncommitted work in the worktree");
  writeFileSync(join(wt.worktreePath, UNTRACKED), UNTRACKED_TEXT);
  writeFileSync(join(wt.worktreePath, "README.md"), EDITED_TEXT);
  const statusBefore = gitAs(wt.worktreePath, "status", "--porcelain", "--untracked-files=all");
  log(`  git status before:\n${statusBefore}`);

  log("step 3: right-click the pane header");
  await showSessionsPanel(bridge);
  const items = await bridge.eval(`
    const captured = [];
    const origFetch = window.fetch;
    // The native menu is captured, never shown (it would block the run).
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? "";
      if (/show_context_menu/.test(url)) {
        try { captured.push(JSON.parse(init.body).items); } catch { captured.push([]); }
        return new Promise(() => {});
      }
      return origFetch(input, init);
    };
    try {
      const host = e2e.must(document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]'), "the task's terminal");
      const header = e2e.must(host.closest(".split-pane")?.querySelector(".split-pane-header"), "the pane header");
      header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
      await new Promise((res) => setTimeout(res, 300));
    } finally {
      window.fetch = origFetch;
    }
    return captured.flat().filter((i) => i && i.id).map((i) => ({ id: i.id, label: i.label ?? i.text ?? null }));
  `);
  log(`  menu: ${JSON.stringify(items)}`);
  const convert = items.find((i) => i.id === "pane.convert-to-agent");
  if (!convert) throw new Error("the pane header's menu offers no Convert to agent");
  log(`  menu item: ${JSON.stringify(convert)}`);

  log("step 4: choose Convert to agent and confirm");
  // What the native menu sends when the item is clicked.
  await invoke(bridge, "plugin:event|emit", { event: "menu-action", payload: { action: "pane.convert-to-agent" } });
  const ask = await bridge.waitFor("the convert question", `const d = e2e.first(".split-pane-mode-confirm"); return d ? e2e.norm(d.innerText) : null;`, { timeoutMs: 10_000 });
  log(`  asks: ${ask}`);
  await bridge.screenshot(join(evidenceDir, "01-convert-question.png"));
  await bridge.clickByName("Convert", { within: ".split-pane-mode-confirm" });
  await bridge.waitFor("the conversion to finish", `return !e2e.first(".split-pane-mode-confirm");`, { timeoutMs: 30_000 });

  log("step 5: the session is still there, in Agent view");
  const view = await bridge
    .waitFor("the task's Agent view", `return !!document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]');`, { timeoutMs: 20_000 })
    .catch(() => false);
  // Long enough for a late "session removed" to arrive.
  await sleep(3000);
  const rows = await bridge.eval(`
    return e2e.all(".session-item").map((el) => ({ text: e2e.norm(el.innerText).slice(0, 80), destroyed: el.classList.contains("session-item-destroyed") }));
  `);
  log(`  sidebar: ${JSON.stringify(rows)}`);
  await bridge.screenshot(join(evidenceDir, "02-after-convert.png"));
  check(rows.some((row) => row.text.includes(label) && !row.destroyed), `"${label}" is still in the sidebar, not ended`);
  check(
    !!view && (await bridge.eval(`return !!document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]');`)),
    "the session shows Agent view",
  );
  const start = bridgeEvents().find((e) => e.event === "start");
  const argv = start?.argv ?? [];
  const wdAt = argv.indexOf("--working-dir");
  const agentDir = wdAt >= 0 ? argv[wdAt + 1] : null;
  log(`  agent started in: ${agentDir}`);
  check(norm(agentDir) === norm(wt.worktreePath), "the agent runs in the task's worktree");

  log("step 6: the worktree and its uncommitted work are as they were");
  const linked = worktreesOf(fx.repo).find((w) => norm(w.path) === norm(wt.worktreePath));
  log(`  git worktree: ${JSON.stringify(linked)}`);
  check(!!linked && linked.branch === wt.branchName, `the worktree is still registered on ${wt.branchName}`);
  const untracked = existsSync(join(wt.worktreePath, UNTRACKED)) ? readFileSync(join(wt.worktreePath, UNTRACKED), "utf8") : null;
  check(untracked === UNTRACKED_TEXT, `the untracked ${UNTRACKED} is still there with its text`);
  const readme = existsSync(join(wt.worktreePath, "README.md")) ? readFileSync(join(wt.worktreePath, "README.md"), "utf8") : null;
  check(readme === EDITED_TEXT, "the uncommitted edit to README.md is still there");
  const statusAfter = existsSync(wt.worktreePath) ? gitAs(wt.worktreePath, "status", "--porcelain", "--untracked-files=all") : "(worktree gone)";
  log(`  git status after:\n${statusAfter}`);
  check(statusAfter === statusBefore, "git sees the same uncommitted changes as before");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
