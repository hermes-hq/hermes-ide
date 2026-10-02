#!/usr/bin/env node
// QA-status-session-rows — eight agents in the sidebar at its default width:
// every row's meta line (status, memory, age, spend) stays inside the row
// (the spend moves to a second line when it does not fit, and is cut with an
// ellipsis and a full tooltip only when it alone is wider than the row), and
// the selected row is never shifted left.
//
//   1. eight fake agents (Claude Code and Codex, two repositories); their
//      spend arrives as usage events: exact, estimated and none (n/a)
//   2. the active row's close button takes the keyboard focus (what pushed
//      the row's content left before)
//   EXPECT, for every row:
//     - nothing in the row is scrolled: its text starts at the row's left
//     - the age (and the memory, when shown) come before the spend
//     - an estimated spend reads "≈$x.xx", without "(estimated)" (the
//       tooltip says it is an estimate)
//     - every meta item is inside the line, and the spend is shown whole at
//       the default width (a cut one would end in an ellipsis, with the
//       line's tooltip holding all of it)
//     - the close button is named "Close session <name>"
//   and the "+ Project" button shows when it has the keyboard focus.
//
// Was broken: the meta line was clipped with no ellipsis (the age and the
// spend disappeared), and the selected row's text was cut at the left.

import { join } from "node:path";
import { emitFromRust } from "../fleet-steps.mjs";
import { runScenario } from "../n11-steps.mjs";
import { sleep, startAgent, startApp } from "../qa-status-steps.mjs";

await runScenario("QA-status-session-rows", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-rows", evidenceDir, log, onCleanup, apps);
  const specs = [
    ["claude", fx.repo, "api: fix login", 1.25, "exact"],
    ["claude", fx.repo, "api: rate limiter", 0.4, "estimated"],
    ["codex", fx.repo, "api: docs", null, null],
    ["claude", fx.otherRepo, "web: dark mode", 3.0, "exact"],
    ["codex", fx.otherRepo, "web: flaky test", 12.34, "estimated"],
    ["claude", fx.otherRepo, "web: i18n", null, null],
    ["claude", fx.repo, "infra: ci cache", 0.07, "estimated"],
    ["claude", fx.otherRepo, "infra: bump deps", 101.5, "exact"],
  ];
  const ids = [];
  for (const [agentId, cwd, label, cost, confidence] of specs) {
    const id = await startAgent(bridge, fx, { agentId, cwd, label }, ids.length + 1);
    ids.push(id);
    if (cost !== null) {
      await emitFromRust(bridge, id, { type: "usage", at: Date.now(), source: `hook:${agentId}`, inputTokens: 120000, outputTokens: 34000, costUsd: cost, confidence });
    }
  }
  await sleep(4000);
  // The active row's close button takes the focus and is scrolled into
  // view, as Tab or a click does (what shifted the row's text left before).
  await bridge.eval(`const b = e2e.first(".session-item-active .session-item-close"); b?.focus(); b?.scrollIntoView({ block: "center", inline: "center" }); e2e.first(".session-item-active .session-age")?.scrollIntoView({ block: "center", inline: "center" }); return true;`);
  await sleep(500);
  // The pointer passes over each meta line (its tooltip is filled in then).
  await bridge.eval(`for (const m of e2e.all(".session-item-meta")) m.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return true;`);
  const rows = await bridge.eval(`
    return e2e.all(".session-item[data-session-item-id]").map((row) => {
      const label = e2e.norm(row.querySelector(".session-item-name, .session-name, [data-session-name]")?.innerText ?? "");
      const info = row.querySelector(".session-item-info");
      const meta = row.querySelector(".session-item-meta");
      const rr = row.getBoundingClientRect(), ir = info.getBoundingClientRect(), mr = meta.getBoundingClientRect();
      const kids = [...meta.children].filter((k) => k.getBoundingClientRect().width > 0);
      const cls = (k) => k.className.toString();
      const index = (re) => kids.findIndex((k) => re.test(cls(k)));
      const spend = meta.querySelector(".session-spend");
      const cs = spend ? getComputedStyle(spend) : null;
      const close = row.querySelector(".session-item-close");
      return {
        id: row.dataset.sessionItemId,
        active: row.classList.contains("session-item-active"),
        scrollLeft: row.scrollLeft,
        infoLeft: Math.round(ir.left - rr.left),
        metaOverflows: meta.scrollWidth > meta.clientWidth + 1,
        metaTitle: meta.getAttribute("title") || "",
        outside: kids.filter((k) => !/session-spend/.test(cls(k)) && k.getBoundingClientRect().right > mr.right + 1).map((k) => cls(k) + "=" + e2e.norm(k.innerText)),
        order: { age: index(/session-age/), memory: index(/memory/), spend: index(/session-spend/) },
        spend: spend ? { text: e2e.norm(spend.innerText), title: spend.getAttribute("title") || "", cut: spend.scrollWidth > spend.clientWidth + 1, ellipsis: cs.textOverflow, overflow: cs.overflowX } : null,
        closeLabel: close?.getAttribute("aria-label") ?? null,
        text: e2e.norm(meta.innerText),
      };
    });`);
  for (const r of rows) log(`  row ${r.id.slice(0, 8)}: ${JSON.stringify(r)}`);
  await bridge.screenshot(join(evidenceDir, "01-rows.png"));
  const labels = Object.fromEntries(specs.map(([, , label], i) => [ids[i], label]));
  assert(rows.length === 8, "eight rows");
  for (const r of rows) {
    const name = labels[r.id];
    assert(r.scrollLeft === 0 && r.infoLeft >= 0, `${name}: the row's content is not shifted left (scrollLeft ${r.scrollLeft}, text at ${r.infoLeft})`);
    assert(r.outside.length === 0, `${name}: every meta item but the spend is inside the line (${JSON.stringify(r.outside)})`);
    assert(r.order.age >= 0 && r.order.spend > r.order.age && (r.order.memory < 0 || r.order.memory < r.order.spend), `${name}: age and memory come before the spend (${JSON.stringify(r.order)})`);
    assert(r.spend && !/\(estimated\)/.test(r.spend.text), `${name}: the spend has no "(estimated)" in the row ("${r.spend?.text}")`);
    assert(!r.spend.cut && r.spend.text.length > 0, `${name}: the spend is shown whole ("${r.spend.text}")`);
    if (r.spend.cut) assert(r.spend.ellipsis === "ellipsis" && r.spend.overflow === "hidden", `${name}: a cut spend ends in an ellipsis`);
    if (r.metaOverflows || r.spend.cut) assert(r.metaTitle.includes(r.spend.text.replace(/…$/, "")), `${name}: the line's tooltip has the whole line ("${r.metaTitle}")`);
    assert(r.closeLabel === `Close session ${name}`, `${name}: the close button is named "${r.closeLabel}"`);
  }
  const estimated = rows.filter((r) => /^≈/.test(r.spend.text));
  assert(estimated.length === 3, `the three estimated spends start with ≈ (${estimated.map((r) => r.spend.text).join(", ")})`);
  assert(estimated.every((r) => /estimated/i.test(r.spend.title)), "their tooltip says the cost is estimated");

  // "+ Project" is offered once a project group exists: put one session in one.
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("update_session_group", { sessionId: ${JSON.stringify(ids[2])}, group: "api" }); return true;`);
  await bridge.waitFor("the + Project button", `return !!e2e.first(".session-item-project-assign");`, { timeoutMs: 10_000 });
  // "+ Project" is hidden until hovered; given the keyboard focus it shows.
  const project = await bridge.eval(`
    const b = e2e.first(".session-item-project-assign");
    if (!b) return null;
    const before = getComputedStyle(b).opacity;
    b.focus();
    await new Promise((r) => setTimeout(r, 400));
    const out = { before, focused: document.activeElement === b, focusVisible: b.matches(":focus-visible"), opacity: getComputedStyle(b).opacity, windowFocused: document.hasFocus() };
    b.blur();
    return out;`);
  log(`  "+ Project" with the keyboard focus: ${JSON.stringify(project)}`);
  assert(project && project.focused, `"+ Project" takes the keyboard focus (${JSON.stringify(project)})`);
  // :focus and :focus-visible match only while the window itself has the
  // system focus; a local run behind other windows cannot check what shows.
  if (project.windowFocused) {
    assert(project.focusVisible, `"+ Project" has the keyboard focus ring state (${JSON.stringify(project)})`);
    assert(project.opacity === "1", `"+ Project" shows when it has the keyboard focus (opacity ${project?.opacity})`);
  } else {
    log("  the window does not have the system focus here: what shows on focus is not checked");
  }
});
