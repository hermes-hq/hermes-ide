#!/usr/bin/env node
// QA-review-make-feature-undo (NEWCOMER-15): "Make it a feature" asks first
// and can be undone. A newcomer clicked it to see what it does and Hermes
// wrote 8 files into the task's checkout with no question and no way back.
//
//   - the empty Track panel says "This task has no plan yet.", shows a
//     visible "Plan size" label, and no key-hint footer (no feature yet);
//   - "Make it a feature" asks "Turn this task into a guided feature?
//     Hermes adds N small planning files to .hermes/ and .claude/commands/
//     in this branch." with Create / Cancel; Cancel writes nothing;
//   - Create writes them; the toast's Undo removes exactly those files.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runScenario, sleep } from "../review-steps.mjs";

const status = (wt) =>
  execFileSync("git", ["-C", wt, "status", "--porcelain", "-uall"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

await runScenario("QA-review-make-feature-undo", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("makefeature", { track: false, task: "Fix typo in readme" });
  await t.bridge.clickByName("Track");
  await t.bridge.waitFor("the empty Track panel", `return !!e2e.first("[data-testid=track-empty]");`, { timeoutMs: 15_000 });
  const empty = await t.bridge.eval(`return { text: e2e.norm(e2e.first("[data-testid=track-empty]").innerText), footer: !!e2e.first(".track-foot") };`);
  log(`empty panel: ${JSON.stringify(empty)}`);
  check(empty.text.startsWith("This task has no plan yet."), "the empty state says the task has no plan yet");
  check(/Plan size/.test(empty.text), "the plan size picker has a visible label");
  check(!empty.footer, "no key-hint footer before a feature exists");

  const before = status(t.wt);
  await t.bridge.click(".track-make-feature");
  await t.bridge.waitFor("the question", `return !!e2e.first("[data-testid=track-promote-confirm]");`, { timeoutMs: 5000 });
  const question = await t.bridge.eval(`return e2e.norm(e2e.first("[data-testid=track-promote-confirm]").innerText);`);
  log(`question: ${question}`);
  check(/^Turn this task into a guided feature\? Hermes adds \d+ small planning files to \.hermes\/ and \.claude\/commands\/ in this branch\./.test(question), "it asks first and says what it will write");
  check(JSON.stringify(status(t.wt)) === JSON.stringify(before), "asking wrote nothing");
  await t.bridge.click(".track-promote-cancel");
  await sleep(500);
  check(JSON.stringify(status(t.wt)) === JSON.stringify(before), "Cancel wrote nothing");

  await t.bridge.click(".track-make-feature");
  await t.bridge.waitFor("the question", `return !!e2e.first("[data-testid=track-promote-confirm]");`, { timeoutMs: 5000 });
  await t.bridge.click(".track-promote-create");
  await t.bridge.waitFor("the feature", `return !!e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase");`, { timeoutMs: 15_000 });
  const created = status(t.wt).filter((l) => !before.includes(l));
  log(`written: ${JSON.stringify(created)}`);
  check(created.length >= 1 && existsSync(join(t.wt, ".hermes")), "Create wrote the planning files");
  check(await t.bridge.exists(".track-foot"), "the key hints show once a feature exists");
  const undo = await t.bridge.waitFor("the Undo in the toast", `return e2e.all(".toast button").find((b) => b.innerText.trim() === "Undo") ? true : null;`, { timeoutMs: 5000 }).catch(() => null);
  check(!!undo, "the toast offers Undo");
  if (undo) {
    await t.bridge.eval(`e2e.click(e2e.all(".toast button").find((b) => b.innerText.trim() === "Undo")); return true;`);
    await sleep(2000);
    const after = status(t.wt);
    log(`after Undo: ${JSON.stringify(after)}`);
    check(JSON.stringify(after) === JSON.stringify(before), "Undo removed exactly the files it wrote");
    check(!existsSync(join(t.wt, ".hermes", "features")), "no feature folder is left");
  }
  await t.bridge.screenshot(join(evidenceDir, "after-undo.png"));
});
