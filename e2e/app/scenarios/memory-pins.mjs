#!/usr/bin/env node
// Scenario memory-pins (README claim "memory-pins"): on the REAL app, a
// memory fact and a pinned file saved for a project in one session carry
// over to the next session on that project, and to its agent: they are in
// the new session's Context panel and in the context file its agent is
// told to read — also after the app is restarted.
//
// A throwaway project folder with docs/decisions.md. Claude Code sessions
// run a stand-in CLI that records how it was started.
//   1. Session A on the project: in its Context panel, "Add memory fact"
//      saves deploy_target = staging-eu for the project (listed), and "Add
//      pin" pins docs/decisions.md for the project: the panel lists it at
//      once, as a project pin.
//   2. Session B on the same project: its Context panel lists the fact and
//      the project's pin; its agent's first prompt points at a context file
//      holding the fact under "## Memory" and the pinned file (with its
//      text) under "## Pinned Context".
//   3. The app is quit and started again on the same data; session C on the
//      project gets the same fact and pin in its context file.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_PINS_NEGATIVE=session-only saves the pin for session A only
//   ("Session only" scope): session B does not get it.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/memory-pins.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { startApp } from "../qa-host-steps.mjs";
import { completeClassicOnboarding } from "../launcher-steps.mjs";
import { menuAction } from "../fleet-steps.mjs";

const SCENARIO = "memory-pins";
const SESSION_ONLY = process.env.HERMES_E2E_PINS_NEGATIVE === "session-only";
const KEY = "deploy_target";
const VALUE = "staging-eu";
const DECISION = "We ship on Tuesdays only (decision 7).";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}${SESSION_ONLY ? "   pin saved for SESSION A ONLY (negative control)" : ""}`);
  const started = await startApp("mem-pins", evidenceDir, log, onCleanup, apps);
  const { fx } = started;
  let bridge = started.bridge;

  const project = join(fx.work, "notes-app");
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# notes-app\n");
  const pinned = join(project, "docs", "decisions.md");
  writeFileSync(pinned, `# Decisions\n\n${DECISION}\n`);
  log(`  project folder: ${project}`);

  /** A Claude Code session on the project; returns its id and the context file its agent was pointed at. */
  async function claudeSession(label) {
    const sid = await bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId: "claude", cwd: project, label })});`, { timeoutMs: 30_000 });
    const deadline = Date.now() + 60_000;
    let rec = null;
    while (!rec && Date.now() < deadline) {
      rec = fx.records().find((r) => r.argv.some((a) => a.includes(`${sid}.md`)));
      if (!rec) await sleep(200);
    }
    const prompt = rec ? rec.argv[rec.argv.length - 1] : "(no launch record names this session's context file)";
    const ctx = /Read the file at (.+?\.md) for project context/.exec(prompt)?.[1] ?? null;
    log(`  ${label}: session ${sid}; first prompt: ${JSON.stringify(prompt)}`);
    return { sid, ctx };
  }

  async function openContextPanelOf(sid) {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(document.querySelector('.session-item[data-session-item-id="${sid}"]'), "the session row"));`);
    await sleep(300);
    if (!(await bridge.exists(".context-panel-body"))) await menuAction(bridge, "view.context-panel");
    await bridge.waitFor("the Context panel", `return !!e2e.first(".context-panel-body");`, { timeoutMs: 10_000 });
  }

  const panelState = () => bridge.eval(`
    return {
      memory: e2e.all(".ctx-memory-row").map((r) => ({ key: e2e.norm(r.querySelector(".ctx-memory-key")?.innerText ?? ""), value: e2e.norm(r.querySelector(".ctx-memory-value")?.innerText ?? ""), scope: e2e.norm(r.querySelector(".ctx-pin-scope-badge")?.innerText ?? "") })),
      pins: e2e.all(".ctx-pin-row").map((r) => ({ kind: e2e.norm(r.querySelector(".ctx-pin-badge")?.innerText ?? ""), target: e2e.norm(r.querySelector(".ctx-pin-target")?.innerText ?? ""), scope: e2e.norm(r.querySelector(".ctx-pin-scope-badge")?.innerText ?? "") })),
    };
  `);

  const setField = (findJs, value) => bridge.eval(`
    const input = e2e.must(${findJs}, "field");
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    return input.value;
  `);

  const hasFact = (s) => s.memory.some((m) => m.key === KEY && m.value === VALUE && m.scope.toLowerCase() === "project");

  // ── 1. Session A: save a fact and pin a file for the project ───────
  log("step 1: session A saves a memory fact and pins a file for the project");
  const a = await claudeSession("session A");
  await openContextPanelOf(a.sid);
  await bridge.click('.ctx-header-action-btn[title="Add memory fact"]');
  await bridge.waitFor("the memory form", `return !!e2e.first('.ctx-memory-input[placeholder="Value"]');`);
  await setField(`e2e.first('.ctx-memory-input[placeholder^="Key"]')`, KEY);
  await setField(`e2e.first('.ctx-memory-input[placeholder="Value"]')`, VALUE);
  await setField(`e2e.first('select[aria-label="Memory scope"]')`, "project");
  await bridge.click(".ctx-memory-save-btn");
  await bridge.waitFor("the fact in the panel", `return e2e.all(".ctx-memory-row").some((r) => e2e.norm(r.querySelector(".ctx-memory-key")?.innerText ?? "") === ${JSON.stringify(KEY)});`, { timeoutMs: 10_000 });

  await bridge.click('.ctx-header-action-btn[title="Add pin"]');
  await bridge.waitFor("the pin form", `return !!e2e.first('select[aria-label="Pin kind"]');`);
  await setField(`e2e.first('select[aria-label="Pin kind"]')`, "file");
  await setField(`e2e.first('select[aria-label="Pin scope"]')`, SESSION_ONLY ? "session" : "project");
  await setField(`e2e.first('.ctx-memory-input[placeholder="File path"]')`, pinned);
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".ctx-memory-save-btn").find((b) => e2e.norm(b.innerText) === "Pin"), "Pin"));`);
  await bridge.waitFor("the pin form to close (the pin is saved)", `return !e2e.first('select[aria-label="Pin kind"]');`, { timeoutMs: 10_000 });
  const projectId = (await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_session_projects", { sessionId: ${JSON.stringify(a.sid)} });`))[0]?.id;
  const savedPins = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_context_pins", { sessionId: ${JSON.stringify(a.sid)}, projectId: ${JSON.stringify(projectId)} });`);
  log(`  pins saved for the project: ${JSON.stringify(savedPins.map((p) => ({ kind: p.kind, target: p.target, session: p.session_id, project: p.project_id })))}`);
  const inA = await panelState();
  log(`  session A's panel: ${JSON.stringify(inA)}`);
  assert(hasFact(inA), `session A lists the fact ${KEY} = ${VALUE} (project)`);
  assert(savedPins.some((p) => p.kind === "file" && p.target === pinned && (SESSION_ONLY ? p.session_id === a.sid : p.session_id === null)), "the pinned file is saved");
  const listsPin = (state) => state.pins.some((p) => p.target.includes("decisions.md") && /project/i.test(p.scope));
  const pinListed = await bridge
    .waitFor("the pin in session A's panel", `return e2e.all(".ctx-pin-row").some((r) => (r.querySelector(".ctx-pin-target")?.innerText ?? "").includes("decisions.md"));`, { timeoutMs: 10_000 })
    .then(() => true, () => false);
  assert(pinListed && listsPin(await panelState()), "session A's Context panel lists the pin at once, as a project pin");
  await bridge.screenshot(join(evidenceDir, "01-session-a.png"));

  /** The context file of a session: the fact under Memory, the file (with its text) under Pinned Context. */
  function checkContextFile(ctx, who) {
    assert(!!ctx && existsSync(ctx), `${who}'s agent is pointed at a context file (${ctx})`);
    const body = readFileSync(ctx, "utf8");
    log(`  ${who}'s context file:\n${body}`);
    const memory = /## Memory\n\n([\s\S]*?)(\n## |$)/.exec(body)?.[1] ?? "";
    const pins = /## Pinned Context\n\n([\s\S]*?)(\n## |$)/.exec(body)?.[1] ?? "";
    assert(memory.includes(`- ${KEY} = ${VALUE}`), `${who}'s context file has the fact under "## Memory"`);
    assert(pins.includes(`- [file] ${pinned} (project)`) && pins.includes(DECISION), `${who}'s context file has the pinned file, with its text, under "## Pinned Context"`);
  }

  // ── 2. Session B on the same project ───────────────────────────────
  log("step 2: session B on the same project gets the fact and the pin");
  const b = await claudeSession("session B");
  await openContextPanelOf(b.sid);
  await bridge.waitFor("session B's panel to load its facts", `return e2e.all(".ctx-memory-row").length > 0;`, { timeoutMs: 10_000 });
  const inB = await panelState();
  log(`  session B's panel: ${JSON.stringify(inB)}`);
  assert(hasFact(inB), "session B's Context panel lists the fact");
  assert(listsPin(inB), "and the project's pin");
  await bridge.screenshot(join(evidenceDir, "02-session-b.png"));
  checkContextFile(b.ctx, "session B");

  // ── 3. After a restart ─────────────────────────────────────────────
  log("step 3: quit, start again on the same data, open session C on the project");
  const first = apps[0];
  await first.stop();
  const app2 = await fx.launch(evidenceDir, 2);
  apps.push(app2);
  bridge = app2.bridge;
  await bridge.waitFor("the app UI", `return !!document.getElementById("root")?.firstElementChild && !!window.__HERMES_E2E__;`, { timeoutMs: 30_000 });
  if (await bridge.exists(".onboarding-dialog")) await completeClassicOnboarding(bridge);
  const c = await claudeSession("session C");
  checkContextFile(c.ctx, "session C (after a restart)");
});
