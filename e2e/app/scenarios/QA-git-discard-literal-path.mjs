#!/usr/bin/env node
// QA-git (QAGIT-04): Discard (and Unstage) take a file's path literally.
//
// pages/[id].tsx next to pages/i.tsx and pages/d.tsx (Next.js routes), all
// three edited and not committed. Discard on pages/[id].tsx restores that
// file only; the edits in pages/i.tsx and pages/d.tsx stay. ([id] used to be
// a glob pattern that also matched i.tsx and d.tsx.)
//
// Negative control: a build from before the fix ends in RESULT: FAIL.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { L, endScenario, gitFixtures, launchTask, openReviewDesk, scenarioContext, sessionLabel, sleep } from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-discard-literal-path";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;

const fx = gitFixtures("discard", log);
mkdirSync(join(fx.repo, "pages"), { recursive: true });
for (const f of ["[id].tsx", "i.tsx", "d.tsx"]) writeFileSync(join(fx.repo, "pages", f), `export default "${f}";\n`);
fx.git("add", "pages");
fx.git("commit", "-q", "-m", "pages");

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  await L.completeTaskWelcome(bridge, fx.repo);
  const r = await launchTask(bridge, { task: "Try a routing experiment", where: "current-checkout", log });
  const label = await sessionLabel(bridge, r.sessionId);
  writeFileSync(join(fx.repo, "pages", "[id].tsx"), "experiment to throw away\n");
  writeFileSync(join(fx.repo, "pages", "i.tsx"), "real work in i.tsx\n");
  writeFileSync(join(fx.repo, "pages", "d.tsx"), "real work in d.tsx\n");

  await openReviewDesk(bridge, label);
  await bridge.waitFor("the changed file rows", `return e2e.all(".review-desk [class*=git-file]").some((el) => el.innerText.includes("[id].tsx"));`, { timeoutMs: 20_000 });
  const rowSel = `e2e.all(".review-desk [class*=git-file-row], .review-desk .git-file").find((el) => el.innerText.includes("[id].tsx") && el.querySelector("[class*=discard]"))`;
  await bridge.clickWhenReady(`const row = ${rowSel}; return e2e.click(e2e.must(row && row.querySelector(".git-file-action-discard, .git-file-btn-discard"), "Discard on [id].tsx"));`);
  await bridge.clickWhenReady(`const b = e2e.first(".git-file-action-discard-confirm, .git-file-btn-discard-confirm"); return e2e.click(e2e.must(b, "Confirm discard"));`);
  await sleep(2000);
  await bridge.screenshot(join(evidenceDir, "01-after-discard.png"));
  log(`  status after discarding [id].tsx: ${JSON.stringify(fx.git("status", "--short"))}`);
  check(readFileSync(join(fx.repo, "pages", "[id].tsx"), "utf8") === 'export default "[id].tsx";\n', "pages/[id].tsx is restored");
  check(readFileSync(join(fx.repo, "pages", "i.tsx"), "utf8") === "real work in i.tsx\n", "pages/i.tsx keeps its uncommitted edit");
  check(readFileSync(join(fx.repo, "pages", "d.tsx"), "utf8") === "real work in d.tsx\n", "pages/d.tsx keeps its uncommitted edit");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
