#!/usr/bin/env node
// QA-review-track-files (PLN-20): a Feature Track's planning files in the
// Review Desk's CHANGES. They used to look like any change, every row cut
// to the same ".hermes/features/add-an-add-funct…" (file names hidden), and
// "+ all" put them into the feature's commit.
//
//   - the planning files are a collapsed "Track files · N" group;
//   - opened, every row shows its file name (the folder gives way first);
//   - "+ all" stages the code (math.js) and leaves the track files alone.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { featureDir, openReviewDesk, runScenario, sleep } from "../review-steps.mjs";

const rowsVisible = (bridge) =>
  bridge.eval(`
    return e2e.all(".review-desk .git-file-row").filter((row) => row.offsetParent !== null).map((row) => {
      const el = row.querySelector(".git-file-path");
      const path = row.getAttribute("data-path");
      const base = path.split("/").pop();
      const baseEl = [...el.querySelectorAll("span")].find((s) => s.textContent === base) ?? el;
      const br = baseEl.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { path, area: row.getAttribute("data-area"), visible: br.width > 0 && br.right <= box.right + 1 };
    });`);

await runScenario("QA-review-track-files", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("trackfiles");
  writeFileSync(join(featureDir(t.wt), "questions.md"), "# Questions\n\n- [x] Which file? — math.js\n");
  writeFileSync(join(t.wt, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  await openReviewDesk(t.bridge);
  await t.bridge.waitFor("the changes list", `return e2e.all(".review-desk .git-file-row").length >= 1 && !!e2e.first(".review-desk .git-track-files");`, { timeoutMs: 20_000 });
  const group = await t.bridge.eval(`const g = e2e.first(".review-desk .git-track-files"); const b = g.querySelector(".git-track-toggle"); return { open: b?.getAttribute("aria-expanded") === "true", label: e2e.norm(b?.textContent ?? ""), count: g.getAttribute("data-count") };`);
  log(`group: ${JSON.stringify(group)}`);
  check(group.open === false && /^(?:[\u25B8\u25BE]\s*)?Track files · \d+$/i.test(group.label), "the track's files are a collapsed 'Track files · N' group");
  const before = await rowsVisible(t.bridge);
  log(`visible rows: ${JSON.stringify(before)}`);
  check(!before.some((r) => r.path.startsWith(".hermes/features/")), "collapsed, the planning files are out of the way");
  await t.bridge.click(".review-desk .git-track-toggle");
  await sleep(400);
  const opened = await rowsVisible(t.bridge);
  log(`rows when opened: ${JSON.stringify(opened)}`);
  const hidden = opened.filter((r) => !r.visible).map((r) => r.path);
  check(opened.some((r) => r.path.startsWith(".hermes/features/")) && hidden.length === 0, `every row shows its file name (hidden: ${hidden.join(", ")})`);
  await t.bridge.screenshot(join(evidenceDir, "changes.png"));

  await t.bridge.eval(`e2e.click(e2e.all(".review-desk button").find((b) => b.innerText.trim() === "+ all")); return true;`);
  await sleep(2500);
  const staged = await t.bridge.eval(`return e2e.all('.review-desk .git-file-row[data-area="staged"]').map((r) => r.getAttribute("data-path"));`);
  log(`staged after "+ all": ${JSON.stringify(staged)}`);
  check(staged.includes("math.js"), "'+ all' stages the code");
  check(!staged.some((p) => p.startsWith(".hermes/features/")), "'+ all' leaves the track's planning files out of the commit");
});
