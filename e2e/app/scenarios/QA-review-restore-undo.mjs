#!/usr/bin/env node
// QA-review-restore-undo (PLN-15): "Restore to T1" from the TURNS bar with
// an edit of the person's in the worktree (not part of any turn).
//
//   - the preview names it: "README.md has edits no turn made — they will be
//     set aside (Undo brings them back)", and its header counts what the
//     restore changes (not what T1 did);
//   - after Restore the notice says "Restored to T1" with Undo;
//   - Undo brings everything back: the person's notes and turn 2's file.
//
// Before, the person's edit went to a hidden reference with no way back in
// the app.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentTurn, runScenario, sleep } from "../review-steps.mjs";

await runScenario("QA-review-restore-undo", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("restore", { track: false });
  await sleep(1500);
  await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, "math.js"), "export const add = (a, b) => a + b;\n"));
  await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, "extra.js"), "export const x = 1;\n"));
  const NOTES = "# demo\n\nmy own notes, typed by the person\n";
  writeFileSync(join(t.wt, "README.md"), NOTES);
  await t.bridge.waitFor("the turn chips", `return e2e.all(".turn-bar-turn").length >= 2;`, { timeoutMs: 15_000 });
  await t.bridge.eval(`e2e.click(e2e.first('.turn-bar-turn[data-turn-n="1"]')); return true;`);
  await t.bridge.waitFor("the turn sheet", `return !!e2e.first(".turn-sheet");`);
  await t.bridge.click(".turn-sheet-restore");
  await t.bridge.waitFor("the restore preview", `return !!e2e.first(".turn-sheet .turn-sheet-hint");`, { timeoutMs: 15_000 });
  const preview = await t.bridge.eval(`return {
    hint: e2e.norm(e2e.first(".turn-sheet-hint")?.innerText ?? ""),
    aside: e2e.norm(e2e.first(".turn-sheet-set-aside")?.innerText ?? ""),
    stat: e2e.norm(e2e.first(".turn-sheet-stat")?.innerText ?? ""),
    files: e2e.first(".turn-sheet-hint")?.getAttribute("data-preview-files"),
  };`);
  log(`preview: ${JSON.stringify(preview)}`);
  await t.bridge.screenshot(join(evidenceDir, "restore-preview.png"));
  check(/README\.md has edits no turn made — they will be set aside \(Undo brings them back\)/.test(preview.aside), "the preview names the person's edit and says Undo brings it back");
  check(/changes 2 files/.test(preview.hint), `the preview counts the files the restore changes, plural (${preview.hint})`);
  check(preview.stat.startsWith("+0") && /−\d+/.test(preview.stat) && preview.stat !== "+1−0", `the header counts what the restore changes (${preview.stat})`);

  await t.bridge.click(".turn-sheet-confirm");
  await t.bridge.waitFor("the restore notice", `return /Restored to T1/.test(e2e.first(".turn-bar-notice")?.innerText ?? "");`, { timeoutMs: 15_000 });
  check(!readFileSync(join(t.wt, "README.md"), "utf8").includes("my own notes"), "the restore set the person's notes aside");
  check(!existsSync(join(t.wt, "extra.js")), "the restore took turn 2's file away");
  const undo = await t.bridge.exists(".turn-bar-notice .turn-bar-undo");
  check(undo, "the notice offers Undo");
  await t.bridge.screenshot(join(evidenceDir, "after-restore.png"));
  if (undo) {
    await t.bridge.click(".turn-bar-notice .turn-bar-undo");
    await t.bridge.waitFor("Undo to bring the notes back", `return true;`);
    await sleep(2000);
    check(readFileSync(join(t.wt, "README.md"), "utf8") === NOTES, "Undo brings the person's notes back");
    check(existsSync(join(t.wt, "extra.js")), "Undo brings turn 2's file back");
  }
});
