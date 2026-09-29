#!/usr/bin/env node
// Scenario F24: twenty terminals stay responsive, and stay within budget.
//
// On the real app, with the fleetPerf flag on:
//
//   1. Hermes's own memory with no session open is within budget.
//   2. Twenty terminal sessions are opened through the New Session wizard.
//      Only the terminal on screen ever holds a WebGL context.
//   3. Every one of the twenty answers: select it in the session list (the
//      switch, graphics context included, is timed) and run `echo`; the time
//      from Enter to the output on screen is within budget (p95 and worst).
//      Each switch leaves exactly the visible terminal with a context.
//   4. What each extra session costs Hermes is within budget; every row shows
//      its session's memory, matching what the backend measured.
//   5. A session running the fake agent shows the agent's memory on its row
//      (more than the bare shell, within budget).
//   6. Terminal throughput: text printed in a visible terminal reaches the
//      screen at no less than the budget; while another session floods, the
//      visible one still answers `echo` within budget.
//   7. "Tile working agents" (command palette) with nobody working says so
//      and changes nothing; with five sessions reported working it lays
//      exactly those five out in a grid, and those five hold the contexts.
//
// Budgets: e2e/app/fleet-budgets.json (per OS). Measurements go to the
// evidence folder (metrics.json) and result.json. Each memory reading is
// logged with the backend's own account of what it counted as Hermes (by
// program) and what it disowned as a stranger left by pid reuse, next to
// the OS's own view of the app's process tree, so a reading over budget
// says which processes made it so.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_F24_FLAG=off          the flag stays off: hidden terminals keep
//          their WebGL contexts (fails wherever the web view has WebGL, which
//          all three CI runners had on 2026-09-28), and the rows show no
//          memory.
//   HERMES_E2E_F24_BUDGET_SCALE=0.01 every budget a hundred times tighter
//          (the throughput floor a hundred times higher).
//   HERMES_E2E_F24_NEGATIVE=slow-output  the visible terminal's flood pauses
//          after every 64 KB, so its text arrives slower than the floor.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F24-fleet-perf.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, dismissWhatsNew, runScenario } from "../n11-steps.mjs";
import { processTreeByKind, sessionRow, setFlagOverride } from "../perf-steps.mjs";

const SCENARIO = "F24-fleet-perf";
const OS = platform();
const onWindows = OS === "win32";
const MAC = OS === "darwin";
const FLAG = process.env.HERMES_E2E_F24_FLAG === "off" ? "off" : "on";
const SCALE = Number(process.env.HERMES_E2E_F24_BUDGET_SCALE || "1");
const SESSIONS = Number(process.env.HERMES_E2E_F24_SESSIONS || "20");
const SLOW_FLOOD = process.env.HERMES_E2E_F24_NEGATIVE === "slow-output";
const MB = 1024 * 1024;

const raw = JSON.parse(readFileSync(join(REPO_ROOT, "e2e", "app", "fleet-budgets.json"), "utf8"));
/** Budget for this OS; `lower` budgets (a floor, like throughput) scale the other way. */
const budget = (value, { floor = false } = {}) => (floor ? value[OS] / SCALE : value[OS] * SCALE);
const BUDGET = {
  idleAppMemoryMb: budget(raw.idleAppMemoryMb),
  perSessionAppMemoryMb: budget(raw.perSessionAppMemoryMb),
  agentSessionMemoryMb: budget(raw.agentSessionMemoryMb),
  ptyThroughputMbPerSec: budget(raw.ptyThroughputMbPerSec, { floor: true }),
  echoP95Ms: budget(raw.echoLatencyMs.p95),
  echoMaxMs: budget(raw.echoLatencyMs.max),
  switchMs: budget(raw.switchMs),
};
/** How much text the throughput step prints (less where the terminal is slow). */
const FLOOD_MB = raw.floodMb[OS];

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const mb = (bytes) => Math.round((bytes / MB) * 10) / 10;

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${OS}   flag: ${FLAG}   budget scale: ${SCALE}   sessions: ${SESSIONS}`);
  log(`  budgets: ${JSON.stringify(BUDGET)}`);
  const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f24-"));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const privateHome = join(work, "home");
  mkdirSync(privateHome, { recursive: true });
  const metrics = { platform: OS, flag: FLAG, budgets: BUDGET };
  const saveMetrics = () => writeFileSync(join(evidenceDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  onCleanup(saveMetrics);

  const launch = (run, first) => {
    const common = { runDir: join(evidenceDir, `run-${run}`), log };
    return onWindows
      ? launchApp({ ...common, home: "real", resetData: first })
      : launchApp({ ...common, home: "private", homeDir: privateHome });
  };

  // ── run 1: the flag ───────────────────────────────────────────────
  log(`run 1: fresh install; set the fleetPerf flag ${FLAG}`);
  let app = await launch(1, true);
  apps.push(app);
  await completeOnboarding(app.bridge, log);
  await setFlagOverride(app.bridge, "fleetPerf", FLAG, assert);
  const exit1 = await app.stop();
  assert(!exit1.forced && exit1.code === 0, "the app quit cleanly");

  log("run 2: relaunch");
  app = await launch(2, false);
  apps.push(app);
  const { bridge } = app;
  await bridge.waitFor("the app UI (no onboarding this time)", `return !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge, log);

  /** The backend's reading, with how long it took and its own account of what it counted as Hermes. */
  const fleet = async () => {
    const t0 = Date.now();
    const f = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("fleet_memory");`);
    f.tookMs = Date.now() - t0;
    return f;
  };
  const programs = (list) => JSON.stringify(list.map((g) => ({ name: g.name, count: g.processes, mb: mb(g.bytes) })));
  const describeApp = (f) => `${mb(f.appBytes)} MB in ${f.appProcesses} process(es) (read in ${f.tookMs} ms); by program: ${programs(f.appByProgram)}; disowned by pid reuse: ${programs(f.disowned)}`;
  const contexts = () => bridge.eval(`
    const H = window.__HERMES_E2E__;
    const shown = H.terminalIds().filter((id) => H.terminalInfo(id)?.attached);
    const gl = H.graphicsContexts();
    return { available: gl.available, holders: gl.sessions.sort(), shown: shown.sort() };
  `);
  /** Only the terminals on screen hold a graphics context. */
  const checkContexts = async (when) => {
    const c = await contexts();
    if (!c.available) {
      assert(c.holders.length === 0, `${when}: this web view has no WebGL; no terminal holds a context`);
      return c;
    }
    assert(
      JSON.stringify(c.holders) === JSON.stringify(c.shown),
      `${when}: contexts held by exactly the ${c.shown.length} terminal(s) on screen (holders ${c.holders.length}: ${c.holders.map((s) => s.slice(0, 8)).join(",")})`,
    );
    return c;
  };

  // ── 1. idle memory ─────────────────────────────────────────────────
  log("step 1: Hermes's own memory with no session open");
  await sleep(3000);
  const idle = await fleet();
  metrics.idleAppMemoryMb = mb(idle.appBytes);
  metrics.idleAppProcesses = idle.appProcesses;
  metrics.idleAppByProgram = idle.appByProgram;
  metrics.idleDisowned = idle.disowned;
  log(`  Hermes: ${describeApp(idle)}`);
  // What the OS itself says is below the app, by kind: shows which process
  // grew when the budget fails.
  metrics.idleTreeByKind = processTreeByKind(bridge.pid);
  log(`  the OS's view of the app's tree: ${JSON.stringify(metrics.idleTreeByKind)}`);
  assert(idle.sessions.length === 0, "no session is open");
  assert(metrics.idleAppMemoryMb <= BUDGET.idleAppMemoryMb, `idle memory ${metrics.idleAppMemoryMb} MB <= ${BUDGET.idleAppMemoryMb} MB`);

  // ── 2. twenty sessions ─────────────────────────────────────────────
  log(`step 2: open ${SESSIONS} terminal sessions`);
  const ids = [];
  const created = Date.now();
  for (let i = 0; i < SESSIONS; i++) {
    ids.push(await createPlainTerminal(bridge, () => {}));
    if ((i + 1) % 5 === 0) log(`  ${i + 1} sessions open`);
  }
  metrics.openSessionsSeconds = Math.round((Date.now() - created) / 100) / 10;
  const firstContexts = await checkContexts(`with ${SESSIONS} sessions open`);
  metrics.webglAvailable = firstContexts.available;
  log(`  WebGL in this web view: ${firstContexts.available ? "yes" : "no"}`);

  // ── 3. every session answers ───────────────────────────────────────
  log("step 3: select each session and run echo in it");
  const echoMs = [];
  const switchMs = [];
  const maxHolders = { value: 0 };
  const selectSession = async (sid) => {
    const t0 = Date.now();
    await bridge.click(`.session-item[data-session-item-id="${sid}"]`);
    await bridge.waitFor(`session ${sid.slice(0, 8)} on screen`, `
      const H = window.__HERMES_E2E__;
      const info = H.terminalInfo(${JSON.stringify(sid)});
      return !!info && info.attached && (!H.graphicsContexts().available || info.webgl);
    `, { timeoutMs: 15_000, intervalMs: 20 });
    return Date.now() - t0;
  };
  const echo = async (sid, marker) => {
    await bridge.typeInTerminal(sid, `echo ${marker}`);
    // Timed from the moment Enter is pressed.
    const t0 = Date.now();
    await bridge.typeInTerminal(sid, "\n");
    await bridge.waitFor(`"${marker}" on screen`, `
      const rows = window.__HERMES_E2E__.terminalTail(${JSON.stringify(sid)}, 40) || [];
      return rows.some((r) => r.trim() === ${JSON.stringify(marker)});
    `, { timeoutMs: 20_000, intervalMs: 20 });
    return Date.now() - t0;
  };
  for (const [i, sid] of ids.entries()) {
    switchMs.push(await selectSession(sid));
    echoMs.push(await echo(sid, `f24-echo-${i}`));
    const c = await contexts();
    maxHolders.value = Math.max(maxHolders.value, c.holders.length);
    if (c.available) {
      assert(
        JSON.stringify(c.holders) === JSON.stringify(c.shown),
        `session ${i + 1}: only the terminal on screen holds a context (${c.holders.length} held, ${c.shown.length} shown)`,
      );
    }
  }
  metrics.echoMs = { p50: percentile(echoMs, 50), p95: percentile(echoMs, 95), max: Math.max(...echoMs), all: echoMs };
  metrics.switchMs = { p50: percentile(switchMs, 50), max: Math.max(...switchMs), all: switchMs };
  metrics.maxContextsHeld = maxHolders.value;
  log(`  echo: p50 ${metrics.echoMs.p50} ms, p95 ${metrics.echoMs.p95} ms, worst ${metrics.echoMs.max} ms`);
  log(`  switch: p50 ${metrics.switchMs.p50} ms, worst ${metrics.switchMs.max} ms; most contexts held at once: ${maxHolders.value}`);
  assert(echoMs.length === SESSIONS, `all ${SESSIONS} sessions answered`);
  assert(metrics.echoMs.p95 <= BUDGET.echoP95Ms, `echo p95 ${metrics.echoMs.p95} ms <= ${BUDGET.echoP95Ms} ms`);
  assert(metrics.echoMs.max <= BUDGET.echoMaxMs, `echo worst ${metrics.echoMs.max} ms <= ${BUDGET.echoMaxMs} ms`);
  assert(metrics.switchMs.max <= BUDGET.switchMs, `switch worst ${metrics.switchMs.max} ms <= ${BUDGET.switchMs} ms`);
  await bridge.screenshot(join(evidenceDir, "01-twenty-sessions.png"));

  // ── 4. memory per session ──────────────────────────────────────────
  log("step 4: what each session costs, and the memory on every row");
  const loaded = await fleet();
  const perSession = (loaded.appBytes - idle.appBytes) / SESSIONS;
  metrics.appMemoryWithSessionsMb = mb(loaded.appBytes);
  metrics.appProcessesWithSessions = loaded.appProcesses;
  metrics.appByProgramWithSessions = loaded.appByProgram;
  metrics.disownedWithSessions = loaded.disowned;
  metrics.perSessionAppMemoryMb = mb(Math.max(0, perSession));
  metrics.sessionTreesMb = loaded.sessions.map((s) => mb(s.bytes));
  log(`  Hermes with ${SESSIONS} sessions: ${describeApp(loaded)}`);
  log(`  ${metrics.perSessionAppMemoryMb} MB per session; shells: ${JSON.stringify(metrics.sessionTreesMb)}`);
  metrics.loadedTreeByKind = processTreeByKind(bridge.pid);
  log(`  the OS's view of the app's tree (sessions included): ${JSON.stringify(metrics.loadedTreeByKind)}`);
  assert(loaded.sessions.length === SESSIONS && loaded.sessions.every((s) => s.processes >= 1 && s.bytes > 0), `the backend measured all ${SESSIONS} session trees`);
  assert(metrics.perSessionAppMemoryMb <= BUDGET.perSessionAppMemoryMb, `per-session cost ${metrics.perSessionAppMemoryMb} MB <= ${BUDGET.perSessionAppMemoryMb} MB`);
  const rows = await bridge.waitFor("a memory figure on every row", `
    const rows = ${JSON.stringify(ids)}.map((id) => document.querySelector('[data-session-item-id="' + id + '"] .session-memory-tag'));
    return rows.every(Boolean) ? rows.map((r) => ({ text: r.innerText, bytes: Number(r.dataset.bytes) })) : null;
  `, { timeoutMs: 12_000 });
  assert(rows.every((r) => /^\d+(\.\d)? [MG]B$/.test(r.text)), `every row shows its memory (${rows.slice(0, 3).map((r) => r.text).join(", ")}, ...)`);

  // ── 5. an agent's memory ───────────────────────────────────────────
  log("step 5: a session running the fake agent shows the agent's memory");
  const agentSid = ids[0];
  const shellOnly = loaded.sessions.find((s) => s.sessionId === agentSid);
  await selectSession(agentSid);
  const fakeAgent = join(REPO_ROOT, "tools", "fake-agents", "fake-agent.mjs");
  await bridge.typeInTerminal(agentSid, `node "${fakeAgent}" --scenario hang\n`);
  await bridge.waitForTerminal(agentSid, /fake-agent: thinking forever/, { timeoutMs: 20_000 });
  const withAgent = await bridge.waitFor("the agent in the session's process tree", `
    const f = await window.__TAURI_INTERNALS__.invoke("fleet_memory");
    const s = f.sessions.find((x) => x.sessionId === ${JSON.stringify(agentSid)});
    return s && s.processes > ${shellOnly.processes} ? s : null;
  `, { timeoutMs: 15_000 });
  metrics.agentSessionMemoryMb = mb(withAgent.bytes);
  metrics.agentSessionProcesses = withAgent.processes;
  log(`  shell alone: ${mb(shellOnly.bytes)} MB in ${shellOnly.processes}; with the agent: ${metrics.agentSessionMemoryMb} MB in ${withAgent.processes}`);
  assert(withAgent.bytes > shellOnly.bytes, "the agent's memory is counted");
  assert(metrics.agentSessionMemoryMb <= BUDGET.agentSessionMemoryMb, `agent session ${metrics.agentSessionMemoryMb} MB <= ${BUDGET.agentSessionMemoryMb} MB`);
  // A shell's own figure moves by a few hundred KB; the agent adds tens of MB.
  const withAgentFloor = Math.round(shellOnly.bytes + (withAgent.bytes - shellOnly.bytes) / 2);
  const agentRow = await bridge.waitFor("the row to show the agent's memory", `
    const r = document.querySelector('[data-session-item-id="${agentSid}"] .session-memory-tag');
    return r && Number(r.dataset.bytes) >= ${withAgentFloor} ? { text: r.innerText, bytes: Number(r.dataset.bytes), title: r.title } : null;
  `, { timeoutMs: 12_000 });
  assert(Math.abs(agentRow.bytes - withAgent.bytes) / withAgent.bytes < 0.5, `the row shows ${agentRow.text} ("${agentRow.title}")`);
  await bridge.screenshot(join(evidenceDir, "02-agent-memory.png"));

  // ── 6. throughput ──────────────────────────────────────────────────
  log(`step 6: ${FLOOD_MB} MB printed in a visible terminal`);
  const flood = join(REPO_ROOT, "e2e", "app", "fixtures", "flood.mjs");
  const floodSid = ids[1];
  await selectSession(floodSid);
  // Long enough for the budget's floor, twice over; on a timeout the log
  // shows how far the output had got.
  const floodTimeoutMs = Math.max(60_000, (FLOOD_MB / BUDGET.ptyThroughputMbPerSec) * 1000 * 2);
  const waitForFlood = async (sid, marker, what) => {
    try {
      await bridge.waitFor(what, `
        const rows = window.__HERMES_E2E__.terminalTail(${JSON.stringify(sid)}, 6) || [];
        return rows.some((r) => r.trim().startsWith(${JSON.stringify(marker + " ")}));
      `, { timeoutMs: floodTimeoutMs, intervalMs: 50 });
    } catch (e) {
      const tail = await bridge.eval(`return window.__HERMES_E2E__.terminalTail(${JSON.stringify(sid)}, 4);`).catch(() => null);
      log(`  the terminal was still at: ${JSON.stringify(tail)}`);
      throw e;
    }
  };
  /** How the output arrived: chunks, their size, and the backend's delivery rate. */
  const delivery = async () => {
    const s = await bridge.eval(`return window.__HERMES_E2E__.outputStats(${JSON.stringify(floodSid)});`);
    if (!s || s.chunks === 0) return null;
    return {
      chunks: s.chunks,
      avgChunkBytes: Math.round(s.bytes / s.chunks),
      deliveredMb: mb(s.bytes),
      deliveryMbPerSec: s.spanMs > 0 ? Math.round((s.bytes / MB / (s.spanMs / 1000)) * 100) / 100 : null,
    };
  };
  /** Print FLOOD_MB in the flood session; seconds until its last line is on screen. */
  const timeFlood = async (marker, what) => {
    await bridge.eval(`await window.__HERMES_E2E__.watchOutput(${JSON.stringify(floodSid)}); return true;`);
    // Paced so that FLOOD_MB takes about three times as long as the floor allows.
    const pause = SLOW_FLOOD ? Math.ceil((3 * 1000 * 64) / 1024 / BUDGET.ptyThroughputMbPerSec) : 0;
    await bridge.typeInTerminal(floodSid, `node "${flood}" ${FLOOD_MB} ${marker}${pause ? ` ${pause}` : ""}\n`);
    const t0 = Date.now();
    let how = null;
    try {
      await waitForFlood(floodSid, marker, what);
    } finally {
      how = await delivery().catch(() => null);
      log(`    delivered by the backend: ${JSON.stringify(how)}`);
    }
    return { seconds: (Date.now() - t0) / 1000, delivery: how };
  };
  const { seconds: floodSeconds, delivery: floodDelivery } = await timeFlood("f24-flood-done", "the end of the flood on screen");
  metrics.floodDelivery = floodDelivery;
  metrics.floodMb = FLOOD_MB;
  metrics.ptyThroughputMbPerSec = Math.round((FLOOD_MB / floodSeconds) * 100) / 100;
  log(`  ${FLOOD_MB} MB on screen in ${floodSeconds.toFixed(2)} s: ${metrics.ptyThroughputMbPerSec} MB/s`);
  assert(metrics.ptyThroughputMbPerSec >= BUDGET.ptyThroughputMbPerSec, `throughput ${metrics.ptyThroughputMbPerSec} MB/s >= ${BUDGET.ptyThroughputMbPerSec} MB/s`);

  log("  while a hidden session floods, the visible one still answers");
  await bridge.typeInTerminal(floodSid, `node "${flood}" ${FLOOD_MB} f24-flood2-done\n`);
  const hiddenT0 = Date.now();
  const echoSid = ids[2];
  await selectSession(echoSid);
  const underLoad = await echo(echoSid, "f24-echo-under-load");
  metrics.echoUnderLoadMs = underLoad;
  log(`  echo under load: ${underLoad} ms`);
  assert(underLoad <= BUDGET.echoMaxMs, `echo under load ${underLoad} ms <= ${BUDGET.echoMaxMs} ms`);
  await waitForFlood(floodSid, "f24-flood2-done", "the hidden flood to finish");
  metrics.hiddenFloodMbPerSec = Math.round((FLOOD_MB / ((Date.now() - hiddenT0) / 1000)) * 100) / 100;
  log(`  the hidden session took its ${FLOOD_MB} MB at ${metrics.hiddenFloodMbPerSec} MB/s`);
  await checkContexts("after the flood");

  // ── 7. tile working agents ─────────────────────────────────────────
  log("step 7: tile working agents from the command palette");
  const openPalette = async () => {
    await bridge.eval(`
      document.activeElement?.blur?.();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "P", bubbles: true, cancelable: true, metaKey: ${MAC}, ctrlKey: ${!MAC}, shiftKey: true }));
      return true;
    `);
    await bridge.waitFor("the command palette", `return !!e2e.first(".command-palette");`);
  };
  const tileItem = `e2e.all(".command-palette-item").find((el) => e2e.norm(el.querySelector(".command-palette-label")?.innerText) === "Tile working agents")`;
  await openPalette();
  const offered = await bridge.eval(`return !!(${tileItem});`);
  if (FLAG === "off") {
    assert(!offered, "with the flag off the palette does not offer it");
    throw new Error("NEGATIVE CONTROL: the flag is off; the budgets above should already have failed");
  }
  assert(offered, 'the palette offers "Tile working agents"');
  const layoutBefore = await bridge.eval(`return e2e.all(".terminal-viewport").length;`);
  await bridge.clickWhenReady(`return e2e.click(e2e.must(${tileItem}, "Tile working agents"));`);
  const toast = await bridge.waitFor("the nobody-is-working notice", `
    const t = e2e.all(".toast-message").map((e) => e2e.norm(e.innerText)).find((m) => m === "No agents are working right now");
    return t || null;
  `, { timeoutMs: 5_000 });
  assert(!!toast, `with nobody working it says "${toast}"`);
  assert((await bridge.eval(`return e2e.all(".terminal-viewport").length;`)) === layoutBefore, "and the layout is unchanged");

  const working = [3, 6, 9, 12, 15].map((i) => ids[i % ids.length]);
  await bridge.eval(`
    const H = window.__HERMES_E2E__;
    const ids = ${JSON.stringify(working)};
    ids.forEach((id, i) => H.injectSessionEvent(id, {
      type: "status", at: Date.now(), source: "e2e",
      status: { kind: i === 4 ? "needs_approval" : "working", confidence: "exact", detail: "" },
    }));
    return true;
  `);
  log(`  reported working: sessions 4, 7, 10, 13 and 16 (the last one waiting for an approval)`);
  await openPalette();
  await bridge.clickWhenReady(`return e2e.click(e2e.must(${tileItem}, "Tile working agents"));`);
  const tiled = await bridge.waitFor("five panes on screen", `
    const H = window.__HERMES_E2E__;
    const shown = H.terminalIds().filter((id) => H.terminalInfo(id)?.attached);
    const viewports = e2e.all(".terminal-viewport").map((v) => v.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }));
    return shown.length === 5 ? { shown: shown.sort(), viewports } : null;
  `, { timeoutMs: 10_000 });
  assert(JSON.stringify(tiled.shown) === JSON.stringify([...working].sort()), "exactly the five working sessions are on screen");
  const rowsY = [...new Set(tiled.viewports.map((v) => v.y))];
  assert(rowsY.length === 2 && tiled.viewports.every((v) => v.w > 100 && v.h > 50), `laid out as a grid of two rows (${JSON.stringify(tiled.viewports)})`);
  await sleep(500);
  await checkContexts("tiled");
  await bridge.screenshot(join(evidenceDir, "03-tiled-working-agents.png"));
  saveMetrics();
});
