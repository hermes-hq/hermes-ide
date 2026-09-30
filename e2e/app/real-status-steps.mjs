// Shared steps of the REAL-status-<agent> scenarios (STATUS track).
//
// Each scenario starts one REAL agent CLI (claude, codex, agy) the way a
// person does in 2.0 — ⌘N, the task launcher, the agent in a terminal —
// inside the isolated test build, on a throwaway repository, and drives it
// through a few tiny prompts that make it ask for approval, finish a turn,
// ask a question, and exit. It asserts that every state the agent reports
// appears on the status strip as EXACT (or, where the agent reports none,
// as the documented guess) within two seconds of the agent's own hook, and
// records everything for offline measurement:
//
//   output.jsonl   every PTY output chunk the app received (base64, time)
//   events.jsonl   every session event the frontend store accepted (time)
//   shown.jsonl    what the sidebar (deriveStatus) and the strip showed
//   spool.jsonl    every hook line the agent wrote, with the time it appeared
//   os.jsonl       the agent's process tree every 500 ms (CPU, children)
//   marks.jsonl    what the scenario did (keys, prompts), with times
//   meta.json      agent, CLI version, terminal size, timings
//
// into HERMES_STATUS_CORPUS (default <out dir>/status-corpus)/<agent>-<time>/.
// That folder is never part of the repository: the recordings hold the
// machine's paths and the agent's output.
//
// Local only: it needs the real, signed-in CLI and costs a few tiny turns
// (the cheapest model each agent lets a project choose). In CI, on Windows
// or without the CLI it says SKIP; e2e/app/ci-plan.mjs lists the scenarios
// as excluded.

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, createLogger, finishScenario, launchApp, outDir, sleep } from "./harness.mjs";
import { openLauncher, pickInMenu, setRepo, typeInto } from "./launcher-steps.mjs";

/** How long after its hook a state must be on the strip. */
export const WITHIN_MS = 2000;

const which = (name) => {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
};

// ─── Keys, as a keyboard sends them to the terminal ──────────────────

const KEY = {
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  shiftTab: { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true },
  ctrlC: { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
};

function pressKey(bridge, sessionId, name) {
  const k = KEY[name];
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="${sessionId}"]');
    const ta = e2e.must(host && host.querySelector("textarea.xterm-helper-textarea"), "terminal input");
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, { key: ${JSON.stringify(k.key)}, code: ${JSON.stringify(k.code)}, ctrlKey: ${!!k.ctrlKey}, shiftKey: ${!!k.shiftKey}, bubbles: true, cancelable: true, composed: true, view: window });
      Object.defineProperty(ev, "keyCode", { get: () => ${k.keyCode} });
      Object.defineProperty(ev, "which", { get: () => ${k.keyCode} });
      ta.dispatchEvent(ev);
    }
    return true;
  `);
}

// ─── The UI path: welcome, ⌘N, the launcher ──────────────────────────

async function threeStepWelcome(bridge) {
  await bridge.waitFor("the first-launch welcome", `return !!e2e.first(".setup-dialog, .onboarding-dialog");`, { timeoutMs: 30_000 });
  await bridge.click("#setup-policy-accept");
  await bridge.waitFor("Continue", `return !e2e.first(".setup-continue").disabled;`);
  await bridge.click(".setup-continue");
  await bridge.waitFor("the repository step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
  await bridge.click(".setup-skip");
  await bridge.waitFor("the task step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task";`);
  await bridge.click(".setup-finish");
  await bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

// ─── What the agent wrote, what the app showed, what the OS saw ──────

/** Tail the session's spool file: every line with the time it appeared. */
function tailSpool(file, into) {
  let offset = 0;
  let partial = "";
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        if (existsSync(file)) {
          const buf = readFileSync(file);
          if (buf.length > offset) {
            const seen = Date.now();
            partial += buf.subarray(offset).toString("utf8");
            offset = buf.length;
            let nl;
            while ((nl = partial.indexOf("\n")) >= 0) {
              const line = partial.slice(0, nl);
              partial = partial.slice(nl + 1);
              try {
                into.push({ seen, line: JSON.parse(line) });
              } catch {
                /* not ours */
              }
            }
          }
        }
      } catch {
        /* the file is being written */
      }
      await sleep(20);
    }
  })();
  return () => {
    stopped = true;
  };
}

/** Sample the agent's process tree (under `hi run <session>`) every 500 ms. */
function sampleProcesses(sessionId, into) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      const t = Date.now();
      const out = await new Promise((resolve) =>
        execFile("ps", ["-axo", "pid=,ppid=,pcpu=,time=,command="], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout)),
      );
      const rows = out
        .split("\n")
        .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3]), time: m[4], command: m[5] }));
      const hi = rows.find((r) => new RegExp(`(^|/)hi run ${sessionId}(\\s|$)`).test(r.command));
      if (hi) {
        const tree = [];
        const frontier = [hi.pid];
        while (frontier.length) {
          const p = frontier.pop();
          for (const r of rows.filter((x) => x.ppid === p)) {
            tree.push({ pid: r.pid, ppid: r.ppid, pcpu: r.pcpu, time: r.time, name: r.command.split(/\s+/)[0].split("/").pop() });
            frontier.push(r.pid);
          }
        }
        into.push({ t, hi: hi.pid, tree });
      } else {
        into.push({ t, hi: null, tree: [] });
      }
      await sleep(Math.max(0, 500 - (Date.now() - t)));
    }
  })();
  return () => {
    stopped = true;
  };
}

// ─── The scenario ────────────────────────────────────────────────────

/**
 * cfg: {
 *   scenario, agentId, bin,
 *   prepareRepo(repo)           project settings that pick the cheapest model
 *   guarded: [files]            must be byte-identical before and after
 *   restored: [files]           the agent itself may write them (a folder trust
 *                               answer); put back byte for byte afterwards
 *   startup: [{ match, keys }]  prompts the agent shows before it starts
 *   task                        the launcher task (asks for an approval)
 *   hooks: { working, approval(rec), turnEnd(rec), question(rec), exit }
 *   approvalConfidence          "exact" or "guessed" (no approval event)
 *   approvalAfterMs             extra time allowed for a guess (on top of WITHIN_MS)
 *   question: { before: [keys], prompt, required }
 *   exitKeys: [keys | text]
 * }
 */
export async function runRealStatus(cfg) {
  const startedAt = Date.now();
  const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", cfg.scenario);
  const logFile = join(evidenceDir, "scenario.log");
  rmSync(logFile, { force: true });
  mkdirSync(evidenceDir, { recursive: true });
  const log = createLogger(logFile);
  const assert = (condition, message) => {
    if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
    log(`  ok — ${message}`);
  };

  const binPath = which(cfg.bin);
  if (IS_CI || platform() === "win32" || !binPath) {
    log(`needs a real, signed-in ${cfg.bin} on PATH, macOS or Linux, and no CI (CI=${process.env.CI ?? ""}, ${cfg.bin}=${binPath || "none"})`);
    log(`RESULT: SKIP (real ${cfg.bin} not available here, or CI)`);
    process.exit(0);
  }
  const version = spawnSync(binPath, ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0];

  const guarded = (cfg.guarded ?? []).filter(existsSync);
  const restored = (cfg.restored ?? []).filter(existsSync);
  const before = new Map([...guarded, ...restored].map((f) => [f, readFileSync(f)]));

  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), `hermes-e2e-status-${cfg.agentId}-`)));
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# throwaway\n\nA scratch repository for a Hermes status test. Nothing here matters.\n");
  cfg.prepareRepo?.(repo);
  git("add", ".");
  git("commit", "-q", "-m", "init");

  const corpusRoot = process.env.HERMES_STATUS_CORPUS || join(outDir(), "status-corpus");
  const corpus = join(corpusRoot, `${cfg.agentId}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(corpus, { recursive: true });
  const marks = [];
  const mark = (what, extra = {}) => {
    marks.push({ t: Date.now(), what, ...extra });
  };
  const spool = [];
  const osSamples = [];
  const stops = [];
  const results = [];
  let app;
  let sid = null;
  let failed = false;

  /** The strip as the DOM shows it. */
  const strip = () =>
    app.bridge.eval(`
      const el = e2e.first('.session-status-strip[data-strip-session="${sid}"]');
      if (!el) return null;
      return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source,
        sourceText: e2e.norm(el.querySelector(".session-status-strip-source")?.innerText ?? ""),
        text: e2e.norm(el.innerText) };
    `);
  const recording = () => app.bridge.eval(`return window.__HERMES_E2E__.recording(${JSON.stringify(sid)});`);

  /** Wait for a spool line matching `pred`, written after `after`. */
  async function waitForHook(label, pred, { after = 0, timeoutMs = 180_000, onTick } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = spool.find((s) => s.seen >= after && pred(s.line));
      if (hit) return hit;
      if (onTick) await onTick();
      await sleep(50);
    }
    return null;
  }

  /**
   * Check that the strip showed `kind` at `confidence` within `limitMs` of
   * the hook's own time (its ts_ms), from the app's own recording of what
   * it showed. Records the result for the table either way.
   */
  async function expectShown(state, hook, { kind, confidence, limitMs = WITHIN_MS, required = true }) {
    const hookAt = hook.line.ts_ms ?? hook.line.ts * 1000;
    const deadline = Date.now() + limitMs + 3000;
    let row = null;
    while (Date.now() < deadline && !row) {
      const rec = await recording();
      row = rec.shown.find((r) => r.t >= hookAt - 1000 && r.strip.kind === kind && r.strip.confidence === confidence) ?? null;
      if (!row) await sleep(100);
    }
    const ms = row ? Math.max(0, row.t - hookAt) : null;
    const spoolLag = hook.seen - hookAt;
    results.push({ state, hook: hook.line.event, kind, confidence, ms, spoolLagMs: spoolLag });
    log(`  ${state}: hook ${hook.line.event} at ${new Date(hookAt).toISOString()}; strip ${row ? `${kind} (${confidence}) after ${ms} ms` : "never showed it"}`);
    if (required) assert(row && ms <= limitMs, `${state} appears as ${kind} (${confidence}) within ${limitMs} ms of the agent's hook (${ms ?? "never"} ms)`);
    return row;
  }

  try {
    log(`scenario: ${cfg.scenario}   ${cfg.bin}: ${binPath} (${version})   repo: ${repo}`);
    log(`  corpus: ${corpus}`);
    app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, tmp: "shared", flagDefaults: null });
    const { bridge } = app;
    await threeStepWelcome(bridge);

    log(`step 1: ⌘N, the task, ${cfg.agentId} in a terminal`);
    await openLauncher(bridge);
    await setRepo(bridge, repo);
    await typeInto(bridge, ".task-launcher-task", cfg.task);
    await pickInMenu(bridge, "agent", `[data-agent-id="${cfg.agentId}"]`);
    await bridge.waitFor(`the agent doctor to clear ${cfg.agentId}`, `
      const btn = e2e.first(".task-launcher-launch");
      return e2e.all(".task-launcher-block").length === 0 && !!btn && !btn.disabled ? true : null;
    `, { timeoutMs: 60_000 });
    const idsBefore = await bridge.terminalIds();
    await bridge.eval(`
      const ta = e2e.must(e2e.first(".task-launcher-task"), "task field");
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      return true;
    `);
    [sid] = await bridge.waitFor("the task's terminal", `
      const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(idsBefore)}.includes(id));
      return ids.length >= 1 ? ids : null;
    `, { timeoutMs: 30_000 });
    await bridge.eval(`await window.__HERMES_E2E__.recordSession(${JSON.stringify(sid)}); return true;`);
    mark("session", { sid });
    log(`  session: ${sid}`);
    const launchDir = join(app.dataDir, "launch", sid);
    stops.push(tailSpool(join(launchDir, "signals.ndjson"), spool));
    stops.push(sampleProcesses(sid, osSamples));
    const specDeadline = Date.now() + 20_000;
    while (!existsSync(join(launchDir, "launch.json")) && Date.now() < specDeadline) await sleep(200);
    const spec = JSON.parse(readFileSync(join(launchDir, "launch.json"), "utf8"));
    log(`  launch: ${spec.program} ${spec.args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)).join(" ")}`);
    cfg.checkLaunch?.(spec, { assert, repo, launchDir, log });

    log("step 2: answer what the agent asks before it starts (folder trust, update notice)");
    const answered = new Set();
    const answerStartup = async () => {
      const lines = ((await bridge.readTerminal(sid)) ?? []).slice(-40).join("\n");
      for (const [i, s] of (cfg.startup ?? []).entries()) {
        if (answered.has(i) || !s.match.test(lines)) continue;
        answered.add(i);
        log(`  startup prompt ${i} seen (${s.label}); answering`);
        mark("startup", { label: s.label });
        await sleep(600);
        for (const k of s.keys) {
          if (KEY[k]) await pressKey(bridge, sid, k);
          else await bridge.typeInTerminal(sid, k);
          await sleep(250);
        }
      }
    };

    log("step 3: the task runs — working, then an approval");
    const working1 = await waitForHook("working", cfg.hooks.working, { onTick: answerStartup, timeoutMs: 120_000 });
    assert(working1, `the agent reported work (${working1?.line.event})`);
    await expectShown("working", working1, { kind: "working", confidence: "exact" });
    const approval = await waitForHook("approval", cfg.hooks.approval, { onTick: answerStartup, timeoutMs: 180_000 });
    assert(approval, `the agent announced the command that needs approval (${approval?.line.event} ${approval?.line.payload?.tool_name ?? ""})`);
    await expectShown("needs approval", approval, {
      kind: "needs_approval",
      confidence: cfg.approvalConfidence,
      limitMs: WITHIN_MS + (cfg.approvalAfterMs ?? 0),
    });
    await bridge.screenshot(join(evidenceDir, "01-needs-approval.png"));
    await sleep(1200);
    const blockedItems = () =>
      bridge.eval(`return window.__HERMES_E2E__.inboxItems().filter((i) => i.sessionId === ${JSON.stringify(sid)} && i.kind === "blocked").length;`);
    if (cfg.approvalConfidence === "guessed") {
      assert((await blockedItems()) === 0, "a guessed approval raises no 'blocked on you' item");
    }
    mark("approve");
    const approvedAt = Date.now();
    await pressKey(bridge, sid, "enter");
    if (cfg.approvalConfidence === "guessed") {
      // Once approved, the guess goes: taken back by the OS layer when the
      // command starts, or replaced by the tool's own report.
      let left = null;
      const until = approvedAt + 5_000;
      while (Date.now() < until && !left) {
        const now = await strip();
        if (now && now.kind !== "needs_approval") left = { ...now, ms: Date.now() - approvedAt };
        else await sleep(100);
      }
      const retracted = (await recording()).events.some(
        (r) => r.t >= approvedAt && r.event?.type === "status" && r.event.source === `hook:${cfg.agentId}` && r.event.status?.confidence === "guessed" && r.event.status?.kind === "working",
      );
      log(`  after the approval the strip showed ${JSON.stringify(left)} (${retracted ? "taken back by the OS layer" : "replaced by the agent's own report"})`);
      assert(left && left.ms <= 5_000, `the guessed approval is gone within 5 s of the approval (${left?.ms ?? "never"} ms)`);
      assert((await blockedItems()) === 0, "still no 'blocked on you' item");
    }

    log("step 4: the turn ends (approving anything else it asks on the way)");
    // Every approval the agent asked for since `since` gets one Enter (an
    // agent can ask for two tools at once and show them one after the other).
    const approveMore = async (since, alreadyAnswered) => {
      let answered = alreadyAnswered;
      let lastPress = Date.now();
      let guessSince = null;
      return async () => {
        if (Date.now() - lastPress < 2500) return;
        // An agent that never reports its approvals (Antigravity): answer
        // what the strip has shown as a guessed approval for a moment.
        if (cfg.approvalConfidence === "guessed") {
          const now = await strip();
          if (now?.kind !== "needs_approval") guessSince = null;
          else if (guessSince === null) guessSince = Date.now();
          else if (Date.now() - guessSince >= 1500) {
            log(`  another guessed approval (${now.text}); answering Yes`);
            mark("approve");
            await pressKey(bridge, sid, "enter");
            lastPress = Date.now();
            guessSince = null;
          }
          return;
        }
        const asked = spool.filter((s) => s.seen >= since && (cfg.hooks.anyApproval ?? cfg.hooks.approval)(s.line));
        if (asked.length <= answered) return;
        const next = asked[answered];
        log(`  another approval (${next.line.payload?.tool_name ?? next.line.event}); answering Yes`);
        await sleep(1200);
        mark("approve");
        await pressKey(bridge, sid, "enter");
        answered += 1;
        lastPress = Date.now();
      };
    };
    const end1 = await waitForHook("turn end", cfg.hooks.turnEnd, { after: approval.seen, timeoutMs: 180_000, onTick: await approveMore(working1.seen, 1) });
    assert(end1, `the agent reported the turn's end (${end1?.line.event})`);
    await expectShown("turn ended", end1, { kind: "done_unread", confidence: "exact" });
    await bridge.screenshot(join(evidenceDir, "02-done.png"));

    log("step 5: a question");
    await sleep(1500);
    for (const k of cfg.question.before ?? []) {
      if (KEY[k]) await pressKey(bridge, sid, k);
      else await bridge.typeInTerminal(sid, k);
      await sleep(400);
    }
    mark("prompt", { what: "question" });
    const askedAt = Date.now();
    await bridge.typeInTerminal(sid, cfg.question.prompt);
    await sleep(400);
    await pressKey(bridge, sid, "enter");
    const working2 = await waitForHook("working", cfg.hooks.working, { after: askedAt, timeoutMs: 60_000 });
    if (working2) await expectShown("working (2nd prompt)", working2, { kind: "working", confidence: "exact" });
    // A question, or the turn ending without one (the agent asked in text).
    await waitForHook("question or turn end", (l) => cfg.hooks.question(l) || cfg.hooks.turnEnd(l), { after: askedAt, timeoutMs: 150_000 });
    const question = spool.find((s) => s.seen >= askedAt && cfg.hooks.question(s.line)) ?? null;
    if (question) {
      await expectShown("asked a question", question, { kind: "needs_answer", confidence: "exact" });
      await bridge.screenshot(join(evidenceDir, "03-question.png"));
      await sleep(1500);
      mark("answer");
      // Pick the first option; some dialogs want a second Enter to submit.
      for (let i = 0; i < 4; i++) {
        await pressKey(bridge, sid, "enter");
        const end = await waitForHook("turn end", cfg.hooks.turnEnd, { after: question.seen, timeoutMs: 8_000 });
        if (end) break;
      }
    } else {
      results.push({ state: "asked a question", hook: null, kind: "needs_answer", confidence: "exact", ms: null, note: cfg.question.missingNote });
      log(`  the agent asked no question through a tool it reports (${cfg.question.missingNote})`);
      assert(!cfg.question.required, "the question is reported by a hook");
    }
    const end2 = await waitForHook("turn end", cfg.hooks.turnEnd, { after: askedAt, timeoutMs: 180_000, onTick: await approveMore(askedAt, 0) });
    assert(end2, `the second turn ended (${end2?.line.event})`);
    await expectShown("turn ended (2nd)", end2, { kind: "done_unread", confidence: "exact" });

    log("step 6: exit");
    await sleep(1500);
    mark("exit");
    const exitAt = Date.now();
    for (const k of cfg.exitKeys) {
      if (KEY[k]) await pressKey(bridge, sid, k);
      else await bridge.typeInTerminal(sid, k);
      await sleep(600);
    }
    const exitHook = await waitForHook("exit", (l) => l.event === "hermes.exited" || cfg.hooks.exit(l), { after: exitAt, timeoutMs: 30_000 });
    assert(exitHook, `the agent's exit was reported (${exitHook?.line.event})`);
    await expectShown("exited", exitHook, { kind: "exited", confidence: "exact" });
    await sleep(1500);
    const finalStrip = await strip();
    log(`  final strip: ${JSON.stringify(finalStrip)}`);
    await bridge.screenshot(join(evidenceDir, "04-exited.png"));

    // The strip's words for an exact status name the agent (item 5).
    const rec = await recording();
    const exactRows = rec.shown.filter((r) => r.strip.confidence === "exact" && r.strip.source === "hook");
    assert(exactRows.length > 0, `the strip showed exact statuses reported by the agent's hooks (${exactRows.length} changes)`);
  } catch (e) {
    failed = true;
    log(`FAILED: ${e?.stack ?? e}`);
    try {
      if (app?.isRunning() && sid) {
        await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
        log(`  terminal tail:\n    ${(((await app.bridge.readTerminal(sid)) ?? []).slice(-25)).join("\n    ")}`);
        log(`  strip: ${JSON.stringify(await strip())}`);
      }
    } catch (inner) {
      log(`  (could not capture failure evidence: ${inner.message})`);
    }
  } finally {
    let rec = null;
    try {
      if (app?.isRunning() && sid) rec = await recording();
    } catch {
      /* the app is gone */
    }
    for (const stop of stops) stop();
    await sleep(100);
    if (app?.isRunning()) {
      const exit = await app.stop();
      log(`  app exited: ${JSON.stringify(exit)}`);
    }
    // The corpus: everything, for offline scoring (never committed).
    const writeLines = (name, rows) => writeFileSync(join(corpus, name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    writeLines("output.jsonl", rec?.output ?? []);
    writeLines("events.jsonl", rec?.events ?? []);
    writeLines("shown.jsonl", rec?.shown ?? []);
    writeLines("spool.jsonl", spool);
    writeLines("os.jsonl", osSamples);
    writeLines("marks.jsonl", marks);
    writeFileSync(join(corpus, "meta.json"), JSON.stringify({ agent: cfg.agentId, cli: version, scenario: cfg.scenario, startedAt, endedAt: Date.now(), failed, results, withinMs: WITHIN_MS }, null, 2) + "\n");
    log(`  corpus written: ${corpus} (${rec?.output?.length ?? 0} output chunks, ${spool.length} hook lines, ${osSamples.length} process samples)`);
    appendFileSync(join(corpusRoot, "index.jsonl"), JSON.stringify({ dir: corpus, agent: cfg.agentId, failed, results }) + "\n");
    log("  results:");
    for (const r of results) log(`    ${r.state.padEnd(22)} ${String(r.hook).padEnd(18)} ${r.kind}/${r.confidence}: ${r.ms === null ? "not shown" : `${r.ms} ms`}`);
    rmSync(repo, { recursive: true, force: true });
    for (const f of restored) {
      if (Buffer.compare(before.get(f), readFileSync(f)) !== 0) {
        writeFileSync(f, before.get(f));
        log(`  restored ${f.replace(homedir(), "~")} (the agent wrote to it: a folder trust answer)`);
      }
    }
    for (const f of guarded) {
      const same = Buffer.compare(before.get(f), readFileSync(f)) === 0;
      if (!same) {
        failed = true;
        writeFileSync(f, before.get(f));
        log(`FAILED: ${f.replace(homedir(), "~")} changed during the scenario (restored)`);
      } else {
        log(`  ok — ${f.replace(homedir(), "~")} is byte-identical before and after`);
      }
    }
  }
  finishScenario({ scenario: cfg.scenario, evidenceDir, failed, startedAt, log });
}
