#!/usr/bin/env node
// Scenario F28: Feature Tracks, end to end, on the real app.
//
// A fake agent (e2e/app/fixtures/track-agent.mjs) runs inside a Hermes
// terminal in a throwaway repository and drives a Light track with nothing
// but the files and the bundled `hi` helper, exactly as a real agent would.
// The scenario plays the person: it reads the ◆ inbox, approves gates with
// ⌘⏎ / Ctrl+⏎ in the Track panel, edits plan.md and sends the edits back
// with `r`, opens the file in $EDITOR with ⇧O, and lands the feature.
//
//   run 0  fresh install: turn the featureTracks flag on (read at next start)
//   run 1  (1) `hi status` works in a Hermes shell (hi is on PATH)
//          (2) the agent creates the feature and hands over questions.md:
//              a ◆ inbox item for the gate and one for the blocking question
//              appear within 2 s of the file write; the Track panel shows
//              the waiting phase
//          (3) answering the question in the file resolves its item; ⌘⏎
//              sets gate: approved and advances the phase in the file, the
//              writer agent (stopped at the gate) is told in one line to run
//              `hi phase` for the next phase, and the app's own approval is
//              NOT reverted (negative control of the guard)
//          (4) the agent's plan over the line cap is refused; a plan within
//              it is handed over; the person edits plan.md, presses r, and
//              the writer agent receives one tagged line naming a review
//              file that holds the diff
//          (5) ⇧O opens the file in $EDITOR in a split (an editor stub
//              records the path)
//          (6) the agent runs `hi approve` (refused, exit 3) and then writes
//              `gate: approved` into feature.md during its own turn (turn
//              events injected through the contract's e2e seam): Hermes
//              reverts it within seconds and raises an error item
//          (7) the track runs to done; a second session in the same worktree
//              is a reader, and `hi status --all` prints the feature as
//              plain text
//          (8) a malformed feature.md shows "feature.md can't be read
//              (line n)" with Open; a Quick task creates no folder
//          (9) `hi land` archives the track files to refs/hermes/archive/
//              <slug>, removes them from the worktree, and writes the PR body
//              from feature.md + plan.md; "Make it a feature" recreates one
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_F28_GATE_BUDGET_MS=0   the "within 2 s" check cannot pass.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F28-feature-tracks.mjs
//
// Evidence (log, screenshots, the agent's log) goes to HERMES_E2E_EVIDENCE,
// or <out dir>/evidence/F28-feature-tracks.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT, appBinaryPath, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { PROBE_OUTPUT, classifyProbe, commandLine, probeCommand } from "../shells.mjs";

const SCENARIO = "F28-feature-tracks";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const MAC = platform() === "darwin";
const GATE_BUDGET_MS = Number(process.env.HERMES_E2E_F28_GATE_BUDGET_MS || 2000);
const SLUG = "demo-search";
const AGENT = join(REPO_ROOT, "e2e", "app", "fixtures", "track-agent.mjs");
const EDITOR_STUB = join(REPO_ROOT, "e2e", "app", "fixtures", "editor-stub.mjs");
const HI = join(dirname(appBinaryPath()), onWindows ? "hi.exe" : "hi");

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ── A throwaway repository with a synthetic identity ─────────────────
const work = realpathSync(mkdtempSync(join(tmpdir(), "hermes-e2e-f28-")));
const repo = join(work, "f28-repo");
const ctl = join(work, "ctl");
const agentLog = join(work, "agent.jsonl");
const editorMarker = join(work, "editor-opened.json");
mkdirSync(ctl, { recursive: true });
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: work,
};
delete gitEnv.HERMES_AGENT;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: gitEnv, encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
git(repo, "config", "user.email", "test@example.com");
git(repo, "config", "user.name", "Test User");
writeFileSync(join(repo, "README.md"), "# f28\n");
git(repo, "add", "README.md");
git(repo, "commit", "-q", "-m", "init");

// Windows keeps app data under %APPDATA%, which a private HOME does not move.
const homeDir = onWindows ? undefined : join(work, "home");
if (homeDir) mkdirSync(homeDir, { recursive: true });
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const env = { EDITOR: `${process.execPath} ${EDITOR_STUB}`, HERMES_E2E_EDITOR_MARKER: editorMarker };
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env })
    : launchApp({ runDir, log, home: "private", homeDir, env });
}

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

// ── UI steps ─────────────────────────────────────────────────────────

async function dismissWhatsNew(bridge) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const _screen of ["welcome", "theme", "AI tools"]) {
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
  await bridge.waitFor("the Finish button", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}

async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

const setInput = (selector, value) => `
  const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  el.focus();
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
`;

const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";

/** New Session wizard: a plain shell in the test repo, whatever the steps are. */
async function startPlainShellInRepo(bridge, label) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.click(".activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  let usedCurrentBranch = false;
  for (let i = 0; i < 10 && (await bridge.exists(".session-creator")); i++) {
    await sleep(300);
    if (await bridge.exists(".session-creator-scan-input")) {
      const listed = await bridge.eval(`
        const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f28-repo"));
        if (!row) return false;
        if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
        return true;
      `);
      if (!listed) {
        await bridge.eval(setInput(".session-creator-scan-input", repo));
        await bridge.clickByName("Scan", { within: ".project-picker-footer" });
      }
      await bridge.waitFor("the test repo to be selected", `
        return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f28-repo"));
      `);
    } else if (
      // Checked and set in one go: the step can move on between two calls.
      await bridge.eval(`
        const el = e2e.first('input.session-creator-name[placeholder="Session name (optional)"]');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        el.focus();
        setter.call(el, ${JSON.stringify(label)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      `)
    ) {
      // named
    } else if (await bridge.exists(".session-creator-branch-multi")) {
      // The current branch is pre-selected, unless another session in the
      // same folder already uses it: then the person says so explicitly.
      const chosen = await bridge.waitFor("a default branch", `
        if (e2e.first(".session-creator-branch-selected-label")) return "preselected";
        return e2e.all("button").some((b) => e2e.norm(b.innerText) === "Use current branch") ? "in-use" : null;
      `, { timeoutMs: 20_000 });
      if (chosen === "in-use" && !usedCurrentBranch) {
        usedCurrentBranch = true;
        await bridge.clickWhenReady(`
          const btn = e2e.all("button").find((b) => e2e.norm(b.innerText) === "Use current branch");
          return e2e.click(e2e.must(btn, "Use current branch"));
        `);
        await sleep(300);
        continue;
      }
    }
    const r = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
    `);
    if (r) log(`  wizard: clicked "${r.clicked}"`);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  return bridge.waitFor(
    `the terminal of "${label}"`,
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

async function sessionData(bridge, sessionId) {
  const all = await invoke(bridge, "get_sessions");
  return all.find((s) => s.id === sessionId) ?? null;
}

async function detectShell(bridge, sessionId) {
  await bridge.typeInTerminal(sessionId, `${probeCommand()}\n`);
  const { line } = await bridge.waitForTerminal(sessionId, PROBE_OUTPUT, { timeoutMs: 30_000 });
  return classifyProbe(line);
}

/** Type a command; wait for a NEW line matching `pattern`. */
async function runInTerminal(bridge, sessionId, command, pattern, timeoutMs = 30_000) {
  const matching = (lines) => (lines ?? []).filter((l) => pattern.test(l.trim()));
  const seen = matching(await bridge.readTerminal(sessionId)).length;
  await bridge.typeInTerminal(sessionId, `${command}\n`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = matching(await bridge.readTerminal(sessionId));
    if (hits.length > seen) return hits[hits.length - 1].trim();
    if (Date.now() > deadline) throw new Error(`no new line matching ${pattern} after typing "${command}"`);
    await sleep(100);
  }
}

const agentLine = (bridge, sessionId, text, timeoutMs = 60_000) =>
  bridge.waitForTerminal(sessionId, new RegExp(`track-agent: ${text}`), { timeoutMs });

/** Open the Track panel from the right activity bar (idempotent). */
async function openTrackPanel(bridge) {
  if (await bridge.exists('[data-testid="track-panel"]')) return;
  await bridge.clickWhenReady(`
    const tab = e2e.all(".activity-bar-tab").find((el) => e2e.nameOf(el) === "Track");
    return e2e.click(e2e.must(tab, "the Track tab"));
  `);
  await bridge.waitFor("the Track panel", `return !!e2e.first('[data-testid="track-panel"]');`);
}

const panelAttrs = (bridge) =>
  bridge.eval(`
    const p = e2e.first('[data-testid="track-panel"]');
    if (!p) return null;
    return { slug: p.dataset.slug, phase: p.dataset.phase, gate: p.dataset.gate, track: p.dataset.track, role: p.dataset.role, error: p.dataset.error };
  `);

/** A key press on the focused Track panel, the way the keyboard delivers it. */
function pressOnPanel(bridge, key, mods = {}) {
  return bridge.eval(`
    const p = e2e.must(e2e.first('[data-testid="track-panel"]'), "track panel");
    p.focus();
    const init = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} };
    return p.dispatchEvent(new KeyboardEvent("keydown", init));
  `);
}
const approveKey = (bridge) => pressOnPanel(bridge, "Enter", MAC ? { metaKey: true } : { ctrlKey: true });

const inboxItems = (bridge) => bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);
async function waitForInbox(bridge, test, what, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await inboxItems(bridge);
    const hit = items.find(test);
    if (hit) return { item: hit, at: Date.now(), items };
    if (Date.now() > deadline) throw new Error(`no inbox item ${what} within ${timeoutMs} ms; items: ${JSON.stringify(items)}`);
    await sleep(intervalMs);
  }
}
async function waitForNoInbox(bridge, test, what, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await inboxItems(bridge);
    if (!items.some(test)) return items;
    if (Date.now() > deadline) throw new Error(`inbox item ${what} never resolved; items: ${JSON.stringify(items)}`);
    await sleep(100);
  }
}

const featureMdOf = (wt) => join(wt, ".hermes", "features", SLUG, "feature.md");
const frontMatter = (text) => ({
  phase: text.match(/^phase:\s*(\S+)/m)?.[1] ?? null,
  gate: text.match(/^gate:\s*(\S+)/m)?.[1] ?? null,
});
const injectEvent = (bridge, sessionId, event) =>
  bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sessionId)}, ${JSON.stringify(event)});`);

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   repo: ${repo}   hi: ${HI}   gate budget: ${GATE_BUDGET_MS} ms`);
  assert(existsSync(HI), "the hi helper was staged next to the test app");

  // ── run 0: flag on ─────────────────────────────────────────────────
  log("run 0: fresh install; turn the featureTracks flag on (read at next start)");
  app = await launch(0, { first: true });
  await completeOnboarding(app.bridge);
  // Honest isolation (on by default since 2.0) would give each shell a
  // worktree of its own; this scenario's sessions share the test repository.
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ featureTracks: true, honestIsolation: false }) });
  await quit(app);

  // ── run 1 ──────────────────────────────────────────────────────────
  app = await launch(1);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);

  log("step 1: a plain shell in the test repo (opened first, on purpose), then the agent's shell; hi is on PATH");
  // The person opened a plain shell in the worktree before starting the
  // agent: seniority must never make it the writer once the agent has run
  // a turn (F28-8).
  const shellId = await startPlainShellInRepo(bridge, "F28 shell");
  const writerId = await startPlainShellInRepo(bridge, "F28 writer");
  const writerData = await sessionData(bridge, writerId);
  const wt = writerData.working_directory;
  log(`  writer session ${writerId} in ${wt}`);
  const shell = await detectShell(bridge, writerId);
  log(`  shell kind: ${shell}`);
  const statusLine = await runInTerminal(bridge, writerId, "hi status", /no feature here/);
  assert(/no feature here/.test(statusLine), `\`hi status\` runs from PATH in a Hermes shell and says "${statusLine.slice(0, 60)}"`);
  await openTrackPanel(bridge);
  assert(await bridge.exists('[data-testid="track-empty"]'), "the Track panel says there is no feature yet and offers Make it a feature");
  let attrs = await panelAttrs(bridge);
  // Two plain shells and no turn yet: neither is an agent, so neither is
  // the writer (a track line typed into a shell would run as a command).
  assert(attrs.role === "none", `before any turn, no plain shell is the writer (this session: ${attrs.role})`);
  // Hermes observed the agent's first turn (contract C0): that, not seniority, makes it the writer.
  const earlier = Date.now() - 60_000;
  assert(await injectEvent(bridge, writerId, { type: "turn_start", at: earlier, n: 1, source: "e2e" }), "the agent's session ran a turn (contract injector)");
  assert(await injectEvent(bridge, writerId, { type: "turn_end", at: earlier + 1000, n: 1, source: "e2e" }), "and ended it");
  await bridge.waitFor("the roles to swap", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.role === "writer";`);
  assert(true, `a session with a turn history writes before the older plain shell ${shellId.slice(0, 8)} without one`);
  await bridge.screenshot(join(evidenceDir, "01-no-feature.png"));

  log("step 2: the fake agent creates the feature and hands over questions.md");
  const agentCmd = commandLine(shell, process.execPath, [AGENT, "--hi", HI, "--ctl", ctl, "--log", agentLog, "--slug", SLUG]);
  await bridge.typeInTerminal(writerId, `${agentCmd}\n`);
  await agentLine(bridge, writerId, "feature created");
  await agentLine(bridge, writerId, "questions handed over");
  const handedOverAt = statSync(featureMdOf(wt)).mtimeMs;
  const gateHit = await waitForInbox(bridge, (i) => i.kind === "gate" && i.detail === `${SLUG}: questions is ready for review`, "for the waiting gate");
  const gateDelay = gateHit.at - handedOverAt;
  log(`  gate item raised ${Math.round(gateDelay)} ms after feature.md was written`);
  assert(gateDelay <= GATE_BUDGET_MS, `setting gate: waiting raised a ◆ inbox item within ${GATE_BUDGET_MS} ms (${Math.round(gateDelay)} ms)`);
  assert(gateHit.item.sessionId === writerId && gateHit.item.source === "track", "the item points at the writer session (the agent, not the older shell) and comes from the track watcher");
  const questionHit = await waitForInbox(bridge, (i) => i.kind === "gate" && i.detail === `${SLUG}: question — Which search engine do we index with?`, "for the blocking question");
  assert(questionHit.item.sessionId === writerId, "the blocking question is a ◆ item too");
  assert(!gateHit.items.some((i) => i.detail.includes("cached")), "a plain (non-blocking) question raises nothing");
  await bridge.waitFor("the panel to show the waiting gate", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.gate === "waiting";`);
  attrs = await panelAttrs(bridge);
  assert(attrs.slug === SLUG && attrs.track === "Light" && attrs.phase === "questions" && attrs.role === "writer", `the panel shows ${attrs.slug} (${attrs.track}) at ${attrs.phase}, role ${attrs.role}`);
  assert(await bridge.exists('.track-question[data-blocking="true"][data-open="true"]'), "the blocking question is listed as open");
  await bridge.screenshot(join(evidenceDir, "02-questions-waiting.png"));

  log("step 3: the person answers the question in the file, then approves with the keyboard");
  const questionsFile = join(wt, ".hermes", "features", SLUG, "questions.md");
  writeFileSync(questionsFile, readFileSync(questionsFile, "utf8").replace("- [ ] ! Which search engine", "- [x] ! Which search engine") + "  — the built-in one\n");
  await waitForNoInbox(bridge, (i) => i.detail.includes("question —"), "for the answered question");
  assert(true, "answering the blocking question in questions.md resolves its inbox item");
  await approveKey(bridge);
  await bridge.waitFor("the file to move on", `
    const p = e2e.first('[data-testid="track-panel"]');
    return p && p.dataset.phase === "plan" && p.dataset.gate === "approved";
  `);
  const afterApprove = frontMatter(readFileSync(featureMdOf(wt), "utf8"));
  assert(afterApprove.gate === "approved" && afterApprove.phase === "plan", `⌘⏎ set gate: approved and advanced the phase in the file (phase: ${afterApprove.phase})`);
  await waitForNoInbox(bridge, (i) => i.kind === "gate", "for the gate");
  await agentLine(bridge, writerId, "questions approved");
  // The agent stopped at the gate; approving told it to go on, in one line.
  await agentLine(bridge, writerId, "told to go on");
  const told = readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.stdin?.startsWith("hermes track:"));
  assert(
    told.length === 1 && told[0].stdin === "hermes track: demo-search: questions approved by the person. Run `hi phase` now and do the plan phase the same way: write its file, run `hi phase done`, then stop and wait for the person's review.",
    `approving told the writer agent, in one line on its input, to run \`hi phase\` for plan ("${told[0]?.stdin}")`,
  );
  await sleep(1500);
  assert(!(await inboxItems(bridge)).some((i) => i.kind === "error"), "Hermes's own approval is never reverted (negative control of the guard)");
  assert(frontMatter(readFileSync(featureMdOf(wt), "utf8")).gate === "approved", "the file was not reverted");
  await bridge.screenshot(join(evidenceDir, "03-approved.png"));
  writeFileSync(join(ctl, "go-plan"), "");

  log("step 4: the plan — the line cap, the hand-over, and the person's edits sent back with r");
  const capLine = (await agentLine(bridge, writerId, "plan over cap")).line;
  assert(/exit 4/.test(capLine) && /cap for plan is 120/.test(capLine), `a plan over the cap is refused: "${capLine.trim().slice(0, 100)}"`);
  await agentLine(bridge, writerId, "plan handed over");
  await waitForInbox(bridge, (i) => i.kind === "gate" && i.detail === `${SLUG}: plan is ready for review`, "for the plan gate");
  await bridge.waitFor("the plan's line count", `return !!e2e.first('.track-phase[data-phase="plan"] .track-phase-lines');`);
  const lines = await bridge.text('.track-phase[data-phase="plan"] .track-phase-lines');
  assert(lines.trim() === "4/120", `the panel shows the plan's size against its cap (${lines.trim()})`);
  // The baseline (the agent's version) is read shortly after the hand-over.
  await bridge.waitFor("the baseline of plan.md", `
    const s = window.__HERMES_E2E__.trackState(${JSON.stringify(wt)});
    return s.features.some((f) => f.slug === ${JSON.stringify(SLUG)} && typeof f.baseline["plan.md"] === "string");
  `);
  const planFile = join(wt, ".hermes", "features", SLUG, "plan.md");
  writeFileSync(planFile, readFileSync(planFile, "utf8") + "- [ ] add tests for empty queries\n");
  await sleep(700);
  await pressOnPanel(bridge, "r");
  // Wait for the whole line: the terminal can show it in two pieces
  // (Windows once read "got review .hermes/features/demo-se").
  const got = (await agentLine(bridge, writerId, "got review \\S+ \\((diff|whole file)\\)")).line;
  assert(/got review \.hermes\/features\/demo-search\/review-1\.md \(diff\)/.test(got), `the writer agent received the review line and found a diff (${got.trim()})`);
  const reviewText = readFileSync(join(wt, ".hermes", "features", SLUG, "review-1.md"), "utf8");
  assert(reviewText.includes("+- [ ] add tests for empty queries"), "review-1.md holds the person's edit as a diff line");
  const stdinRecords = readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.stdin?.startsWith("hermes review:"));
  assert(stdinRecords.length === 1 && stdinRecords[0].stdin === `hermes review: I edited plan.md (diff in .hermes/features/${SLUG}/review-1.md). Take it into account; the gate is still waiting — do not run \`hi phase done\` again.`, `the agent's stdin got exactly one review line: "${stdinRecords[0]?.stdin}"`);
  await bridge.screenshot(join(evidenceDir, "04-review-sent.png"));

  log("step 5: ⇧O opens plan.md in $EDITOR in a split");
  rmSync(editorMarker, { force: true });
  const panesBefore = (await bridge.terminalIds()).length;
  await pressOnPanel(bridge, "O", { shiftKey: true });
  await bridge.waitFor("a new terminal for the editor", `return window.__HERMES_E2E__.terminalIds().length > ${panesBefore};`, { timeoutMs: 20_000 });
  const deadline = Date.now() + 30_000;
  while (!existsSync(editorMarker) && Date.now() < deadline) await sleep(200);
  assert(existsSync(editorMarker), "the editor stub ran in the split");
  const opened = JSON.parse(readFileSync(editorMarker, "utf8"));
  assert(opened.argv.some((a) => a.replace(/\\/g, "/").endsWith(`.hermes/features/${SLUG}/plan.md`)), `$EDITOR was asked to open plan.md (${JSON.stringify(opened.argv)})`);
  await bridge.screenshot(join(evidenceDir, "05-editor-split.png"));
  // Back to the writer's pane for the rest.
  await bridge.clickWhenReady(`
    const item = e2e.all(".session-item").find((el) => el.innerText.includes("F28 writer"));
    return e2e.click(e2e.must(item, "the writer's session row"));
  `);
  await openTrackPanel(bridge);

  log("step 6: the agent approves its own gate — refused by hi, then forged by hand during its turn and reverted");
  assert(await injectEvent(bridge, writerId, { type: "turn_start", at: Date.now(), n: 2, source: "e2e" }), "a turn starts for the writer (contract injector)");
  writeFileSync(join(ctl, "go-forge"), "");
  const approveLine = (await agentLine(bridge, writerId, "hi approve exit")).line;
  assert(/hi approve exit 3/.test(approveLine), `\`hi approve\` exits non-zero inside an agent process (${approveLine.trim()})`);
  await agentLine(bridge, writerId, "forged approval");
  const revertLine = (await agentLine(bridge, writerId, "(reverted after|NOT reverted)", 20_000)).line;
  const revertMs = Number(revertLine.match(/reverted after (\d+) ms/)?.[1] ?? NaN);
  assert(Number.isFinite(revertMs) && revertMs < 6000, `the forged gate: approved was reverted (${revertLine.trim()})`);
  const reverted = frontMatter(readFileSync(featureMdOf(wt), "utf8"));
  assert(reverted.gate === "waiting" && reverted.phase === "plan", "feature.md is back at plan, waiting");
  const alert = await waitForInbox(bridge, (i) => i.kind === "error" && i.detail.includes("approved its own gate"), "for the alert");
  assert(alert.item.sessionId === writerId, `an inbox alert names the session: "${alert.item.detail}"`);
  assert(await injectEvent(bridge, writerId, { type: "turn_end", at: Date.now(), n: 2, source: "e2e" }), "the turn ends");
  await bridge.screenshot(join(evidenceDir, "06-forged-approval-reverted.png"));

  log("step 7: approve the plan and the implementation; the track reaches done");
  await bridge.waitFor("the panel to show plan waiting", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.gate === "waiting" && p.dataset.phase === "plan";`);
  await approveKey(bridge);
  await agentLine(bridge, writerId, "plan approved");
  await bridge.waitFor("the plan approval in the file", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.gate === "approved" && p.dataset.phase === "implement";`);
  writeFileSync(join(ctl, "go-implement"), "");
  await agentLine(bridge, writerId, "implement handed over");
  await bridge.waitFor("implement waiting", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.gate === "waiting" && p.dataset.phase === "implement";`);
  await approveKey(bridge);
  await agentLine(bridge, writerId, "done");
  await bridge.waitFor("the panel to show done", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.phase === "done";`);
  assert(existsSync(join(wt, "search.txt")), "the implement phase produced code");
  await bridge.screenshot(join(evidenceDir, "07-done.png"));

  log("step 8: a second session in the same worktree is a reader; hi status --all is plain text");
  const readerId = await startPlainShellInRepo(bridge, "F28 reader");
  const readerData = await sessionData(bridge, readerId);
  assert(readerData.working_directory === wt, "the reader works in the same folder");
  await openTrackPanel(bridge);
  await bridge.waitFor("the reader's panel", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.role === "reader";`);
  attrs = await panelAttrs(bridge);
  assert(attrs.role === "reader" && attrs.slug === SLUG && attrs.phase === "done", `the second session is a reader of ${attrs.slug} (${attrs.phase})`);
  await detectShell(bridge, readerId);
  const statusAll = await runInTerminal(bridge, readerId, "hi status --all", new RegExp(`^${SLUG}\\s+Light\\s+done\\s+gate:`));
  assert(!/\x1b/.test(statusAll), `\`hi status --all\` lists the feature as plain text: "${statusAll}"`);
  await bridge.screenshot(join(evidenceDir, "08-reader.png"));
  log("step 9: a malformed feature.md is reported with its line; a Quick task creates no folder");
  const goodText = readFileSync(featureMdOf(wt), "utf8");
  writeFileSync(featureMdOf(wt), `---\nslug: ${SLUG}\ntrack: Light\ngate: maybe\n---\n`);
  await bridge.waitFor("the error in the panel", `return !!e2e.first('[data-testid="track-error"]');`);
  const errorText = await bridge.text('[data-testid="track-error"]');
  assert(/feature\.md can't be read \(line 4\)/.test(errorText), `the panel says "${errorText.split("\n")[0]}"`);
  assert(await bridge.exists('[data-testid="track-error"] button.track-open-error'), "with an Open button");
  await waitForInbox(bridge, (i) => i.kind === "error" && i.detail === `${SLUG}: feature.md can't be read (line 4)`, "for the unreadable file");
  await bridge.screenshot(join(evidenceDir, "09-malformed.png"));
  writeFileSync(featureMdOf(wt), goodText);
  await bridge.waitFor("the error to clear", `return !e2e.first('[data-testid="track-error"]');`);
  const quickLine = await runInTerminal(bridge, readerId, "hi feature new quick-fix --track Quick --no-branch", /Quick track/);
  assert(/no feature folder/.test(quickLine) && !existsSync(join(wt, ".hermes", "features", "quick-fix")), "a Quick task creates no .hermes/features folder");

  log("step 10: hi land archives the track files and writes the PR body; Make it a feature promotes again");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "wip");
  const bodyFile = join(work, "pr.md");
  const landOut = execFileSync(HI, ["land", "--body-file", bodyFile], { cwd: wt, env: gitEnv, encoding: "utf8" });
  log(`  hi land: ${landOut.trim().split("\n").join(" | ")}`);
  const archived = git(wt, "rev-parse", `refs/hermes/archive/${SLUG}`);
  assert(/^[0-9a-f]{40}$/.test(archived), `the track files are archived at refs/hermes/archive/${SLUG}`);
  const archivedPlan = git(wt, "show", `refs/hermes/archive/${SLUG}:.hermes/features/${SLUG}/plan.md`);
  assert(archivedPlan.includes("add tests for empty queries"), "the archive holds the plan as reviewed");
  assert(!existsSync(join(wt, ".hermes", "features", SLUG)), "the folder is gone from the worktree");
  assert(git(wt, "ls-files", ".hermes/features") === "", "the branch no longer tracks the files (they stay out of the merge)");
  const body = readFileSync(bodyFile, "utf8");
  assert(body.startsWith("Demo search\n") && body.includes("## Plan") && body.includes("- [ ] build the index"), "the PR body comes from feature.md and plan.md");
  await bridge.waitFor("the panel to show no feature", `return !!e2e.first('[data-testid="track-empty"]');`);
  // Off the hermes/ branch: the promotion must create it, like hi feature new.
  git(wt, "switch", "-q", "-c", SLUG);
  git(wt, "branch", "-q", "-D", `hermes/${SLUG}`);
  await bridge.waitFor("the panel to show the plain branch", `return (e2e.first(".track-branch")?.textContent ?? "") === ${JSON.stringify(SLUG)};`);
  await bridge.click("button.track-make-feature");
  // It asks first, naming what it writes.
  await bridge.waitFor("the Make it a feature question", `return !!e2e.first('[data-testid="track-promote-confirm"]');`);
  await bridge.click("button.track-promote-create");
  await bridge.waitFor("the promoted feature", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.slug === ${JSON.stringify(SLUG)} && p.dataset.phase === "questions";`);
  assert(existsSync(featureMdOf(wt)), "Make it a feature created .hermes/features/<slug>/feature.md for the branch");
  assert(git(wt, "branch", "--show-current") === `hermes/${SLUG}`, "and put the worktree on hermes/<slug>, like hi feature new");
  await bridge.waitFor("the panel to show the new branch", `return (e2e.first(".track-branch")?.textContent ?? "") === ${JSON.stringify(`hermes/${SLUG}`)};`);
  await bridge.screenshot(join(evidenceDir, "10-promoted.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          panel: e2e.first('[data-testid="track-panel"]')?.outerHTML?.slice(0, 1500) ?? null,
          inbox: window.__HERMES_E2E__.inboxItems(),
          terminals: window.__HERMES_E2E__.terminalIds().map((id) => ({ id, tail: (window.__HERMES_E2E__.readTerminal(id) || []).slice(-15) })),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  try {
    if (existsSync(agentLog)) cpSync(agentLog, join(evidenceDir, "track-agent.jsonl"));
  } catch {
    /* best effort */
  }
  // Windows may still hold a file in the repository just after the app
  // quit: retry, and never let the cleanup decide the result.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    log(`  (could not remove the scratch folder: ${e.message})`);
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
