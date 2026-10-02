#!/usr/bin/env node
// QA-review-track-big-files (CHAOS-18): the Feature Tracks watcher looks at
// size and modification time first and reads a track file only when it
// changed, and never reads or sends more than 256 KB of one.
//
// A 20 MB feature.md (an agent dumped a log into it): the watcher used to
// re-read every file in full every 500 ms (15 % of a core while nothing
// changed) and ship the whole text to the window (7 s for track_watch).
//
//   - idle CPU with the 20 MB file stays within 5 % of a core of the idle
//     CPU with a small one (macOS and Linux, where `ps` reports it);
//   - track_watch answers fast, with at most 256 KB of text and the flag
//     that it was cut;
//   - the Track panel says "feature.md is too large (…); open it in your
//     editor".
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp } from "../harness.mjs";
import { L, invoke, mkRepo, mkWork, onWindows, runScenario, sleep } from "../review-steps.mjs";

const cpuSeconds = (pid) => {
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  return t
    .split(":")
    .map(Number)
    .reduce((acc, part) => acc * 60 + part, 0);
};
async function cpuShare(pid, ms) {
  const a = cpuSeconds(pid);
  await sleep(ms);
  return (cpuSeconds(pid) - a) / (ms / 1000);
}

await runScenario("QA-review-track-big-files", async ({ evidenceDir, log, check }) => {
  const work = mkWork("bigfiles");
  const { repo } = mkRepo(join(work, "demo-repo"));
  const fdir = join(repo, ".hermes", "features", "big-log");
  const app = await launchApp(
    onWindows
      ? { runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, flagDefaults: { taskLauncher: false, featureTracks: true } }
      : { runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir: join(work, "home"), flagDefaults: { taskLauncher: false, featureTracks: true } },
  );
  try {
    const { bridge } = app;
    await L.completeClassicOnboarding(bridge);
    const sid = await bridge.eval(`return await window.__HERMES_E2E__.newTerminal({ label: "Big", cwd: ${JSON.stringify(repo)} });`, { timeoutMs: 20_000 });
    mkdirSync(fdir, { recursive: true });
    const head = "---\nslug: big-log\ntrack: Light\nphase: plan\ngate: waiting\n---\n\n";
    // The app watches every session's folder on its own (the Big terminal's too).
    writeFileSync(join(fdir, "feature.md"), head + "small\n");
    await bridge.clickByName("Track");
    await bridge.waitFor("the Track panel with the feature", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-slug") === "big-log";`, { timeoutMs: 15_000 });
    await sleep(2000);
    const measure = !onWindows;
    const small = measure ? await cpuShare(app.child.pid, 8000) : 0;
    if (measure) log(`idle CPU with a small feature.md: ${(small * 100).toFixed(1)} % of a core`);

    writeFileSync(join(fdir, "feature.md"), head + ("log line " + "x".repeat(90) + "\n").repeat(200_000));
    const note = await bridge
      .waitFor("the too-large note", `const n = e2e.first("[data-testid=track-too-large]"); return n ? e2e.norm(n.innerText) : null;`, { timeoutMs: 15_000 })
      .catch(() => "");
    log(`Track panel: ${JSON.stringify(note)}`);
    await bridge.screenshot(join(evidenceDir, "too-large.png"));
    check(/feature\.md is too large \(\d[\d.,]* MB\); open it in your editor/.test(note), "the Track panel says the file is too large and offers the editor");
    await sleep(2000);
    if (measure) {
      const big = await cpuShare(app.child.pid, 8000);
      log(`idle CPU with a 20 MB feature.md (nothing changing): ${(big * 100).toFixed(1)} % of a core`);
      check(big - small < 0.05, "an unchanged large feature file costs no more than 5 % of a core while idle");
    }
    const started = Date.now();
    const snap = await invoke(bridge, "track_watch", { sessionId: sid, worktreePath: repo });
    const took = Date.now() - started;
    const f = snap.features[0];
    log(`track_watch: ${took} ms; text ${f.featureText.length} chars, truncated ${f.featureTruncated}, size ${f.featureSize}`);
    check(f.featureTruncated === true && f.featureText.length <= 256 * 1024, "at most 256 KB of the file is read and sent, marked as cut");
    check(took < 2000, `track_watch answers fast (${took} ms)`);
  } finally {
    if (app.isRunning()) await app.stop();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
