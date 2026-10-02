#!/usr/bin/env node
// QA-review-task-checks (PLN-10, the `hi` half): a normal task's own checks
// — the ones set in the launcher, kept outside the repository in the
// checkout's git folder (<git dir>/hermes/done-when.json) — are what
// `hi check` and the agent's Stop hook run, and the Done-When chip shows
// their result. Before, `hi check` read only .hermes/worktree.toml and
// feature.md, and a normal task's checks were silently dropped.
//
// The launcher writes the file (its own fix); when this build's launcher
// does not, the scenario writes it the same way, so this half is proven
// on its own.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runScenario, sleep } from "../review-steps.mjs";

const CHECK = 'node -e "process.exit(3)"';

await runScenario("QA-review-task-checks", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("checks", { track: false, checks: [CHECK] });
  const gitDirRaw = execFileSync("git", ["-C", t.wt, "rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(t.wt, gitDirRaw);
  const file = join(gitDir, "hermes", "done-when.json");
  if (!existsSync(file)) {
    log("(this build's launcher does not write the task's checks yet: written here as it would)");
    mkdirSync(join(gitDir, "hermes"), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, done_when: [CHECK] }) + "\n");
  }
  // A failing check exits 1; the report is on stdout either way.
  let out;
  try {
    out = t.hi(["check", "--json"], { agent: false });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  log(`hi check --json: ${out.trim()}`);
  const report = JSON.parse(out.trim().split("\n").pop());
  check(JSON.stringify(report.commands ?? []).includes("process.exit(3)"), "`hi check` runs the task's own check");
  check(report.source?.kind === "task", `the report names where the checks came from (${JSON.stringify(report.source)})`);

  log("a turn ends: the Done-When chip shows the result");
  await t.bridge.typeInTerminal(t.sid, "work 300\n");
  const chip = await t.bridge
    .waitFor("the Done-When chip", `const c = e2e.first(".done-when-chip"); return c ? e2e.norm(c.innerText) || "shown" : null;`, { timeoutMs: 20_000 })
    .catch(() => "");
  log(`chip: ${JSON.stringify(chip)}`);
  await sleep(500);
  await t.bridge.screenshot(join(evidenceDir, "chip.png"));
  check(chip !== "", "a Done-When chip shows for the task's checks");
});
