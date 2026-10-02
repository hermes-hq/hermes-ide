#!/usr/bin/env node
// QA-launcher-branch-names (QAGIT-14, the launcher's half): branch names git
// (or the worktree folder) refuses are flagged in the launcher before
// Launch, in words:
//   "release"            next to release/2.3: "release is a folder of branches (release/2.3) — pick another name."
//   "feature/inbox/sub"  next to feature/inbox: "feature/inbox is a branch, so feature/inbox/sub can't be made — pick another name."
//   "hermes/.wip":       "Branch names may not have a part starting with '.'."
//   "hermes/<240 x>":    "This name is too long for a worktree folder (max ~200 characters)."
//
// Negative control: a build before the fix lets each one reach Launch,
// which then fails with a libgit2 message.

import { join } from "node:path";
import { launcherState, openChip, openLauncher, typeInto } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

const LONG = "hermes/" + "x".repeat(240);
const CASES = [
  ["release", /^release is a folder of branches \(release\/2\.3\) — pick another name\./],
  ["feature/inbox/sub", /^feature\/inbox is a branch, so feature\/inbox\/sub can't be made — pick another name\./],
  ["hermes/.wip", /^Branch names may not have a part starting with '\.'\./],
  [LONG, /^This name is too long for a worktree folder \(max ~200 characters\)\./],
];

await runLauncherQa("QA-launcher-branch-names", async ({ bridge, fx, log, check, evidenceDir }) => {
  fx.git("branch", "release/2.3", "main");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Name check");
  for (const [i, [name, want]] of CASES.entries()) {
    await openChip(bridge, "where");
    await typeInto(bridge, ".task-launcher-menu .task-launcher-branch", name);
    await sleep(900);
    const st = await launcherState(bridge);
    const row = st.blocks.find((b) => b.kind === "bad-branch");
    log(`  "${name.length > 40 ? name.slice(0, 40) + "…" : name}": ${JSON.stringify(row)} launch disabled ${st.launchDisabled}`);
    check(!!row && want.test(row.text), `"${name.slice(0, 30)}" is flagged before Launch, in words`);
    check(st.launchDisabled, "and Launch waits");
    if (i === 0) await bridge.screenshot(join(evidenceDir, "01-release.png"));
  }
  await openChip(bridge, "where");
  await typeInto(bridge, ".task-launcher-menu .task-launcher-branch", "hermes/name-check-ok");
  await sleep(900);
  const ok = await launcherState(bridge);
  check(!ok.blocks.some((b) => b.kind === "bad-branch") && !ok.launchDisabled, "a usable name launches");
});
