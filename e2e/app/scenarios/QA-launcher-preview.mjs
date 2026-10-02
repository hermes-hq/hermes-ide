#!/usr/bin/env node
// QA-launcher-preview (SOLO-19): "Hermes will run" says what the launch
// passes. The task is quoted the way a shell takes it (single quotes, a ' in
// it escaped); a task of several lines shows its first line and how many
// more ('first line…' (+2 lines)); and the line ends with "+ project context
// note", whose tooltip is the exact sentence the launch adds after the task.
//
// Negative control: a build before the fix shows only the first line in
// double quotes and says nothing of the added context note.

import { join } from "node:path";
import { openLauncher, typeInto } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

const read = (bridge) =>
  bridge.eval(`return {
    line: e2e.norm(e2e.first(".task-launcher-command")?.textContent ?? ""),
    note: e2e.norm(e2e.first(".task-launcher-context-note")?.innerText ?? ""),
    tooltip: e2e.first(".task-launcher-context-note")?.getAttribute("title") ?? "",
  };`);

await runLauncherQa("QA-launcher-preview", async ({ bridge, log, check, evidenceDir }) => {
  await openLauncher(bridge);
  let p = await read(bridge);
  check(p.note === "", "no context note before there is a task");
  await typeInto(bridge, ".task-launcher-task", "Don't break the login\nKeep the old API\nAdd a test");
  await sleep(800);
  p = await read(bridge);
  log(`  preview: ${JSON.stringify(p)}`);
  check(p.line.includes(`'Don'\\''t break the login…' (+2 lines)`), "the task's first line, quoted as a shell takes it, and how many more lines");
  check(p.note === "+ project context note", "the line ends with + project context note");
  check(/Read the file at .* for project context about the attached workspaces\./.test(p.tooltip), "whose tooltip is the sentence the launch adds");
  await typeInto(bridge, ".task-launcher-task", "Fix the flaky login test");
  await sleep(800);
  p = await read(bridge);
  check(p.line.includes(`'Fix the flaky login test'`), "a one-line task is quoted whole");
  await bridge.screenshot(join(evidenceDir, "01-preview.png"));
});
