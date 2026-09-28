#!/usr/bin/env node
// Scenario (N11): a Claude transcript watch follows the session's own
// project, never the newest transcript of some other project.
//
// Two projects (alpha, beta) each have a Claude Code transcript under
// ~/.claude/projects/, in folders named exactly the way Claude Code names
// them. Beta's transcript is the newest. Two terminal sessions run side by
// side: one enters alpha, the other enters beta, and each starts a transcript
// watch (the call plugins make through `agents.watchTranscript`). New lines
// are written to both transcripts; each session's watch must report only its
// own project's line.
//
// The shell reports its folder the way common prompts do (OSC 7 from a
// precmd hook in ~/.zshrc of the private home).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N11-transcript-per-project.mjs

import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";

/** Claude Code's own rule for a project's folder name. */
const claudeFolderName = (dir) => dir.replace(/[^a-zA-Z0-9]/g, "-");

const toolUse = (name) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } }) + "\n";

await runScenario("N11-transcript-per-project", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const shared = mkdtempSync(join(tmpdir(), "hermes-e2e-"));
  onCleanup(() => {
    if (basename(shared).startsWith("hermes-e2e-")) rmSync(shared, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const home = join(shared, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, ".zshrc"),
    "_n11_report_cwd() { printf '\\033]7;file://%s%s\\007' \"$HOST\" \"$PWD\"; }\nprecmd_functions+=(_n11_report_cwd)\n",
  );

  // Two projects, each with a transcript; beta's is the newest file.
  const transcripts = {};
  for (const [project, ageSec] of [["alpha", 600], ["beta", 5]]) {
    const dir = join(home, project);
    mkdirSync(dir, { recursive: true });
    const folder = join(home, ".claude", "projects", claudeFolderName(realpathSync(dir)));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${project}-session.jsonl`);
    writeFileSync(file, toolUse(`${project}-history`));
    const t = new Date(Date.now() - ageSec * 1000);
    utimesSync(file, t, t);
    transcripts[project] = file;
    log(`  ${project}: transcript folder ${basename(folder)}`);
  }

  log("step 1: launch the test app");
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log, homeDir: join(shared, "home") });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  // Collect transcript events per watch inside the page.
  await bridge.eval(`
    window.__n11 = { events: {} };
    window.__n11.watch = async (sessionId) => {
      const t = window.__TAURI_INTERNALS__;
      const watcherId = await t.invoke("start_transcript_watcher", { sessionId });
      const event = "transcript-event:" + watcherId;
      window.__n11.events[watcherId] = [];
      const handler = t.transformCallback((e) => window.__n11.events[watcherId].push(e.payload));
      await t.invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler });
      return watcherId;
    };
    return true;
  `);

  const watchers = {};
  const sessions = {};
  for (const project of ["alpha", "beta"]) {
    log(`step 2.${project}: open a new terminal session for ${project}`);
    const sessionId = await createPlainTerminal(bridge, log);
    sessions[project] = sessionId;
    log(`step 3.${project}: session ${sessionId} enters ${project} and starts a transcript watch`);
    await bridge.typeInTerminal(sessionId, `cd ${project}\n`);
    const cwd = await bridge.waitFor(
      `the session's folder to become ${project}`,
      `const c = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)}).cwd;
       return c && c.endsWith("/${project}") ? c : null;`,
      { timeoutMs: 15_000 },
    );
    log(`  session folder: ${cwd}`);
    await sleep(500);
    watchers[project] = await bridge.eval(`return await window.__n11.watch(${JSON.stringify(sessionId)});`);
    log(`  watch started: ${watchers[project]}`);
  }

  assert(sessions.alpha !== sessions.beta, "two separate sessions are running");
  const running = await bridge.terminalIds();
  assert(running.includes(sessions.alpha) && running.includes(sessions.beta), "both sessions are still open");

  log("step 4: Claude writes a new step to each project's transcript");
  await sleep(1000); // the watches start reading from the end of the file
  appendFileSync(transcripts.alpha, toolUse("AlphaTool"));
  appendFileSync(transcripts.beta, toolUse("BetaTool"));

  const seen = await bridge.waitFor(
    "both watches to report a step",
    `const e = window.__n11.events;
     const a = (e[${JSON.stringify(watchers.alpha)}] || []).map((x) => x.tool_name);
     const b = (e[${JSON.stringify(watchers.beta)}] || []).map((x) => x.tool_name);
     return a.length && b.length ? { alpha: a, beta: b } : null;`,
    { timeoutMs: 10_000 },
  );
  await sleep(1200); // give a wrong watch time to report extra lines too
  const final = await bridge.eval(`
    const e = window.__n11.events;
    return {
      alpha: (e[${JSON.stringify(watchers.alpha)}] || []).map((x) => x.tool_name),
      beta: (e[${JSON.stringify(watchers.beta)}] || []).map((x) => x.tool_name),
    };
  `);
  log(`  first reports: ${JSON.stringify(seen)}; after waiting: ${JSON.stringify(final)}`);
  assert(JSON.stringify(final.alpha) === JSON.stringify(["AlphaTool"]), "the alpha watch reports only alpha's step");
  assert(JSON.stringify(final.beta) === JSON.stringify(["BetaTool"]), "the beta watch reports only beta's step");
  const folders = await bridge.eval(`return {
    alpha: window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessions.alpha)}).cwd,
    beta: window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessions.beta)}).cwd,
  };`);
  log(`  session folders at the end: ${JSON.stringify(folders)}`);
  assert(folders.alpha.endsWith("/alpha") && folders.beta.endsWith("/beta"), "both sessions are still in their own project");
  const shot = await bridge.screenshot(join(evidenceDir, "01-two-sessions.png"));
  log(`  screenshot saved: ${shot.file}`);
});
