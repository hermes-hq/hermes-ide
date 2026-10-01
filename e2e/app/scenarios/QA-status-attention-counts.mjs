#!/usr/bin/env node
// QA-status-attention-counts — the badge, the dock and ⌘I count the same
// thing: agents blocked on you. A Hermes notice (no session, e.g. the disk
// guard) is listed apart as "Hermes · 1 notice" and never counted as an agent.
//
//   1. two fake Claude Code agents ask for permission (their own hooks)
//   2. agent A also reaches a track gate (a second item for the same agent)
//      and the disk guard raises a workspace notice
//   EXPECT: badge = dock = ⌘I's "of N" = 2; the badge's label names the
//   notice separately; the inbox lists the notice under "Hermes · 1 notice",
//   not under Blocked on you
//
// Was broken: the badge and the dock counted items (4), ⌘I counted
// sessions (2), and the morning view called items agents.

import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { block, pressNextWaiting, sleep, startAgent, startApp } from "../qa-status-steps.mjs";

await runScenario("QA-status-attention-counts", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-counts", evidenceDir, log, onCleanup, apps);
  const A = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  const B = await startAgent(bridge, fx, { cwd: fx.otherRepo, label: "web: dark mode" }, 2);
  await sleep(2500);
  await block(bridge, A);
  await block(bridge, B);
  await bridge.eval(`
    const H = window.__HERMES_E2E__;
    H.raiseInboxItem({ kind: "gate", sessionId: ${JSON.stringify(A)}, detail: "Plan ready for review", source: "track" });
    H.raiseInboxItem({ kind: "error", sessionId: null, detail: "Only 2 GB left on the disk", source: "worktree" });
    return true;`);
  await sleep(500);
  await pressNextWaiting(bridge);
  const note = await bridge.waitFor("the position note", `const n = e2e.first(".attention-position"); return n ? { text: e2e.norm(n.innerText), total: Number(n.dataset.total) } : null;`);
  const badge = await bridge.eval(`const b = e2e.first(".attention-badge"); return { count: Number(b.dataset.count), label: b.getAttribute("aria-label") };`);
  const dock = await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("attention_state_for_test")).badge;`);
  log(`  badge: ${JSON.stringify(badge)}; dock: ${JSON.stringify(dock)}; ⌘I: ${JSON.stringify(note)}`);
  await bridge.screenshot(join(evidenceDir, "01-counts.png"));
  assert(badge.count === 2, `the badge counts the 2 agents blocked on you (${badge.count})`);
  assert(badge.count === note.total, `the badge (${badge.count}) and ⌘I's "of ${note.total}" agree`);
  assert(dock.count === 2, `the dock badge counts the same 2 agents (${dock.count})`);
  assert(/2 agents/.test(badge.label) && /1 notice/.test(badge.label), `the badge's label names agents and the Hermes notice apart: "${badge.label}"`);

  await bridge.click(".attention-badge");
  const inbox = await bridge.waitFor("the inbox", `
    if (!e2e.first(".attention-inbox")) return null;
    const groups = e2e.all(".attention-group").map((g) => ({
      section: g.dataset.section,
      // textContent: the title is drawn in capitals (CSS), its words are not.
      title: e2e.norm(g.querySelector(".attention-group-title")?.textContent ?? ""),
      sessions: [...g.querySelectorAll(".attention-option")].map((o) => o.dataset.sessionId || "(hermes)"),
    }));
    return groups.length ? groups : null;`);
  log(`  inbox groups: ${JSON.stringify(inbox)}`);
  await bridge.screenshot(join(evidenceDir, "02-inbox.png"));
  const blocked = inbox.find((g) => g.section === "blocked");
  const notices = inbox.find((g) => g.section === "notices");
  assert(blocked && !blocked.sessions.includes("(hermes)"), "Blocked on you lists only agents");
  assert(notices && notices.title === "Hermes · 1 notice" && notices.sessions.length === 1, `the notice is listed as "Hermes · 1 notice" (${notices?.title})`);
});
