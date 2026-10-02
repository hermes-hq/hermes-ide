#!/usr/bin/env node
// QA-git (QAGIT-20): with the UI in German, the Land sheet, the Uncommitted
// Changes dialog and the Branch In Use dialog have no English left.
//
// The app runs under a German locale with the UI language set to German.
// (a) A task asks for feature/inbox, which a hand-made worktree has: the
//     Branch In Use dialog is German ("Branch wird verwendet").
// (b) The Land sheet of a task with one commit is German throughout
//     ("Lokal in main squash-mergen", "Commit-Nachricht", …).
// (c) The Uncommitted Changes dialog is German ("Nicht übernommene
//     Änderungen", "In den Sitzungs-Branch committen und schließen").
//
// Negative control: a build from before the fix ends in RESULT: FAIL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  L,
  closeSessionByLabel,
  dialogText,
  endScenario,
  gitAs,
  gitFixtures,
  invoke,
  launchTask,
  openLandSheet,
  scenarioContext,
  sessionLabel,
  sleep,
  worktreeInfo,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-german-dialogs";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("german", log);
const handWt = join(fx.work, "hand-made-wt");
fx.git("worktree", "add", "-q", handWt, "feature/inbox");
const DE = { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", LC_MESSAGES: "de_DE.UTF-8", LANGUAGE: "de" };
const english = (text, words) => words.filter((w) => text.includes(w));
const escape = async (bridge) => {
  for (let k = 0; k < 3 && (await bridge.exists(".task-launcher-sheet")); k++) {
    await bridge.eval(`(e2e.first(".task-launcher-task") || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
    await sleep(400);
  }
};

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir, 1, { env: DE });
  let bridge = app.bridge;
  const project = await L.completeTaskWelcome(bridge, fx.repo);
  await invoke(bridge, "set_setting", { key: "ui_language", value: "de" });
  await app.stop();
  app = await fx.launchFx(evidenceDir, 2, { env: DE });
  bridge = app.bridge;
  await L.waitForReturningLaunch(bridge);

  log("(a) Branch In Use");
  await L.openLauncher(bridge);
  await L.typeInto(bridge, ".task-launcher-task", "Posteingang prüfen");
  await L.openChip(bridge, "where");
  await bridge.clickWhenReady(`const w = e2e.first('.task-launcher-menu [data-where="existing-branch"]'); return w ? e2e.click(w) : false;`);
  await sleep(200);
  await L.chooseOption(bridge, ".task-launcher-menu .task-launcher-existing", "feature/inbox");
  await sleep(500);
  if (!(await L.launcherState(bridge)).launchDisabled) await bridge.click(".task-launcher-launch");
  const conflict = await bridge.waitFor("the Branch In Use dialog", `return e2e.first(".branch-conflict-modal") ? e2e.norm(e2e.first(".branch-conflict-modal").innerText) : null;`, { timeoutMs: 20_000 }).catch(() => null);
  log(`  dialog: ${conflict}`);
  await bridge.screenshot(join(evidenceDir, "01-branch-in-use.png"));
  check(!!conflict && conflict.includes("Branch wird verwendet"), "the Branch In Use dialog is German");
  check(english(conflict ?? "", ["Branch In Use", "is already checked out by", "Use new branch", "Reuse its checkout", "Cancel"]).length === 0, `no English left (${JSON.stringify(english(conflict ?? "", ["Branch In Use", "Use new branch", "Reuse its checkout", "Cancel"]))})`);
  if (conflict) await bridge.click(".branch-conflict-modal .branch-conflict-btn-cancel");
  await sleep(800);
  await escape(bridge);

  log("(b) the Land sheet");
  const r = await launchTask(bridge, { task: "Notizen ergänzen", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  writeFileSync(join(wt.worktreePath, "NOTIZEN.md"), "Notizen\n");
  gitAs(wt.worktreePath, "add", ".");
  gitAs(wt.worktreePath, "commit", "-q", "-m", "Notizen");
  await openLandSheet(bridge, label);
  await sleep(2000);
  const sheet = await bridge.eval(`return e2e.norm(e2e.first(".land-sheet").innerText);`);
  log(`  sheet: ${sheet}`);
  await bridge.screenshot(join(evidenceDir, "02-land-sheet-de.png"));
  const leftLand = english(sheet, ["How to land", "Squash-merge into", "Commit message", "Archive only", "Archive…", "Commit on", "No uncommitted changes", "has not moved", "Land into", "Cancel"]);
  check(leftLand.length === 0, `the Land sheet has no English left (found: ${JSON.stringify(leftLand)})`);
  check(sheet.includes("Lokal in main squash-mergen"), "the merge option is German");
  await bridge.click(".land-sheet-cancel").catch(() => {});
  await sleep(500);
  await bridge.clickWhenReady(`const d = e2e.first(".review-desk"); if (!d) return true; const b = e2e.all("button", d).find((x) => /^(close|schließen)/i.test(e2e.nameOf(x)) || x.className.includes("close")); return b ? e2e.click(b) : true;`);
  await sleep(500);

  log("(c) the Uncommitted Changes dialog");
  writeFileSync(join(wt.worktreePath, "ENTWURF.md"), "Entwurf\n");
  await closeSessionByLabel(bridge, label);
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`, { timeoutMs: 15_000 });
  const dlg = await dialogText(bridge);
  log(`  dialog: ${dlg}`);
  await bridge.screenshot(join(evidenceDir, "03-dirty-dialog-de.png"));
  const leftDirty = english(dlg, ["Uncommitted Changes", "Commit to session branch", "Discard changes and close", "Archive (keep branch)", "Cancel", "has uncommitted changes"]);
  check(leftDirty.length === 0, `the close dialog has no English left (found: ${JSON.stringify(leftDirty)})`);
  check(dlg.includes("Nicht übernommene Änderungen") && dlg.includes("In den Sitzungs-Branch committen und schließen"), "the title and the primary choice are German");
  await bridge.click(".dirty-wt-modal .dirty-wt-btn-cancel");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
