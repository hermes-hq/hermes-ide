#!/usr/bin/env node
// QA-launcher-focus-lost (SOLO-02): keyboard only, inside the open launcher,
// every action that removes the focused control gives the keyboard back to
// the task field (Esc still closes, Enter still launches):
//   a. "Save as preset…", then Esc in the name;
//   b. "Save as preset…", the Save button pressed with Enter;
//   c. the "Save it as a preset?" offer, "No, don't ask again" with Enter;
//   d. a typed branch that exists: "Use hermes/…-2" with Enter, then Enter launches;
//   e. ⌘N on the open launcher gives the keyboard back to it.
//
// Negative control: a build before the fix leaves the keyboard on <body>
// after each of them.

import { MOD, openLauncher, openChip, pickInMenu, pressKeyOnFocus, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { focusOn, focusState, launchedSince, menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-focus-lost", async ({ bridge, fx, log, check, evidenceDir }) => {
  const press = (k, m) => pressKeyOnFocus(bridge, k, m);
  const settle = () => sleep(300);

  await openLauncher(bridge);
  log("a. Save as preset…, Esc");
  await focusOn(bridge, ".task-launcher-save-preset");
  await press("Enter");
  await settle();
  check(await bridge.exists(".task-launcher-preset-name"), "Enter on Save as preset… opens the name field");
  await press("Escape");
  await settle();
  check((await focusState(bridge)).task, "after Esc in the preset name the task field has the keyboard");
  check(await bridge.exists(".task-launcher-sheet"), "and the sheet is still open");

  log("e. ⌘N on the open launcher");
  await bridge.eval(`document.activeElement?.blur(); return true;`);
  await menuAction(bridge, "file.new-session");
  await settle();
  check((await focusState(bridge)).task, "⌘N on the open launcher gives the keyboard back to its task field");

  log("   a key on the page itself while the sheet is open");
  await bridge.eval(`document.activeElement?.blur(); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true })); return true;`);
  await settle();
  check((await focusState(bridge)).task, "a key that reaches the page gives the task field the keyboard");
  await bridge.eval(`document.activeElement?.blur(); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
  await waitLauncherClosed(bridge);
  check(true, "and Esc on the page closes the sheet");

  await openLauncher(bridge);
  log("b. Save as preset…, Save with Enter");
  await focusOn(bridge, ".task-launcher-save-preset");
  await press("Enter");
  await settle();
  await typeInto(bridge, ".task-launcher-preset-name", "Quick fix");
  await focusOn(bridge, ".task-launcher-preset-save");
  await press("Enter");
  // The save is a round trip to the backend: on a loaded runner it can take
  // longer than a fixed pause. The form closes once the preset is stored.
  await bridge
    .waitFor("the preset form to close after Save", `return !e2e.first(".task-launcher-preset-name") || !!e2e.norm(e2e.first(".task-launcher-preset-error")?.innerText ?? "");`, { timeoutMs: 15_000 })
    .catch(() => {});
  await settle();
  const saved = await bridge.eval(`return { form: !!e2e.first(".task-launcher-preset-name"), error: e2e.norm(e2e.first(".task-launcher-preset-error")?.innerText ?? ""), focus: document.activeElement?.className ?? null };`);
  log(`  after Save: ${JSON.stringify(saved)}`);
  check((await focusState(bridge)).task, "after saving the preset with its button the task field has the keyboard");
  await bridge.click(".task-launcher-cancel");
  await waitLauncherClosed(bridge);

  log("c. the Save as preset? offer, dismissed by keyboard (three identical launches)");
  for (const t of ["one", "two", "three"]) {
    await openLauncher(bridge);
    await pickInMenu(bridge, "agent", '[data-agent-id="codex"]');
    await settle();
    await typeInto(bridge, ".task-launcher-task", `Offer task ${t}`);
    await waitLaunchEnabled(bridge);
    if (t === "three") {
      await press("Enter", MOD);
      break;
    }
    await bridge.click(".task-launcher-launch");
    await waitLauncherClosed(bridge);
  }
  await bridge.waitFor("the Save as preset? offer", `return !!e2e.first(".task-launcher-suggest-dismiss");`, { timeoutMs: 30_000 });
  await focusOn(bridge, ".task-launcher-suggest-dismiss");
  await press("Enter");
  await settle();
  check((await focusState(bridge)).task, "after dismissing the offer the task field has the keyboard");

  log("d. a typed branch that exists → Use …-2 by keyboard, then Enter launches");
  await typeInto(bridge, ".task-launcher-task", "Offer task one again");
  await openChip(bridge, "where");
  await typeInto(bridge, ".task-launcher-menu .task-launcher-branch", "hermes/offer-task-one");
  await bridge.waitFor("the branch-exists row", `return !!e2e.first(".task-launcher-use-branch");`, { timeoutMs: 15_000 });
  await focusOn(bridge, ".task-launcher-use-branch");
  await press("Enter");
  await settle();
  check((await focusState(bridge)).task, "after choosing the free branch name the task field has the keyboard");
  const before = fx.records().length;
  await press("Enter");
  check(await launchedSince(fx, before), "Enter then launches the task");
  await bridge.screenshot(`${evidenceDir}/end.png`);
});
