#!/usr/bin/env node
// QA-launcher-empty-repo (QAGIT-15, part d): a repository with no commit
// yet. A new worktree has nothing to start from, so the launcher says so
// before Launch: "This repository has no commits yet — make a first commit,
// or run on the current checkout.", with "Run on the current checkout",
// which then launches.
//
// Negative control: a build before the fix lets Launch go and fails with a
// raw git message (UnbornBranch).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launcherState, openChip, openLauncher, pressKey, typeInto, waitLaunchEnabled } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-empty-repo", async ({ bridge, fx, log, check, evidenceDir }) => {
  const empty = join(fx.work, "fresh-repo");
  mkdirSync(empty, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", empty]);
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Write the first module");
  await openChip(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", empty);
  await sleep(900);
  await pressKey(bridge, ".task-launcher-repo", "Enter");
  await sleep(1500);
  const st = await launcherState(bridge);
  log(`  empty repository: blocks ${JSON.stringify(st.blocks)}, launch disabled ${st.launchDisabled}`);
  await bridge.screenshot(join(evidenceDir, "01-empty-repo.png"));
  const row = st.blocks.find((b) => b.kind === "no-commits");
  check(!!row && row.text.startsWith("This repository has no commits yet — make a first commit, or run on the current checkout."), "the launcher says the repository has no commit yet");
  check(st.launchDisabled, "and Launch waits");
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".task-launcher-use-current"), "Run on the current checkout"));`);
  await waitLaunchEnabled(bridge);
  const now = await launcherState(bridge);
  check(/current checkout/.test(now.where), "Run on the current checkout picks it");
  const before = fx.records().length;
  await bridge.click(".task-launcher-launch");
  const deadline = Date.now() + 30_000;
  while (fx.records().length === before && Date.now() < deadline) await sleep(300);
  check(fx.records().length > before, "and the task starts there");
  const toasts = await bridge.eval(`return e2e.all(".toast").map((x) => e2e.norm(x.innerText));`);
  check(!toasts.some((t) => /UnbornBranch|class=|code=/.test(t)), `no raw git error (${JSON.stringify(toasts)})`);
});
