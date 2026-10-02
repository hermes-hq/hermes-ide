#!/usr/bin/env node
// QA-status-radar-real-ledger — Collision Radar on the REAL turn ledger.
//
// Two fake Claude Code agents work in the same checkout; each runs one turn
// that appends to the same file (.fake-work.log, the fake CLI's work-log
// mode). Their turns end through Claude Code's Stop hook, which reaches the
// app as a status, never as a `turn_end` event, and the turn ledger records
// each turn and says so (`hermes:turn-ledger`).
//
// EXPECT: within a few seconds of the second turn, both rows show the
// overlap badge naming the other session, without anything else having to
// re-read the ledger.
//
// Was broken: the radar refreshed only on `turn_end` events, so after a real
// turn the badges never appeared (F37 passed because it injects turn_end).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/QA-status-radar-real-ledger.mjs

import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { sleep, startAgent, startApp, writeTo } from "../qa-status-steps.mjs";

await runScenario("QA-status-radar-real-ledger", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-radar", evidenceDir, log, onCleanup, apps);
  fx.setFake("mode", "prompts work-log");
  // No Done-When checks: one plain turn per prompt.
  fx.git("rm", "-q", "-r", ".hermes");
  fx.git("commit", "-q", "-m", "no checks");
  const A = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  const B = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: rate limiter" }, 2);
  await sleep(4000);
  for (const id of [A, B]) {
    await writeTo(bridge, id, "append a line\r");
    await sleep(3000);
  }
  const turns = await bridge.eval(`
    const out = {};
    for (const id of ${JSON.stringify([A, B])}) {
      try { out[id.slice(0, 8)] = (await window.__TAURI_INTERNALS__.invoke("list_turns", { sessionId: id })).map((t) => ({ n: t.n, files: t.diffstat?.files, paths: t.paths })); }
      catch (e) { out[id.slice(0, 8)] = String(e); }
    }
    return out;`);
  log(`  turns in the ledger: ${JSON.stringify(turns)}`);
  const turnEnds = await bridge.eval(
    `return ${JSON.stringify([A, B])}.map((id) => window.__HERMES_E2E__.sessionEventSnapshot(id).events.filter((e) => e.type === "turn_end").length);`,
  );
  log(`  turn_end events the app saw: ${JSON.stringify(turnEnds)} (the Stop hook path sends none)`);
  const badgesJs = `${JSON.stringify([A, B])}.map((id) => { const b = document.querySelector('.session-item[data-session-item-id="' + id + '"] .session-overlap-badge'); return b ? { text: e2e.norm(b.innerText), with: b.getAttribute("data-overlap-with") || "" } : null; })`;
  let badges;
  try {
    badges = await bridge.waitFor("both overlap badges", `const b = ${badgesJs}; return b.every(Boolean) ? b : null;`, { timeoutMs: 10_000 });
  } catch {
    badges = await bridge.eval(`return ${badgesJs};`);
  }
  log(`  badges: ${JSON.stringify(badges)}`);
  await bridge.screenshot(join(evidenceDir, "01-radar.png"));
  assert(badges.every(Boolean), "both sessions show the overlap badge after their real turns end");
  assert(badges[0].with.includes(B) && badges[1].with.includes(A), "each badge names the other session");
});
