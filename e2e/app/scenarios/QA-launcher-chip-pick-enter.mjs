#!/usr/bin/env node
// QA-launcher-chip-pick-enter (SOLO-10): keyboard only, a task typed, then a
// chip's menu: Enter opens it, → moves to a value, Enter picks it. The pick
// closes the menu and gives the task field the keyboard, so the next Enter
// launches. The same for the approval and where menus; Esc without a pick
// closes the menu and goes back to its chip.
//
// Negative control: a build before the fix leaves the keyboard on the chip
// (the next Enter opens the menu again) and keeps the approval and where
// menus open after a pick.

import { openLauncher, pressKeyOnFocus, typeInto, waitLaunchEnabled } from "../launcher-steps.mjs";
import { focusOn, focusState, launchedSince, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-chip-pick-enter", async ({ bridge, fx, log, check }) => {
  const press = (k, m) => pressKeyOnFocus(bridge, k, m);
  const menuOpen = () => bridge.eval(`return e2e.first(".task-launcher-menu")?.getAttribute("data-menu") ?? null;`);
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Fix the flaky login test");
  await waitLaunchEnabled(bridge);

  log("approval: Enter on the chip, → Plan first, Enter");
  await focusOn(bridge, '[data-chip="approval"]');
  await press("Enter");
  await sleep(250);
  await focusOn(bridge, '.task-launcher-menu [data-mode="plan"]');
  await press("Enter");
  await sleep(300);
  check((await menuOpen()) === null && (await focusState(bridge)).task, "picking an approval mode closes its menu and gives the task field the keyboard");

  log("where: Current checkout picked");
  await focusOn(bridge, '[data-chip="where"]');
  await press("Enter");
  await sleep(250);
  await focusOn(bridge, '.task-launcher-menu [data-where="current-checkout"]');
  await press("Enter");
  await sleep(300);
  check((await menuOpen()) === null && (await focusState(bridge)).task, "picking where closes its menu and gives the task field the keyboard");
  await focusOn(bridge, '[data-chip="where"]');
  await press("Enter");
  await sleep(250);
  await focusOn(bridge, '.task-launcher-menu [data-where="new-worktree"]');
  await press("Enter");
  await sleep(300);

  log("Esc without a pick goes back to the chip");
  await focusOn(bridge, '[data-chip="effort"]');
  await press("Enter");
  await sleep(250);
  await press("Escape");
  await sleep(250);
  const back = await bridge.eval(`return document.activeElement?.getAttribute("data-chip");`);
  check((await menuOpen()) === null && back === "effort", "Esc without a pick closes the menu and the chip has the keyboard");

  log("model: → a model, Enter, then Enter launches");
  await focusOn(bridge, '[data-chip="model"]');
  await press("Enter");
  await sleep(250);
  await press("ArrowRight");
  await press("Enter");
  await sleep(300);
  const before = fx.records().length;
  check((await menuOpen()) === null && (await focusState(bridge)).task, "picking a model closes its menu and gives the task field the keyboard");
  await press("Enter");
  check(await launchedSince(fx, before), "Enter right after picking a model launches the task");
});
