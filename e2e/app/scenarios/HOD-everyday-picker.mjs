#!/usr/bin/env node
// HOD-everyday-picker: Prompts (⌘J) from the task launcher searches with the
// task already typed.
//
//   - ⌘N, type "Plan a 5-day trip to Lisbon in May for two", ⌘J: Prompts
//     opens with that text as its search (not an empty, alphabetical list),
//     Plan a trip is the best match, and its first question holds Lisbon and
//     5 days.
//   - Clearing the search shows the Essentials (front doors), never the A–C
//     window of the catalog.
//
// Negative control: the build before the everyday work opens Prompts with an
// empty search, so the first check fails there.

import { join } from "node:path";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { typeInto, waitLauncherReady } from "../launcher-steps.mjs";
import { typeValue } from "../library-steps.mjs";

const NAME = "HOD-everyday-picker";
const TASK = "Plan a 5-day trip to Lisbon in May for two";

const picker = (bridge) =>
  bridge.eval(`
    return {
      query: e2e.first(".pp-input")?.value ?? null,
      rows: e2e.all(".pp-row").map((e) => e.getAttribute("data-entry")),
      groups: e2e.all(".pp-group").map((e) => e2e.norm(e.innerText)),
      chosen: e2e.first(".pp-pane-inner")?.getAttribute("data-entry") ?? null,
      args: Object.fromEntries(e2e.all("[data-arg]").map((f) => [f.getAttribute("data-arg"), f.querySelector("input, textarea")?.value ?? ""])),
    };
  `);

await runLauncherQa(
  NAME,
  async ({ bridge, log, check, evidenceDir }) => {
    await menuAction(bridge, "file.new-session");
    await waitLauncherReady(bridge);
    if (await bridge.exists(".task-launcher-start-over")) await bridge.click(".task-launcher-start-over");
    await typeInto(bridge, ".task-launcher-task", TASK);
    await menuAction(bridge, "view.prompt-composer");
    await bridge.waitFor("Prompts in the launcher", `return !!e2e.first('[data-testid="prompt-picker"][data-context="launcher"] .pp-input');`, { timeoutMs: 20_000 });
    await bridge.waitFor("the task's results", `return e2e.all(".pp-row").length > 0 && e2e.first(".pp-list")?.getAttribute("data-busy") !== "true";`, { timeoutMs: 20_000 }).catch(() => null);
    await bridge.waitFor("Lisbon in a question", `return e2e.all("[data-arg] input, [data-arg] textarea").some((f) => /Lisbon/.test(f.value));`, { timeoutMs: 15_000 }).catch(() => null);
    const s = await picker(bridge);
    log(`  query "${s.query}"; groups ${s.groups.join(" | ")}; rows ${s.rows.slice(0, 6).join(", ")}; chosen ${s.chosen}; args ${JSON.stringify(s.args)}`);
    await bridge.screenshot(join(evidenceDir, "01-picker-task.png"));
    check(s.query === TASK, `Prompts searches with the launcher's task ("${s.query}")`);
    check(s.rows[0] === "plan-a-trip" && /best match/i.test(s.groups[0] ?? ""), `Plan a trip is the best match (first ${s.rows[0]}, group "${s.groups[0]}")`);
    check(Object.values(s.args).some((v) => /Lisbon/.test(v) && /5 days/.test(v)), `its first question holds Lisbon and 5 days (${JSON.stringify(s.args)})`);

    await typeValue(bridge, ".pp-input", "");
    await bridge.waitFor("the empty-query list", `return e2e.all(".pp-group").some((g) => /essentials/i.test(g.innerText));`, { timeoutMs: 15_000 }).catch(() => null);
    await sleep(300);
    const empty = await picker(bridge);
    log(`  empty: groups ${empty.groups.join(" | ")}; rows ${empty.rows.slice(0, 6).join(", ")}`);
    await bridge.screenshot(join(evidenceDir, "02-picker-empty.png"));
    check(empty.groups.some((g) => /essentials/i.test(g)), "with nothing typed it shows the Essentials");
    check(empty.rows[0] === "plan-a-trip", "the front doors, everyday ones first, not an alphabetical first page");
  },
  { tag: "hod-everyday-picker" },
);
