#!/usr/bin/env node
// QA-launcher-preset-names (SOLO-17): presets are picked by name and by
// ⌘1–⌘4, so two never share one (letter case ignored).
//   - Settings > Agents: a rename to an empty name is refused; a rename to
//     the name another preset has is refused with 'You already have a
//     preset called "Plan first"'; a rename that goes through clears the
//     earlier error.
//   - The launcher's "Save as preset…" refuses a taken name the same way,
//     inline; saving the combination a preset already is says "Same as ⌘2
//     Plan first".
//
// Negative control: a build before the fix accepts the taken names and
// keeps the stale "needs a name" error under the renamed row.

import { join } from "node:path";
import { invoke, openLauncher, pickInMenu, pressKeyOnFocus, typeInto } from "../launcher-steps.mjs";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-preset-names", async ({ bridge, fx, log, check, evidenceDir }) => {
  const base = (await invoke(bridge, "get_usual_launch_choice", { repo: fx.repo })).choice;
  await invoke(bridge, "save_launch_preset", { name: "Quick fix", choice: base });
  await invoke(bridge, "save_launch_preset", { name: "Plan first", choice: { ...base, approvalModeId: "plan" } });
  const refused = await invoke(bridge, "save_launch_preset", { name: "QUICK FIX", choice: base }).then(
    () => null,
    (e) => String(e),
  );
  check(/You already have a preset called "Quick fix"/.test(refused ?? ""), `the backend refuses a taken name (${refused})`);

  await menuAction(bridge, "hermes.settings");
  await bridge.waitFor("Settings", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.eval(`const tab = e2e.all(".settings-tab").find((el) => /^Agents$/.test(e2e.norm(el.innerText))); return e2e.click(e2e.must(tab, "Agents tab"));`);
  await bridge.waitFor("the preset rows", `return e2e.all(".agents-settings-preset").length >= 2;`, { timeoutMs: 30_000 });
  const rows = () => bridge.eval(`return e2e.all(".agents-settings-preset").map((r) => ({ name: e2e.norm(r.querySelector(".agents-settings-preset-name")?.innerText ?? r.querySelector("input")?.value ?? ""), err: e2e.norm(r.querySelector(".agents-settings-error")?.innerText ?? "") }));`);
  await bridge.click(".agents-settings-preset .agents-settings-preset-rename");
  await typeInto(bridge, ".agents-settings-preset-name-input", "  ");
  await pressKeyOnFocus(bridge, "Enter");
  await sleep(600);
  log(`  empty name: ${JSON.stringify(await rows())}`);
  await typeInto(bridge, ".agents-settings-preset-name-input", "plan first");
  await pressKeyOnFocus(bridge, "Enter");
  await sleep(800);
  let r = await rows();
  log(`  renamed to a taken name: ${JSON.stringify(r)}`);
  check(r.some((x) => /You already have a preset called "Plan first"/.test(x.err)), "Settings refuses a taken name and says which");
  let names = (await invoke(bridge, "list_launch_presets")).map((p) => p.name.toLowerCase());
  check(new Set(names).size === names.length, `no two presets share a name (${JSON.stringify(names)})`);
  await typeInto(bridge, ".agents-settings-preset-name-input", "Fast fix");
  await pressKeyOnFocus(bridge, "Enter");
  await sleep(800);
  r = await rows();
  log(`  renamed to a free name: ${JSON.stringify(r)}`);
  check(r.some((x) => x.name === "Fast fix") && !r.some((x) => x.err), "a rename that goes through clears the earlier error");
  await bridge.screenshot(join(evidenceDir, "01-settings.png"));
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings to close", `return !e2e.first(".settings-title");`);

  await openLauncher(bridge);
  await bridge.click(".task-launcher-save-preset");
  await typeInto(bridge, ".task-launcher-preset-name", "FAST FIX");
  await pressKeyOnFocus(bridge, "Enter");
  await sleep(800);
  const err = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-preset-error")?.innerText ?? "");`);
  log(`  launcher, a taken name: ${JSON.stringify(err)}`);
  check(err === 'You already have a preset called "Fast fix"', "the launcher refuses a taken name inline, and says which");
  names = (await invoke(bridge, "list_launch_presets")).map((p) => p.name.toLowerCase());
  check(names.filter((n) => n === "fast fix").length === 1, "nothing was saved under it");
  await pressKeyOnFocus(bridge, "Escape");
  await sleep(300);
  await pickInMenu(bridge, "approval", '[data-mode="plan"]');
  await bridge.click(".task-launcher-save-preset");
  await sleep(300);
  const same = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-preset-same")?.innerText ?? "");`);
  log(`  saving Plan first's combination: ${JSON.stringify(same)}`);
  check(/^Same as (⌘|Ctrl\+)2 Plan first$/.test(same), "saving a combination a preset already is says which one");
  await bridge.screenshot(join(evidenceDir, "02-launcher.png"));
});
