#!/usr/bin/env node
// HOD-everyday-search: plain words find the everyday front door first.
//
//   - "trip": Plan a trip first ("Start here"), then the specialists to
//     narrow to, then the rest in depth sections (Start here, Specific,
//     Advanced), not Check a car before a road trip.
//   - "plan a 5-day trip to lisbon": not "0 results". Plan a trip first,
//     and its first question already holds Lisbon and 5 days (the words of
//     the search it did not use).
//   - "diet": Eat healthier first, with the health label on the card and the
//     health note in its detail.
//
// Negative control: the build before the everyday work lists Check a car
// before a road trip first for "trip" and has nothing for the Lisbon
// sentence, so the checks fail there.

import { join } from "node:path";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { libraryState, openLibrary, typeValue } from "../library-steps.mjs";

const NAME = "HOD-everyday-search";

/** Types a query and waits until the page answers it (results or the empty note). */
async function ask(bridge, query) {
  await typeValue(bridge, ".lib-search-input", query);
  await bridge.waitFor(
    `the answer to "${query}"`,
    `
    if (e2e.first('[data-testid="library-view"]')?.getAttribute("data-answered") !== ${JSON.stringify(query)}) return false;
    const res = e2e.first('[data-testid="library-results"]');
    if (!res) return false;
    if (res.querySelector(".lib-results-head .lib-muted")?.innerText.match(/search/i)) return false;
    return true;
  `,
    { timeoutMs: 20_000 },
  );
  await sleep(300);
  return libraryState(bridge);
}

/** The first thing the results show: the title match, the front door, then the rows. */
const firstShown = (st) => st.exact ?? st.front ?? st.rows[0] ?? null;

await runLauncherQa(
  NAME,
  async ({ bridge, log, check, evidenceDir }) => {
    await openLibrary(bridge);

    const trip = await ask(bridge, "trip");
    log(`  trip: first ${firstShown(trip)}; refine ${trip.refine.join(", ")}; rows ${trip.rows.slice(0, 5).join(", ")}; sections ${trip.sections.join(", ")}`);
    await bridge.screenshot(join(evidenceDir, "01-search-trip.png"));
    check(firstShown(trip) === "plan-a-trip", `"trip" shows Plan a trip first (got ${firstShown(trip)})`);
    check(trip.refine.length > 0, `then the specialists to narrow to (${trip.refine.length})`);
    check(trip.sections[0] === "basic", `and the rest in depth sections, Start here first (${trip.sections.join(", ")})`);

    const lisbon = await ask(bridge, "plan a 5-day trip to lisbon");
    await bridge
      .waitFor("Lisbon in the front door's first question", `return [...e2e.all(".lib-detail .lib-field input, .lib-detail .lib-field textarea")].some((f) => /Lisbon/.test(f.value));`, { timeoutMs: 15_000 })
      .catch(() => null);
    const filled = await libraryState(bridge);
    log(`  lisbon: first ${firstShown(lisbon)}; total "${lisbon.total}"; rows ${lisbon.rows.length}; detail ${filled.detail}; args ${JSON.stringify(filled.args)}`);
    await bridge.screenshot(join(evidenceDir, "02-search-lisbon.png"));
    check(lisbon.rows.length > 0 || !!lisbon.front, "a whole sentence is not 0 results");
    check(firstShown(lisbon) === "plan-a-trip", `Plan a trip comes first (got ${firstShown(lisbon)})`);
    check(filled.detail === "plan-a-trip" && Object.values(filled.args).some((v) => /Lisbon/.test(v) && /5 days/.test(v)), `its questions hold Lisbon and 5 days from the search (${JSON.stringify(filled.args)})`);

    const diet = await ask(bridge, "diet");
    await bridge.waitFor("the health note", `return !!e2e.first(".lib-carebox");`, { timeoutMs: 15_000 }).catch(() => null);
    const dietSt = await libraryState(bridge);
    log(`  diet: first ${firstShown(diet)}; care ${diet.frontCare}; carebox ${dietSt.carebox}; rows ${diet.rows.slice(0, 5).join(", ")}`);
    await bridge.screenshot(join(evidenceDir, "03-search-diet.png"));
    check(firstShown(diet) === "eat-healthier", `"diet" shows Eat healthier first (got ${firstShown(diet)})`);
    check(diet.frontCare === "health", "with the health label");
    check(dietSt.carebox === "health", "and the health note in its detail");
  },
  { tag: "hod-everyday-search" },
);
