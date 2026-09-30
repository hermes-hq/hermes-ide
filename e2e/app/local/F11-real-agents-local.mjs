#!/usr/bin/env node
// Scenario F11 (local only): the REAL claude and codex CLIs inside the
// isolated test build, on a throwaway repository.
//
// Lives outside e2e/app/scenarios/ on purpose: not in e2e/acceptance.yml and
// not run in CI. It needs a signed-in
// `claude` and `codex` on this machine (their own logins; the test build's
// data folder is separate, but HOME is the real one so the logins work)
// and each turn costs a little. It runs only with HERMES_E2E_REAL_AGENTS=1
// and on macOS; otherwise it says SKIP.
//
// For each agent, one tiny prompt on the cheapest model:
//   - the per-launch hooks (Claude) or notify program (Codex) report the
//     turn's end: the strip says "done · hook, exact";
//   - a prompt that needs a command approval shows "needs approval"
//     (Claude: hook, exact; Codex: its OSC 9 notification, signal), the
//     scenario approves it, and the turn ends;
//   - `~/.claude/settings.json` and `~/.codex/config.toml` are byte-identical
//     before and after (what the agents write for themselves — Claude's
//     ~/.claude.json project bookkeeping, session transcripts — is logged,
//     not asserted).
//
// Status on the maintainer's Mac (2026-09-28): the Claude half passes end
// to end (hooks: idle, PermissionRequest for the context read and for the
// command, Stop, SessionEnd; settings.json byte-identical). The Codex half
// could not complete a turn: every model tried (the account's own
// gpt-5.2-codex, the mini models) answered "not supported when using Codex
// with a ChatGPT account", so its notify program never fired and that path
// stays proven by the fake Codex only.
//
//   HERMES_E2E_REAL_AGENTS=1 node e2e/app/local/F11-real-agents-local.mjs
//   HERMES_E2E_REAL_AGENTS=1 HERMES_E2E_REAL_AGENTS_ONLY=claude ...   (one agent)
//
// Evidence (log, screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F11-real-agents-local.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F11-real-agents-local";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const which = (name) => spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
const only = process.env.HERMES_E2E_REAL_AGENTS_ONLY || "";
const agents = ["claude", "codex"].filter((a) => !only || a === only);
if (process.env.HERMES_E2E_REAL_AGENTS !== "1" || platform() !== "darwin" || agents.some((a) => !which(a))) {
  log(`needs HERMES_E2E_REAL_AGENTS=1, macOS and the real ${agents.join(" and ")} on PATH`);
  log("RESULT: SKIP (real agents not requested or not available)");
  process.exit(0);
}

const home = homedir();
const guarded = [join(home, ".claude", "settings.json"), join(home, ".codex", "config.toml")].filter(existsSync);
const before = new Map(guarded.map((f) => [f, readFileSync(f)]));
const claudeJson = join(home, ".claude.json");
const claudeJsonBefore = existsSync(claudeJson) ? readFileSync(claudeJson, "utf8") : null;

// A throwaway repository the agents work in.
const repo = mkdtempSync(join(tmpdir(), "hermes-e2e-real-"));
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "README.md"), "# throwaway\n\nA scratch repository for a Hermes test. Nothing here matters.\n");
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"]);
const PROJECT_NAME = "hermes-throwaway";

// ─── UI steps ────────────────────────────────────────────────────────

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
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  await dismissWhatsNew(bridge);
}
async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}
async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready", `return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}
async function setFlagOverrides(bridge, values) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.eval(`const title = e2e.must(e2e.first(".settings-title"), "settings title"); for (let i = 0; i < 7; i++) e2e.click(title); return true;`);
  await bridge.waitFor("the hidden Flags tab", `return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Flags");`);
  await bridge.eval(`const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Flags"); return e2e.click(e2e.must(tab, "Flags tab"));`);
  for (const [id, value] of Object.entries(values)) {
    await bridge.waitFor(`the ${id} flag control`, `return !!e2e.first('select[data-flag-id="${id}"]');`);
    await bridge.eval(`
      const sel = e2e.must(e2e.first('select[data-flag-id="${id}"]'), "${id} select");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(sel, ${JSON.stringify(value)});
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return sel.value;
    `);
    await bridge.waitFor(`the ${id} override to be saved`, `
      const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
      const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
      return overrides[${JSON.stringify(id)}] === true;
    `);
  }
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

/** New Session wizard: `agent` in a terminal, in the throwaway project, with extra flags. */
async function createSession(bridge, agentLabel, flags) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  if (await bridge.exists('.session-creator-mode-card[data-category="universal"]')) {
    await bridge.click('.session-creator-mode-card[data-category="universal"]');
    await sleep(200);
    if (await bridge.exists(".session-creator-mode-step")) await bridge.click(".session-creator-actions .session-creator-btn-primary");
  }
  let picked = false;
  let flagged = false;
  let projectChosen = false;
  const readState = () =>
    bridge.eval(`
      const out = {
        step: e2e.norm(e2e.first(".session-creator-step")?.innerText ?? ""),
        confirm: !!e2e.first(".session-creator-summary"),
        agentCards: e2e.all(".session-creator-provider-card").length,
        projects: e2e.all(".project-picker-item").map((el) => e2e.norm(el.innerText)),
        labels: e2e.all(".session-creator-custom-suffix-label").map((el) => e2e.norm(el.innerText)),
        flagsInput: false,
      };
      const label = e2e.all(".session-creator-custom-suffix-label").find((el) => e2e.norm(el.innerText).toLowerCase() === "custom flags");
      out.flagsInput = !!label;
      return out;
    `);
  for (let i = 0; i < 10; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    let state = await readState();
    if (state.agentCards > 0 && !picked) {
      await bridge.clickWhenReady(`
        const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith(${JSON.stringify(agentLabel)}));
        return e2e.click(e2e.must(card, "the agent card"));
      `);
      await bridge.eval(`const box = e2e.first(".session-creator-agent-view input[type=checkbox]"); if (box && box.checked) e2e.click(box); return true;`);
      picked = true;
      await sleep(300);
      state = await readState();
    }
    if (state.projects.length > 0 && !projectChosen) {
      log(`  folders offered: ${JSON.stringify(state.projects)}`);
      const chosen = await bridge.eval(`
        const item = e2e.all(".project-picker-item").find((el) => e2e.norm(el.innerText).includes(${JSON.stringify(PROJECT_NAME)}));
        if (!item) return null;
        if (!item.classList.contains("project-picker-item-attached")) e2e.click(item);
        return e2e.norm(item.innerText);
      `);
      if (!chosen) throw new Error(`the throwaway project "${PROJECT_NAME}" is not offered by the wizard (nothing launched)`);
      projectChosen = true;
      log(`  project selected: ${chosen}`);
    }
    log(`  wizard ${state.step || "(no step)"}: labels ${JSON.stringify(state.labels)}${state.confirm ? " [confirm]" : ""}`);
    if (state.confirm && flags && !flagged) throw new Error("reached the confirm step without a custom flags field (nothing launched)");
    if (state.confirm && process.env.HERMES_E2E_REAL_AGENTS_DRY === "1") throw new Error("dry run: stopping before the launch");
    if (state.flagsInput && !flagged && flags) {
      await bridge.eval(`
        const label = e2e.all(".session-creator-custom-suffix-label").find((el) => e2e.norm(el.innerText).toLowerCase() === "custom flags");
        const input = e2e.must(label.parentElement.querySelector("input"), "custom flags input");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(flags)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return input.value;
      `);
      flagged = true;
      log(`  custom flags: ${flags}`);
    }
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      const b = e2e.must(e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"), "the wizard's primary button");
      return e2e.click(b);
    `);
    await sleep(500);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  assert(projectChosen, "the throwaway project was selected");
  assert(flagged || !flags, "the custom flags were set");
  return bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id)); return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

async function waitForStrip(bridge, sessionId, { kind, confidence }, { timeoutMs = 120_000 } = {}) {
  const t0 = Date.now();
  const strip = await bridge.waitFor(`the strip to show ${kind} (${confidence ?? "any"})`, `
    const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]');
    if (!el || el.dataset.statusKind !== ${JSON.stringify(kind)}) return null;
    if (${JSON.stringify(confidence ?? null)} !== null && el.dataset.confidence !== ${JSON.stringify(confidence ?? "")}) return null;
    return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, text: e2e.norm(el.innerText),
      detail: e2e.norm(el.querySelector(".session-status-strip-detail")?.innerText ?? "") };
  `, { timeoutMs, intervalMs: 50 });
  return { strip, ms: Date.now() - t0 };
}
async function waitForStripOneOf(bridge, sessionId, kinds, { timeoutMs = 120_000 } = {}) {
  const t0 = Date.now();
  const strip = await bridge.waitFor(`the strip to show one of ${kinds.join("/")}`, `
    const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]');
    if (!el || !${JSON.stringify(kinds)}.includes(el.dataset.statusKind)) return null;
    return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, text: e2e.norm(el.innerText) };
  `, { timeoutMs, intervalMs: 50 });
  return { strip, ms: Date.now() - t0 };
}
const stripText = (bridge, sessionId) => bridge.eval(`const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]'); return el ? e2e.norm(el.innerText) : null;`);
const tail = async (bridge, sessionId, n = 10) => ((await bridge.readTerminal(sessionId)) ?? []).slice(-n);
async function answerTrustPrompt(bridge, sessionId, pattern, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = (await bridge.readTerminal(sessionId)) ?? [];
    if (lines.some((l) => pattern.test(l))) {
      // Claude's dialog starts on "No, exit": move down to "Yes, I trust
      // this folder" first. Codex's starts on the accepting answer.
      const yesBelow = lines.some((l) => /❯\s*No, exit/.test(l));
      log(`  trust prompt seen; accepting with ${yesBelow ? "Down + " : ""}Enter`);
      await sleep(500);
      if (yesBelow) {
        await bridge.eval(`
          const host = document.querySelector('div[data-session-id="${sessionId}"]');
          const ta = e2e.must(host && host.querySelector("textarea.xterm-helper-textarea"), "terminal input");
          for (const type of ["keydown", "keyup"]) {
            const ev = new KeyboardEvent(type, { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true, composed: true, view: window });
            Object.defineProperty(ev, "keyCode", { get: () => 40 });
            Object.defineProperty(ev, "which", { get: () => 40 });
            ta.dispatchEvent(ev);
          }
          return true;
        `);
        await sleep(300);
      }
      await bridge.typeInTerminal(sessionId, "\n");
      return true;
    }
    await sleep(250);
  }
  return false;
}

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   agents: ${agents.join(", ")}   repo: ${repo}`);
  for (const f of guarded) log(`  guarded: ${f} (${before.get(f).length} bytes)`);

  log("run 0: fresh test-build data, flag on, the throwaway project registered");
  app = await launchApp({ runDir: join(evidenceDir, "run-0"), log, home: "real", resetData: true, tmp: "shared" });
  await completeOnboarding(app.bridge);
  await setFlagOverrides(app.bridge, { launchHelper: "on" });
  await app.bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("create_project", { path: ${JSON.stringify(repo)}, name: ${JSON.stringify(PROJECT_NAME)} });`);
  {
    const exit = await app.stop();
    assert(exit.code === 0, "run 0 quit cleanly");
  }

  log("run 1: the real agents");
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: false, tmp: "shared" });
  await waitForReturningLaunch(app.bridge);

  if (agents.includes("claude")) {
    log("claude: one tiny turn on haiku, then a command that needs approval");
    const sid = await createSession(app.bridge, "Claude", "--model haiku");
    await answerTrustPrompt(app.bridge, sid, /trust/i, { timeoutMs: 45_000 });
    const { strip: started, ms } = await waitForStrip(app.bridge, sid, { kind: "idle", confidence: "exact" }, { timeoutMs: 90_000 }).catch(async () => {
      // The project context prompt may already be running as the first turn.
      return waitForStrip(app.bridge, sid, { kind: "done_unread", confidence: "exact" }, { timeoutMs: 120_000 });
    });
    assert(started.source === "hook", `claude started: "${started.text}" (${ms} ms)`);
    await app.bridge.screenshot(join(evidenceDir, "10-claude-started.png"));
    // The project context is the first prompt (passed on the command line);
    // reading the context file outside the project asks for permission.
    const first = await waitForStripOneOf(app.bridge, sid, ["needs_approval", "done_unread"], { timeoutMs: 120_000 });
    if (first.strip.kind === "needs_approval") {
      assert(first.strip.confidence === "exact" && first.strip.source === "hook", `claude asked to read its context file: "${first.strip.text}" after ${first.ms} ms (PermissionRequest hook)`);
      await app.bridge.screenshot(join(evidenceDir, "10a-claude-context-read-approval.png"));
      await sleep(800);
      await app.bridge.typeInTerminal(sid, "\n");
      const { strip: ctxDone } = await waitForStrip(app.bridge, sid, { kind: "done_unread", confidence: "exact" }, { timeoutMs: 180_000 });
      log(`  context turn ended: "${ctxDone.text}"`);
    }
    await sleep(1500);
    await app.bridge.typeInTerminal(sid, "Reply with exactly the word OK and nothing else\n");
    await waitForStrip(app.bridge, sid, { kind: "working", confidence: "exact" }, { timeoutMs: 30_000 });
    const { strip: done, ms: doneMs } = await waitForStrip(app.bridge, sid, { kind: "done_unread", confidence: "exact" }, { timeoutMs: 180_000 });
    assert(done.source === "hook", `claude's turn ended: "${done.text}" after ${doneMs} ms`);
    for (const l of await tail(app.bridge, sid, 6)) log(`    | ${l}`);
    await sleep(1000);
    await app.bridge.typeInTerminal(sid, "Run the shell command touch canary.txt and nothing else\n");
    const { strip: approval, ms: approvalMs } = await waitForStrip(app.bridge, sid, { kind: "needs_approval", confidence: "exact" }, { timeoutMs: 180_000 });
    assert(approval.source === "hook", `claude asked for approval: "${approval.text}" after ${approvalMs} ms`);
    await app.bridge.screenshot(join(evidenceDir, "11-claude-needs-approval.png"));
    await sleep(800);
    await app.bridge.typeInTerminal(sid, "\n"); // "Yes" is the selected answer
    const { strip: done2 } = await waitForStrip(app.bridge, sid, { kind: "done_unread", confidence: "exact" }, { timeoutMs: 180_000 });
    assert(done2.source === "hook", `the approved turn ended: "${done2.text}"`);
    assert(existsSync(join(repo, "canary.txt")), "the approved command ran (canary.txt exists)");
    await app.bridge.screenshot(join(evidenceDir, "12-claude-done.png"));
    await app.bridge.typeInTerminal(sid, "/exit\n");
    await waitForStrip(app.bridge, sid, { kind: "exited", confidence: "exact" }, { timeoutMs: 30_000 });
    log(`  claude exited: "${await stripText(app.bridge, sid)}"`);
  }

  if (agents.includes("codex")) {
    log("codex: one tiny turn (low reasoning), then a command that needs approval");
    // Codex records the folder as it resolves it (/private/var on macOS);
    // trusting it on the command line keeps its config file untouched. The
    // account's default model with low reasoning: the mini models are not
    // available to a ChatGPT account.
    const trust = `-c projects."${realpathSync(repo)}".trust_level="trusted"`;
    const sid = await createSession(app.bridge, "Codex", `-c model_reasoning_effort="low" ${trust}`);
    await answerTrustPrompt(app.bridge, sid, /trust|allow codex/i, { timeoutMs: 20_000 });
    const t0 = Date.now();
    await app.bridge.waitFor("codex to be at its prompt", `
      const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sid)}) || [];
      return lines.some((l) => /codex|OpenAI|gpt/i.test(l)) ? true : null;
    `, { timeoutMs: 60_000 });
    log(`  codex up after ${Date.now() - t0} ms; strip: "${await stripText(app.bridge, sid)}"`);
    await sleep(3000);
    await app.bridge.typeInTerminal(sid, "Reply with exactly the word OK and nothing else\n");
    const { strip: done, ms: doneMs } = await waitForStrip(app.bridge, sid, { kind: "done_unread" }, { timeoutMs: 180_000 });
    assert(done.confidence === "exact" && done.source === "hook", `codex's notify program reported the turn's end: "${done.text}" after ${doneMs} ms`);
    for (const l of await tail(app.bridge, sid, 6)) log(`    | ${l}`);
    await app.bridge.screenshot(join(evidenceDir, "20-codex-done.png"));
    await sleep(1000);
    await app.bridge.typeInTerminal(sid, "Run the shell command touch canary2.txt outside the sandbox and nothing else\n");
    const { strip: approval, ms: approvalMs } = await waitForStrip(app.bridge, sid, { kind: "needs_approval" }, { timeoutMs: 180_000 });
    assert(approval.confidence === "signal" && approval.source === "osc", `codex asked for approval through its notification: "${approval.text}" after ${approvalMs} ms (signal, never exact: Codex has no hook here)`);
    await app.bridge.screenshot(join(evidenceDir, "21-codex-needs-approval.png"));
    await sleep(800);
    await app.bridge.typeInTerminal(sid, "y");
    const { strip: done2 } = await waitForStrip(app.bridge, sid, { kind: "done_unread", confidence: "exact" }, { timeoutMs: 180_000 });
    assert(done2.source === "hook", `the approved turn ended: "${done2.text}"`);
    await app.bridge.screenshot(join(evidenceDir, "22-codex-approved.png"));
    await app.bridge.typeInTerminal(sid, "\x03");
    await sleep(500);
    await app.bridge.typeInTerminal(sid, "\x03");
    await waitForStrip(app.bridge, sid, { kind: "exited", confidence: "exact" }, { timeoutMs: 30_000 }).catch(() => log("  (codex did not report its exit within 30 s)"));
    log(`  codex: "${await stripText(app.bridge, sid)}"`);
  }

  {
    const exit = await app.stop();
    assert(exit.code === 0, "the app quit cleanly");
  }
  for (const f of guarded) {
    const after = readFileSync(f);
    assert(Buffer.compare(before.get(f), after) === 0, `${f} is byte-identical before and after (${after.length} bytes)`);
  }
  if (claudeJsonBefore !== null) {
    const after = readFileSync(claudeJson, "utf8");
    log(`  ~/.claude.json: ${after === claudeJsonBefore ? "unchanged" : `changed by Claude itself (${claudeJsonBefore.length} -> ${after.length} bytes: its own project bookkeeping for ${repo})`}`);
  }
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          strips: e2e.all(".session-status-strip").map((el) => ({ sid: el.dataset.stripSession, text: e2e.norm(el.innerText) })),
          terminals: window.__HERMES_E2E__.terminalIds().map((id) => ({ id, tail: (window.__HERMES_E2E__.readTerminal(id) || []).slice(-15), events: window.__HERMES_E2E__.sessionEventSnapshot(id).events.slice(-8) })),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
  rmSync(repo, { recursive: true, force: true });
  // Whatever an agent wrote into its own global config for the throwaway
  // folder (Codex records a folder it was told to trust) is put back exactly
  // as it was: the scenario leaves this machine's config as it found it.
  for (const f of guarded) {
    if (Buffer.compare(before.get(f), readFileSync(f)) !== 0) {
      writeFileSync(f, before.get(f));
      log(`  restored ${f} to its bytes from before the scenario`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
