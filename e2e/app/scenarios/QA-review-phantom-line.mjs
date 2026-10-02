#!/usr/bin/env node
// QA-review-phantom-line (PLN-26): the Review Desk's diff ends at the last
// real line of the file. It used to add a blank row past the end (new line
// 5 of a 4-line file), which a person could click to comment on a line that
// does not exist.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openReviewDesk, runScenario, sleep } from "../review-steps.mjs";

await runScenario("QA-review-phantom-line", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("phantom", { track: false });
  writeFileSync(join(t.wt, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  writeFileSync(join(t.wt, "notes.md"), "one\ntwo\nthree\n");
  await openReviewDesk(t.bridge);
  await t.bridge.waitFor("two file rows", `return e2e.all(".review-file-row").length >= 2;`, { timeoutMs: 20_000 });
  for (const path of ["math.js", "notes.md"]) {
    await t.bridge.eval(`e2e.click(e2e.all(".review-file-row").find((r) => r.getAttribute("data-path") === ${JSON.stringify(path)})); return true;`);
    await sleep(800);
    const rows = await t.bridge.eval(`return e2e.all(".review-desk .review-line").map((l) => [...l.querySelectorAll(".review-line-no")].map((n) => n.textContent).concat(l.querySelector(".review-line-text")?.textContent ?? ""));`);
    const lines = readFileSync(join(t.wt, path), "utf8").split("\n").length - 1;
    const last = rows[rows.length - 1];
    log(`${path}: ${lines} lines; rows: ${JSON.stringify(rows)}`);
    check(Number(last?.[1] || 0) === lines, `${path}: the last diff row is the file's last line (new line ${last?.[1]} of ${lines})`);
  }
  await t.bridge.screenshot(join(evidenceDir, "phantom.png"));
});
