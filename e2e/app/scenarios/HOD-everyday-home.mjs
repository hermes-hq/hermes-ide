#!/usr/bin/env node
// HOD-everyday-home: a new user's Library starts from everyday needs.
//
//   - A fresh install (no profile, no project, nothing used) opens the
//     Library on "What do you want to do?" over the Essentials: the
//     catalog's front doors (Plan a trip, Eat healthier, Write an email…),
//     not twelve developer prompts or an alphabetical first page. Health
//     front doors carry their advice label.
//   - The intent row narrows them ("Plan" keeps Plan a trip, drops Write an
//     email); "Browse everything" groups the domains (Everyday life first)
//     and a domain opens on its categories.
//   - The "Personalised on this computer from…" strip does not claim
//     anything personal when nothing personal is known.
//
// Negative control: the build before the everyday work has no Essentials
// section, so the first check fails there.

import { join } from "node:path";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { libraryState, openLibrary } from "../library-steps.mjs";

const NAME = "HOD-everyday-home";
const DOORS = ["plan-a-trip", "eat-healthier", "write-an-email"];

await runLauncherQa(
  NAME,
  async ({ bridge, log, check, evidenceDir }) => {
    await openLibrary(bridge);
    await bridge
      .waitFor("the Essentials", `return e2e.all('[data-testid="library-essentials"] .lib-card').length > 0;`, { timeoutMs: 30_000 })
      .catch(() => null);
    await sleep(400);
    const st = await libraryState(bridge);
    await bridge.screenshot(join(evidenceDir, "01-home-essentials.png"));
    const ids = st.essentials.map((c) => c.id);
    log(`  essentials (${ids.length}): ${ids.join(", ")}`);
    log(`  shelves: ${st.shelves.map((s) => `${s.id}(${s.cards.length})`).join(", ")}`);
    check(ids.length >= 8 && ids.length <= 24, `a new user's home shows the Essentials (${ids.length} front doors)`);
    check(DOORS.every((d) => ids.includes(d)), `with the everyday front doors (${DOORS.join(", ")})`);
    check(st.essentials.find((c) => c.id === "eat-healthier")?.care === "health", "Eat healthier carries the health label");
    const title = await bridge.eval(`return e2e.norm(e2e.first(".lib-ask-title")?.innerText ?? "");`);
    check(title === "What do you want to do?", `the ask box leads the page ("${title}")`);
    const strip = await bridge.eval(`return e2e.norm(e2e.first(".lib-context")?.innerText ?? "");`);
    check(!/Personalised/.test(strip), `nothing claims to be personal with nothing known ("${strip}")`);

    // The intent row narrows the Essentials.
    await bridge.click('.lib-intent[data-intent="plan"]');
    await sleep(300);
    const plan = (await libraryState(bridge)).essentials.map((c) => c.id);
    log(`  Plan: ${plan.join(", ")}`);
    check(plan.includes("plan-a-trip") && !plan.includes("write-an-email") && plan.length < ids.length, "Plan narrows them to planning front doors");
    await bridge.screenshot(join(evidenceDir, "02-home-plan.png"));
    await bridge.click('.lib-intent[data-intent="plan"]');

    // Browse everything: grouped domains, categories inside.
    const groups = await bridge.eval(`return e2e.all(".lib-browse-group").map((g) => g.getAttribute("data-group"));`);
    log(`  browse groups: ${groups.join(", ")}`);
    check(groups[0] === "everyday", "Browse everything starts with Everyday life");
    await bridge.click('.lib-domain[data-domain="travel"]');
    await bridge.waitFor("the travel categories", `return e2e.all(".lib-category[data-category]").length > 0;`, { timeoutMs: 10_000 });
    const cats = await bridge.eval(`return e2e.all(".lib-category[data-category]").map((c) => c.getAttribute("data-category"));`);
    log(`  travel categories: ${cats.join(", ")}`);
    check(cats.length > 0, `a domain opens on its categories (${cats.length})`);
    await bridge.eval(`e2e.first(".lib-category[data-category]")?.scrollIntoView({ block: "center" }); return true;`);
    await bridge.screenshot(join(evidenceDir, "03-home-browse.png"));
  },
  { tag: "hod-everyday-home" },
);
