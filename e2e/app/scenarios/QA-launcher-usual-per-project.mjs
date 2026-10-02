#!/usr/bin/env node
// QA-launcher-usual-per-project (SOLO-03): the usual combination is per
// project. Claude with Plan first is the usual in other-repo, Codex in
// launcher-repo. ⌘N in a launcher-repo session, then the project chip
// switched to other-repo: the chips follow to other-repo's usual. After a
// change of the person's own, a switch only says what the project usually
// runs, with "Use it".
//
// Negative control: a build before the fix keeps launcher-repo's usual
// combination (Codex) after the switch.

import { launcherState, openChip, openLauncher, pickInMenu, pressKey, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

/** The project chip set to `repo`: from its list, else typed and confirmed with Enter. */
async function chooseRepo(bridge, repo) {
  await openChip(bridge, "project");
  const listed = await bridge.eval(`return !!e2e.first('.task-launcher-menu [data-project-path="${repo.replace(/\\/g, "\\\\")}"]');`);
  if (listed) await bridge.click(`.task-launcher-menu [data-project-path="${repo.replace(/\\/g, "\\\\")}"]`);
  else {
    await typeInto(bridge, ".task-launcher-repo", repo);
    await sleep(600);
    await pressKey(bridge, ".task-launcher-repo", "Enter");
  }
  await sleep(1500);
}

async function launchIn(bridge, repo, task, setup) {
  await openLauncher(bridge);
  await chooseRepo(bridge, repo);
  await setup?.();
  await typeInto(bridge, ".task-launcher-task", task);
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
}

await runLauncherQa("QA-launcher-usual-per-project", async ({ bridge, fx, log, check, evidenceDir }) => {
  await launchIn(bridge, fx.otherRepo, "Explain this error", () => pickInMenu(bridge, "approval", '[data-mode="plan"]'));
  await launchIn(bridge, fx.repo, "Rename foo to bar", () => pickInMenu(bridge, "agent", '[data-agent-id="codex"]'));
  await fx.waitForRecords(2);

  await openLauncher(bridge);
  let st = await launcherState(bridge);
  log(`  ⌘N in a launcher-repo session: ${st.agent} | ${st.project} | ${st.approval}`);
  check(/Codex/.test(st.agent) && st.project === "launcher-repo", "⌘N opens on launcher-repo with its usual combination (Codex)");
  await chooseRepo(bridge, fx.otherRepo);
  st = await launcherState(bridge);
  log(`  after switching the project chip: ${st.agent} | ${st.project} | ${st.approval}`);
  check(st.project === "other-repo", "the project is other-repo");
  check(/Claude/.test(st.agent) && /Plan/.test(st.approval), "the chips follow other-repo's usual combination (Claude, Plan first)");
  await bridge.screenshot(`${evidenceDir}/01-after-switch.png`);

  // Changed by hand first: a switch keeps the person's choice and offers the project's usual.
  await chooseRepo(bridge, fx.repo);
  await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await sleep(800);
  await pickInMenu(bridge, "approval", '[data-mode="acceptEdits"]');
  await sleep(300);
  const mine = await launcherState(bridge);
  await chooseRepo(bridge, fx.otherRepo);
  st = await launcherState(bridge);
  const note = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-other-usual")?.innerText ?? "");`);
  log(`  after a change of the person's own and a switch: ${st.agent} | ${st.approval} (was ${mine.approval}); note: ${note}`);
  check(st.approval === mine.approval && /Claude/.test(st.agent), "the person's own choice is kept across the switch");
  check(/other-repo usually runs Claude Code · Plan first/.test(note), `the launcher says what other-repo usually runs ("${note}")`);
  await bridge.screenshot(`${evidenceDir}/02-other-usual-note.png`);
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".task-launcher-use-usual"), "Use it"));`);
  await sleep(800);
  st = await launcherState(bridge);
  check(/Plan/.test(st.approval), "Use it puts other-repo's usual combination in place");
});
