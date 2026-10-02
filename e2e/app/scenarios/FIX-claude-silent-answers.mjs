#!/usr/bin/env node
// FIX-claude-silent-answers — the moments Claude Code reports nothing for,
// with a fake Claude Code that behaves like 2.1.287 (tools/fake-agents,
// key `P` and the mode word `model-not-found-hooks`).
//
//   1. Approve a long command: Claude's next hook comes only when the
//      command has finished. EXPECT: once the person answers (`y`), the
//      strip, the attention badge and the dock leave "needs approval"; the
//      strip says working (the OS layer sees the command) while it runs.
//   2. Reject with Esc: Claude prints "Interrupted · What should Claude do
//      instead?" and fires no hook; its transcript records the rejection.
//      EXPECT: the session goes idle (exact, reported by Claude Code), the
//      counts drop, the turn ends as interrupted, and the next prompt is
//      the next turn (three prompts, three turns).
//   3. Quit with the agent waiting for approval. EXPECT: the quit question
//      says the agent waits for you, not that it is still working.
//   4. An unknown model: Claude fires its prompt hook, then StopFailure
//      model_not_found, then shows the refusal. EXPECT: the refusal banner,
//      and no turn started or ended.
//
// Was broken: 1 and 3 kept "needs approval" / "still working" for the whole
// command, 2 kept "needs approval" until the next prompt and merged the
// interrupted turn into it, 4 recorded a turn for a launch that ran nothing.

import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { block, sleep, startAgent, startApp, writeTo } from "../qa-status-steps.mjs";
import { quitAndReadQuestion } from "../qa-host-steps.mjs";

const TOOL_MS = 8000;

await runScenario("FIX-claude-silent-answers", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, app, bridge } = await startApp("fix-silent", evidenceDir, log, onCleanup, apps, { env: { HERMES_FAKE_TOOL_MS: String(TOOL_MS) } });
  fx.setFake("mode", "model-not-found-hooks");
  fx.setFake("reject-models-claude", "not-a-model");

  const A = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: long command" }, 1);
  // A command the agent runs must start well after its own startup.
  await sleep(3500);
  const status = () => bridge.eval(`return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(A)});`);
  const strip = () =>
    bridge.eval(`
      const el = e2e.first('.session-status-strip[data-strip-session="${A}"]');
      return el ? { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, text: e2e.norm(el.innerText) } : null;`);
  const counts = () =>
    bridge.eval(`
      const b = e2e.first(".attention-badge");
      const dock = (await window.__TAURI_INTERNALS__.invoke("attention_state_for_test")).badge;
      return { badge: b ? Number(b.dataset.count) : 0, dock: dock.count };`);
  const events = () => bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(A)});`);
  const waitKind = (label, pred, timeoutMs = 15_000) =>
    bridge.waitFor(label, `const s = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(A)}); return (${pred})(s) ? s : null;`, { timeoutMs });

  // ─── 1. approve a long command ──────────────────────────────────────
  log("step 1: approve a long command");
  await writeTo(bridge, A, "w");
  await waitKind("the first turn", `(s) => s.kind === "working"`);
  await writeTo(bridge, A, "P");
  await waitKind("needs approval", `(s) => s.kind === "needs_approval" && s.confidence === "exact"`);
  await sleep(600);
  const asked = await counts();
  log(`  asked: ${JSON.stringify(await strip())}; counts ${JSON.stringify(asked)}`);
  assert(asked.badge === 1 && asked.dock === 1, `the ask is counted (${JSON.stringify(asked)})`);
  const answeredAt = Date.now();
  await writeTo(bridge, A, "y");
  const working = await bridge.waitFor(
    "the strip to say working while the command runs",
    `const el = e2e.first('.session-status-strip[data-strip-session="${A}"]'); return el && el.dataset.statusKind === "working" ? { kind: el.dataset.statusKind, source: el.dataset.source, text: e2e.norm(el.innerText) } : null;`,
    { timeoutMs: 5000 },
  );
  const after = await counts();
  log(`  ${Date.now() - answeredAt} ms after the answer: strip ${JSON.stringify(working)}; status ${JSON.stringify(await status())}; counts ${JSON.stringify(after)}`);
  await bridge.screenshot(join(evidenceDir, "01-approved-command-running.png"));
  assert(Date.now() - answeredAt < TOOL_MS - 2000, "the strip said working while the command still ran");
  assert(working.source === "os", `working, as the OS layer sees the command (${working.source})`);
  assert(after.badge === 0 && after.dock === 0, `the badge and the dock no longer count it (${JSON.stringify(after)})`);
  const done = await waitKind("the command's own report", `(s) => s.kind === "working" && s.confidence === "exact"`, TOOL_MS + 10_000);
  log(`  after the command: ${JSON.stringify(done)}`);
  await writeTo(bridge, A, "s");
  await waitKind("turn 1 done", `(s) => s.kind === "done_unread" || s.kind === "idle"`);

  // ─── 2. reject with Esc ─────────────────────────────────────────────
  log("step 2: reject with Esc");
  await writeTo(bridge, A, "w");
  await waitKind("the second turn", `(s) => s.kind === "working"`);
  await writeTo(bridge, A, "P");
  await waitKind("needs approval again", `(s) => s.kind === "needs_approval" && s.confidence === "exact"`);
  await sleep(600);
  await writeTo(bridge, A, "\x1b");
  const interrupted = await bridge.waitFor(
    "the interrupted turn",
    `const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(A)}); return s.events.find((e) => e.type === "turn_interrupted") ?? null;`,
    { timeoutMs: 10_000 },
  );
  await sleep(500);
  const rejected = { strip: await strip(), status: await status(), counts: await counts() };
  log(`  after Esc: ${JSON.stringify(interrupted)}; ${JSON.stringify(rejected)}`);
  await bridge.screenshot(join(evidenceDir, "02-rejected.png"));
  assert(interrupted.source === "transcript:claude" && interrupted.n === 2, `turn 2 ended as interrupted, from Claude's transcript (${JSON.stringify(interrupted)})`);
  assert(rejected.strip.kind === "idle" && rejected.strip.confidence === "exact" && /reported by Claude Code/.test(rejected.strip.text), `the strip says idle, exact, reported by Claude Code (${rejected.strip.text})`);
  assert(rejected.counts.badge === 0 && rejected.counts.dock === 0, `the counts dropped (${JSON.stringify(rejected.counts)})`);
  await writeTo(bridge, A, "w");
  await waitKind("the third turn", `(s) => s.kind === "working"`);
  const snap = await events();
  const starts = snap.events.filter((e) => e.type === "turn_start").map((e) => e.n);
  log(`  turn starts ${JSON.stringify(starts)}; turn ${JSON.stringify(snap.turn)}`);
  assert(JSON.stringify(starts) === "[1,2,3]" && snap.turn.current === 3 && snap.turn.completed === 2, "three prompts are three turns");

  // ─── 3. the quit question says what the agent does ──────────────────
  log("step 3: quit while the agent waits for approval");
  await writeTo(bridge, A, "s");
  await waitKind("turn 3 done", `(s) => s.kind === "done_unread" || s.kind === "idle"`);
  await block(bridge, A);

  // ─── 4. an unknown model ────────────────────────────────────────────
  log("step 4: an unknown model runs no turn");
  const B = await bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId: "claude", cwd: fx.otherRepo, label: "unknown model", task: "Reply with ok", modelId: "not-a-model" })});`, { timeoutMs: 30_000 });
  const banner = await bridge.waitFor(
    "the refusal banner",
    `const el = e2e.first('.launch-rejected[data-session-id="${B}"]'); return el ? e2e.norm(el.innerText) : null;`,
    { timeoutMs: 30_000 },
  );
  await sleep(3000);
  const bSnap = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(B)});`);
  const rec = fx.records().find((r) => r.env?.HERMES_SESSION_ID === B);
  const hooks = (rec?.hooksRan ?? []).map((h) => h.event);
  log(`  banner: ${banner}`);
  log(`  the fake ran ${JSON.stringify(hooks)}; events ${JSON.stringify(bSnap.events.map((e) => e.type + (e.status ? `:${e.status.kind}` : "")))}`);
  await bridge.screenshot(join(evidenceDir, "03-unknown-model.png"));
  assert(hooks.includes("UserPromptSubmit") && hooks.includes("StopFailure"), "the fake fired the prompt hook and StopFailure model_not_found, as Claude Code 2.1.287 does");
  assert(/Nothing ran/.test(banner), "the banner says nothing ran");
  assert(!bSnap.events.some((e) => e.type === "turn_start" || e.type === "turn_end" || e.type === "turn_failed"), "no turn started or ended");

  const question = await quitAndReadQuestion(app);
  log(`  quit question: ${question}`);
  assert(!!question, "quitting asks first");
  await bridge.screenshot(join(evidenceDir, "04-quit-question.png"));
  assert(/1 agent is waiting for you\./.test(question), "it says the agent waits for you");
  assert(!/still working|is working/.test(question), "not that it is still working");
  await bridge.click('[data-testid="quit-with-agents-dialog"] .quit-dialog-btn-stop');
  await app.stop({ stopPrograms: false });
});
