#!/usr/bin/env node
// QA-status-notice-visible — a Hermes notice is the only thing waiting (no
// agent blocked): the title-bar badge, the dock and ⌘I still show it, while
// the agent count stays 0.
//
//   1. one fake agent, not blocked; the disk guard raises a Hermes notice
//   EXPECT: the badge is lit with a "!" mark (its agent count stays 0, its
//   label names the notice), the dock badge shows "!"
//   2. ⌘I (Ctrl+Shift+I on Windows and Linux)
//   EXPECT: the inbox opens on the notice; nothing says "Nothing is waiting"
//   3. Enter dismisses the notice
//   EXPECT: the badge is a quiet 0 and the dock badge is cleared
//
// Was broken: with only a Hermes notice open (the disk guard, an away
// message that could not be sent) the badge showed a neutral 0, the dock
// was blank and ⌘I said "Nothing is waiting on you".

import { join } from "node:path";
import { onMac } from "../launcher-steps.mjs";
import { runScenario } from "../n11-steps.mjs";
import { pressNextWaiting, sleep, startAgent, startApp } from "../qa-status-steps.mjs";

const readBadge = (bridge) =>
  bridge.eval(`const b = e2e.first(".attention-badge");
    return { text: e2e.norm(b.innerText), count: Number(b.dataset.count), notices: Number(b.dataset.notices),
      hot: b.classList.contains("attention-badge-hot"), label: b.getAttribute("aria-label") };`);
const readDock = async (bridge) => (await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("attention_state_for_test")).badge;`));

await runScenario("QA-status-notice-visible", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-notice", evidenceDir, log, onCleanup, apps);
  await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  await sleep(2000);
  await bridge.eval(`window.__HERMES_E2E__.raiseInboxItem({ kind: "error", sessionId: null, detail: "Only 2 GB left on the disk", source: "worktree" }); return true;`);
  await sleep(800);

  const badge = await readBadge(bridge);
  const dock = await readDock(bridge);
  log(`  badge: ${JSON.stringify(badge)}; dock: ${JSON.stringify(dock)}`);
  await bridge.screenshot(join(evidenceDir, "01-badge.png"));
  assert(badge.count === 0, `no agent is counted (${badge.count})`);
  assert(badge.hot && badge.text === "!", `the badge is lit with a "!" mark (${JSON.stringify(badge)})`);
  assert(/1 notice/.test(badge.label), `its label names the notice: "${badge.label}"`);
  assert(dock.label === "!", `the dock badge shows the notice (${JSON.stringify(dock)})`);
  if (onMac) assert(dock.os?.dockBadgeLabel === "!", `macOS shows "!" on the dock tile (${JSON.stringify(dock.os)})`);

  await pressNextWaiting(bridge);
  const inbox = await bridge.waitFor("the inbox on the notice", `
    if (!e2e.first(".attention-inbox")) return null;
    const sel = e2e.first('.attention-option[aria-selected="true"]');
    return { selected: sel ? { section: sel.closest(".attention-group")?.dataset.section, text: e2e.norm(sel.innerText) } : null,
      note: e2e.first(".attention-position") ? e2e.norm(e2e.first(".attention-position").innerText) : null };`, { timeoutMs: 3000 }).catch(() => null);
  const note = await bridge.eval(`const n = e2e.first(".attention-position"); return n ? e2e.norm(n.innerText) : null;`);
  log(`  after ⌘I: ${JSON.stringify(inbox)}; note: ${JSON.stringify(note)}`);
  await bridge.screenshot(join(evidenceDir, "02-cmd-i.png"));
  assert(inbox && inbox.selected?.section === "notices" && /2 GB/.test(inbox.selected.text), "⌘I opens the inbox on the notice");
  assert(!note || !/Nothing is waiting/.test(note), `⌘I does not say nothing is waiting (${note})`);

  await bridge.eval(`e2e.first(".attention-list").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true;`);
  await bridge.waitFor("the notice dismissed", `return Number(e2e.first(".attention-badge").dataset.notices) === 0;`);
  await sleep(500);
  const after = await readBadge(bridge);
  const dockAfter = await readDock(bridge);
  log(`  dismissed: badge ${JSON.stringify(after)}; dock ${JSON.stringify(dockAfter)}`);
  await bridge.screenshot(join(evidenceDir, "03-dismissed.png"));
  assert(!after.hot && after.text === "0", "the badge is a quiet 0 again");
  assert(dockAfter.label === null && (!onMac || !dockAfter.os?.dockBadgeLabel), `the dock badge is cleared (${JSON.stringify(dockAfter)})`);
});
