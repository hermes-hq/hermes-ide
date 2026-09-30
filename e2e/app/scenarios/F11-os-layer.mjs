#!/usr/bin/env node
// Scenario F11-os-layer: the OS layer of agent status (facts from the
// process table) and the rule that a guess never overrides an exact report.
//
// Fake agents (tools/fake-agents/fake-cli.mjs) stand in for the real CLIs,
// started by the bundled helper (`hi run`) like the real ones:
//
//   A  a fake `claude` with its per-launch hooks. It reports its start and a
//      finished turn exactly; then it runs a command (a shell child, no
//      hook) and keeps a core busy (no hook). The OS layer sees both — its
//      "working" events reach the session's store — and the strip and the
//      sidebar keep "done · exact · reported by Claude Code" throughout.
//   B  a fake `codex` that runs none of the hooks Hermes passes it (an agent
//      that reports nothing). It stops being "starting" once its process is
//      up and quiet ("idle · guessed"); a command it runs shows as
//      "working · guessed · process activity" within two seconds, and the
//      strip leaves "working" once the command ended; CPU use shows the same
//      way. Nothing is ever marked exact.
//   C  a fake Antigravity (its hooks from the .agents/hooks.json Hermes
//      writes into a Hermes worktree) announces a tool call and waits for
//      approval without saying so. The strip shows "needs approval ·
//      guessed" within 3.5 s, and nothing is raised in the attention inbox
//      or notified (a guess never says the person is blocked). Once the
//      person approves and the command starts, the OS layer takes the guess
//      back within two seconds ("working · guessed"); the tool's own report
//      follows when the command ends.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_OSL_NO_SHELL=1   the fakes run their "command" without a
//                               shell (HERMES_FAKE_TOOL_SHELL=0), so there
//                               is no command for the OS layer to see: A
//                               fails ("the OS layer never reported a
//                               command under Claude").
//   HERMES_E2E_OSL_AGY_ONLY=1 with HERMES_E2E_OSL_NO_SHELL=1
//                               runs part C alone without a shell: the
//                               approval is never taken back and C fails.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F11-os-layer.mjs

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";

const SCENARIO = "F11-os-layer";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const NO_SHELL = process.env.HERMES_E2E_OSL_NO_SHELL === "1";
const AGY_ONLY = process.env.HERMES_E2E_OSL_AGY_ONLY === "1";
const TOOL_MS = 4000;

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── Fake `claude` and `codex` on PATH ───────────────────────────────

const work = mkdtempSync(join(tmpdir(), "hermes-e2e-osl-"));
const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
const privateHome = join(work, "home");
// A folder Hermes counts as one of its worktrees (the only kind it writes
// Antigravity's hook file into), a git repository of its own.
const agyRepo = join(work, "hermes-worktrees", "osl", "s1_agy");
for (const d of [fakeBin, recordDir, privateHome, agyRepo]) mkdirSync(d, { recursive: true });
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
const FAKES = { claude: "claude", codex: "codex", agy: "antigravity" };
for (const [name, agent] of Object.entries(FAKES)) {
  if (onWindows) {
    writeFileSync(join(fakeBin, `${name}.cmd`), `@set HERMES_FAKE_AGENT=${agent}\r\n@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
  } else {
    writeFileSync(join(fakeBin, name), `#!/bin/sh\nHERMES_FAKE_AGENT=${agent} exec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
    chmodSync(join(fakeBin, name), 0o755);
  }
}
const hasReal = (dir) => Object.keys(FAKES).some((n) => [n, `${n}.exe`, `${n}.cmd`].some((f) => existsSync(join(dir, f))));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasReal(d))].join(delimiter);
for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_") || name.startsWith("OPENAI_") || name === "CODEX_HOME") delete process.env[name];

const canEditRegistryPath = onWindows && process.env.GITHUB_ACTIONS === "true";
function addFakeBinToRegistryPath() {
  if (!canEditRegistryPath) return null;
  let old = null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    const m = out.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
    old = m ? m[1].trim() : "";
  } catch {
    old = null;
  }
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old ? `${old};${fakeBin}` : fakeBin, "/f"]);
  log("  (CI runner: added the fake agents' folder to the user's registry Path)");
  return () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
  };
}
if (onWindows && !canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

// ─── UI steps ────────────────────────────────────────────────────────

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}
async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (let i = 0; i < 3; i++) {
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return true;
  `);
  await bridge.waitFor("the Finish button to become enabled", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  await dismissWhatsNew(bridge);
}

/** New Session wizard: an agent in a terminal, default folder. */
async function createSession(bridge, agent) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  if (await bridge.exists('.session-creator-mode-card[data-category="universal"]')) {
    await bridge.click('.session-creator-mode-card[data-category="universal"]');
    await sleep(200);
    if (await bridge.exists(".session-creator-mode-step")) await bridge.click(".session-creator-actions .session-creator-btn-primary");
  }
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith(${JSON.stringify(agent)}));
    return e2e.click(e2e.must(card, "the agent card"));
  `);
  await bridge.eval(`
    const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
    if (box && box.checked) e2e.click(box);
    return true;
  `);
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"), "the wizard's primary button"));
    `);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  return bridge.waitFor("a terminal to appear", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
}

const stripOf = (bridge, sid) =>
  bridge.eval(`
    const el = e2e.first('.session-status-strip[data-strip-session="${sid}"]');
    if (!el) return null;
    const tag = e2e.first('.session-item[data-session-item-id="${sid}"] .agent-status-tag');
    return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source,
      sourceText: e2e.norm(el.querySelector(".session-status-strip-source")?.innerText ?? ""),
      detail: e2e.norm(el.querySelector(".session-status-strip-detail")?.innerText ?? ""),
      tag: tag ? { status: tag.dataset.status, confidence: tag.dataset.confidence, source: tag.dataset.source } : null };
  `);
async function waitForStrip(bridge, sid, label, pred, { timeoutMs = 10_000 } = {}) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await stripOf(bridge, sid);
    if (last && pred(last)) return { strip: last, ms: Date.now() - t0 };
    await sleep(50);
  }
  throw new Error(`the strip never showed ${label} within ${timeoutMs} ms (last: ${JSON.stringify(last)})`);
}
/** The OS layer's events in the session's store since `after`. */
const osEvents = (bridge, sid, after) =>
  bridge.eval(`
    return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(sid)}).events
      .filter((e) => e.source === "os" && e.at >= ${after})
      .map((e) => ({ at: e.at, kind: e.status?.kind, confidence: e.status?.confidence, detail: e.status?.detail }));
  `);
async function waitForOsEvent(bridge, sid, after, pred, label, { timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    seen = await osEvents(bridge, sid, after);
    const hit = seen.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`the OS layer never reported ${label} within ${timeoutMs} ms (saw: ${JSON.stringify(seen)})`);
}

/** The session's inbox items and what the attention center notified. */
const attention = (bridge, sid) =>
  bridge.eval(`
    const items = window.__HERMES_E2E__.inboxItems().filter((i) => i.sessionId === ${JSON.stringify(sid)}).map((i) => ({ kind: i.kind, detail: i.detail }));
    const st = window.__HERMES_E2E__.attentionState();
    return { items, decisions: st.decisions.length, os: st.os.length, away: st.away.length };
  `);

/**
 * An agent session in `folder` (one the wizard does not offer: a Hermes
 * worktree it did not make), in a terminal, started through the launch
 * helper — created the way New Session does: the terminal first, then the
 * backend session under the same id.
 */
async function createSessionIn(bridge, agent, folder, label) {
  const id = randomUUID();
  const sid = await bridge.eval(`
    await window.__HERMES_E2E__.prepareTerminal(${JSON.stringify(id)});
    const s = await window.__TAURI_INTERNALS__.invoke("create_session", {
      sessionId: ${JSON.stringify(id)}, label: ${JSON.stringify(label)}, workingDirectory: ${JSON.stringify(folder)}, color: null,
      workspacePaths: null, aiProvider: ${JSON.stringify(agent)}, projectIds: null, launchHelper: true, mode: "terminal",
      initialRows: 30, initialCols: 120,
    });
    return s.id;
  `);
  await bridge.waitFor(`the ${label} session in the list`, `return !!e2e.first('.session-item[data-session-item-id="${sid}"]');`, { timeoutMs: 20_000 });
  await bridge.click(`.session-item[data-session-item-id="${sid}"]`);
  return sid;
}

let app;
let failed = false;
let undoRegistryPath = null;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   fake agents: ${fakeBin}   negative control (no shell): ${NO_SHELL}   part C only: ${AGY_ONLY}`);
  undoRegistryPath = addFakeBinToRegistryPath();
  const env = { HERMES_FAKE_DIR: recordDir, HERMES_FAKE_TOOL_MS: String(TOOL_MS), ...(NO_SHELL ? { HERMES_FAKE_TOOL_SHELL: "0" } : {}) };
  app = await launchApp(
    onWindows
      ? { runDir: join(evidenceDir, "run-1"), log, env, home: "real", resetData: true }
      : { runDir: join(evidenceDir, "run-1"), log, env, home: "private", homeDir: privateHome },
  );
  const { bridge } = app;
  await completeOnboarding(bridge);
  // Away (not looking at the window): a blocked item would notify.
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(false); return true;`);

  if (!AGY_ONLY) {
    // ── A: exact reports hold whatever the processes do ───────────────
    log("A: a fake Claude that reports exactly; its command and CPU use must not change what the strip says");
    const a = await createSession(bridge, "Claude");
    await bridge.waitForTerminal(a, /fake-cli: ready/, { timeoutMs: 30_000 });
    await waitForStrip(bridge, a, "idle, exact", (s) => s.kind === "idle" && s.confidence === "exact");
    // A shell in an agent's first seconds belongs to its startup (an MCP
    // server started through one), not to a command: a real agent needs a
    // model call before its first command, so the fake waits as long.
    await sleep(3_000);
    await bridge.typeInTerminal(a, "w");
    await waitForStrip(bridge, a, "working, exact", (s) => s.kind === "working" && s.confidence === "exact");
    await bridge.typeInTerminal(a, "s");
    const { strip: done } = await waitForStrip(bridge, a, "done, exact", (s) => s.kind === "done_unread" && s.confidence === "exact");
    assert(done.sourceText === "exact · reported by Claude Code", `the turn's end: "${done.sourceText}"`);
    const tA = Date.now();
    await bridge.typeInTerminal(a, "z");
    const osA = await waitForOsEvent(bridge, a, tA, (e) => e.kind === "working" && /command/.test(e.detail ?? ""), "a command under Claude");
    log(`  the OS layer saw it: ${osA.kind} (${osA.confidence}) "${osA.detail}"`);
    assert(osA.confidence === "guessed", "a process fact is a guess");
    // While the command runs, and after: the strip and the sidebar keep the agent's word.
    const samples = [];
    const until = Date.now() + TOOL_MS;
    while (Date.now() < until) {
      samples.push(await stripOf(bridge, a));
      await sleep(250);
    }
    const moved = samples.filter((s) => s.kind !== "done_unread" || s.confidence !== "exact" || s.source !== "hook");
    assert(moved.length === 0, `the strip kept "done · exact" in all ${samples.length} looks while the command ran (moved: ${JSON.stringify(moved.slice(0, 2))})`);
    const tags = samples.map((s) => s.tag).filter(Boolean);
    assert(tags.length > 0 && tags.every((t) => t.confidence === "exact" && t.source === "hook:claude"), `the sidebar kept the agent's exact status (${JSON.stringify(tags.at(-1))})`);
    await bridge.screenshot(join(evidenceDir, "01-exact-holds-over-a-command.png"));
    const tA2 = Date.now();
    await bridge.typeInTerminal(a, "b");
    const osA2 = await waitForOsEvent(bridge, a, tA2, (e) => e.kind === "working" && /CPU/.test(e.detail ?? ""), "CPU use under Claude");
    log(`  the OS layer saw the CPU: "${osA2.detail}"`);
    const busy = await stripOf(bridge, a);
    assert(busy.kind === "done_unread" && busy.confidence === "exact", `the strip still says "${busy.kind} · ${busy.sourceText}" while the agent spins`);

    // ── B: an agent that reports nothing ──────────────────────────────
    log("B: a fake Codex that runs no hook: the OS layer is all Hermes knows");
    const b = await createSession(bridge, "Codex");
    await bridge.waitForTerminal(b, /fake-cli: ready/, { timeoutMs: 30_000 });
    const { strip: settled, ms: settledMs } = await waitForStrip(bridge, b, "idle, guessed (up and quiet)", (s) => s.kind === "idle" && s.confidence === "guessed", { timeoutMs: 15_000 });
    log(`  up and quiet: "${settled.kind} · ${settled.sourceText}" after ${settledMs} ms`);
    const tB = Date.now();
    await bridge.typeInTerminal(b, "z");
    const { strip: working, ms: workingMs } = await waitForStrip(bridge, b, "working from the process table", (s) => s.kind === "working" && s.source === "os", { timeoutMs: 3_000 });
    assert(working.confidence === "guessed" && working.sourceText === "guessed · process activity", `a command it runs shows "${working.kind} · ${working.sourceText}" (${working.detail}) after ${workingMs} ms`);
    assert(workingMs <= 2000, `within two seconds of the command starting (${workingMs} ms, key press included)`);
    await bridge.screenshot(join(evidenceDir, "02-working-from-the-process-table.png"));
    const { strip: after, ms: afterMs } = await waitForStrip(bridge, b, "no longer working", (s) => s.kind !== "working", { timeoutMs: TOOL_MS + 5_000 });
    assert(after.confidence !== "exact", `once the command ended the strip leaves working ("${after.kind} · ${after.sourceText}", ${afterMs + workingMs} ms after the key)`);
    await bridge.typeInTerminal(b, "b");
    const { strip: cpu } = await waitForStrip(bridge, b, "working from CPU use", (s) => s.kind === "working" && s.source === "os", { timeoutMs: 4_000 });
    assert(/CPU/.test(cpu.detail), `CPU use shows as working too ("${cpu.detail}")`);
    const all = await osEvents(bridge, b, tB);
    assert(all.every((e) => e.confidence === "guessed"), `every OS-layer report is a guess (${all.length} reports)`);
    await bridge.screenshot(join(evidenceDir, "03-working-from-cpu.png"));
  }

  // ── C: Antigravity's approval, which it never reports ─────────────
  log("C: a fake Antigravity announces a tool call and waits for approval without saying so");
  execFileSync("git", ["init", "-q", agyRepo]);
  const c = await createSessionIn(bridge, "antigravity", agyRepo, "OSL agy");
  await bridge.waitForTerminal(c, /fake-cli: ready/, { timeoutMs: 30_000 });
  const hooksFile = join(agyRepo, ".agents", "hooks.json");
  assert(existsSync(hooksFile) && JSON.parse(readFileSync(hooksFile, "utf8"))["hermes-signal"]?.enabled === true, "Hermes wrote its hook entry into the worktree's .agents/hooks.json");
  await waitForStrip(bridge, c, "idle, guessed (up and quiet)", (s) => s.kind === "idle", { timeoutMs: 15_000 });
  const before = await attention(bridge, c);
  const tC = Date.now();
  await bridge.typeInTerminal(c, "a");
  const { strip: guess, ms: guessMs } = await waitForStrip(bridge, c, "needs approval, guessed", (s) => s.kind === "needs_approval", { timeoutMs: 5_000 });
  assert(guess.confidence === "guessed" && guess.sourceText === "guessed", `the wait shows as "${guess.kind} · ${guess.sourceText}" (${guess.detail}) after ${guessMs} ms`);
  assert(guessMs <= 3500, `within 3.5 s of the tool call (${guessMs} ms)`);
  assert(guess.tag?.status === "needs_approval" && guess.tag?.confidence === "guessed", `the sidebar shows the same guess (${JSON.stringify(guess.tag)})`);
  await bridge.screenshot(join(evidenceDir, "04-guessed-approval.png"));
  // Held for a while: the inbox and the notifications stay out of it.
  const heldUntil = Date.now() + 2_000;
  while (Date.now() < heldUntil) {
    const now = await attention(bridge, c);
    assert(now.items.every((i) => i.kind !== "blocked"), `no "blocked on you" item for a guess (${JSON.stringify(now.items)})`);
    await sleep(400);
  }
  const held = await attention(bridge, c);
  assert(held.os === before.os && held.away === before.away, `nothing was notified for the guess (OS notifications ${before.os} -> ${held.os}, away ${before.away} -> ${held.away})`);
  // The person approves; the command starts; the guess is taken back.
  const tApprove = Date.now();
  await bridge.typeInTerminal(c, "y");
  const { strip: back, ms: backMs } = await waitForStrip(bridge, c, "working again after the approval", (s) => s.kind === "working", { timeoutMs: 3_000 });
  assert(back.confidence === "guessed" && /command/.test(back.detail), `the approval is taken back: "${back.kind} · ${back.sourceText}" (${back.detail}) ${backMs} ms after the key`);
  assert(backMs <= 2000, `within two seconds of the approval (${backMs} ms, key press included)`);
  assert(back.tag?.status === "working", `the sidebar left the guess too (${JSON.stringify(back.tag)})`);
  await bridge.screenshot(join(evidenceDir, "05-approval-taken-back.png"));
  const { strip: reported } = await waitForStrip(bridge, c, "the tool's own report once the command ended", (s) => s.kind === "working" && s.confidence === "exact", { timeoutMs: TOOL_MS + 5_000 });
  assert(reported.sourceText === "exact · reported by Antigravity CLI", `then the agent's own word: "${reported.kind} · ${reported.sourceText}"`);
  const after = await attention(bridge, c);
  assert(after.items.every((i) => i.kind !== "blocked") && after.os === before.os, `still no blocked item or notification (${JSON.stringify(after)})`);
  log(`  part C timings: guess ${guessMs} ms after the tool call, taken back ${backMs} ms after the approval (${Date.now() - tC} ms in all, approval at +${tApprove - tC} ms)`);
  // Positive control: the inbox and the notifications are live here — a
  // reported (exact) approval raises an item and notifies at once.
  await bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(c)}, { type: "status", at: Date.now(), source: "e2e", status: { kind: "needs_approval", confidence: "exact", detail: "control" } });`);
  const control = await bridge.waitFor("the control approval's item and notification", `
    const items = window.__HERMES_E2E__.inboxItems().filter((i) => i.sessionId === ${JSON.stringify(c)} && i.kind === "blocked");
    const st = window.__HERMES_E2E__.attentionState();
    return items.length === 1 && st.os.length > ${after.os} ? { items: items.length, os: st.os.length } : null;
  `, { timeoutMs: 5_000 });
  assert(control.items === 1 && control.os > after.os, `an exact approval does raise an item and notify (${JSON.stringify(control)}): the inbox was live all along`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return window.__HERMES_E2E__.terminalIds().map((id) => ({ id, tail: (window.__HERMES_E2E__.readTerminal(id) || []).slice(-8), events: window.__HERMES_E2E__.sessionEventSnapshot(id).events.slice(-10) }));
      `);
      log(`  what the app had: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
  try {
    undoRegistryPath?.();
  } catch (e) {
    log(`  (could not restore the registry Path: ${e.message})`);
  }
  try {
    cpSync(recordDir, join(evidenceDir, "fake-launch-records"), { recursive: true });
  } catch {
    /* best effort */
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
