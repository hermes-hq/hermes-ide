#!/usr/bin/env node
// Scenario (README claim "split-panes"): split the window right and down to
// run sessions side by side, then close a pane and see the split collapse.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/split-panes.mjs
//
// Splits are made the way View ▸ Split Right / Split Down do it (the menu
// sends a "menu-action" event); each split asks for the new pane's session
// with the New Session wizard. Panes are told apart by where they are drawn.

import { join } from "node:path";
import { launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";

const SCENARIO = "split-panes";

/** Pick "plain shell" in the wizard the split opened; returns the new terminal's id. */
async function finishPlainShellWizard(bridge, log) {
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await bridge.waitFor("plain shell selected", `
    const cards = e2e.all(".session-creator-provider-card");
    return cards[cards.length - 1].classList.contains("selected");
  `);
  const before = await bridge.terminalIds();
  for (let i = 0; i < 6; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      ));
    `);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const id = await bridge.waitFor(
    "a new terminal",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  await bridge.waitFor("the shell prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(800);
  log(`  new terminal in the new pane: ${id}`);
  return id;
}

/** Same as choosing the item in the View menu (the native menu sends this event). */
function menuAction(bridge, action) {
  return bridge.eval(`
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: ${JSON.stringify(action)} } });
    return true;
  `);
}

/** Every pane on screen: its session and where it is drawn. */
const PANES = `
  return e2e.all(".split-pane").map((p) => {
    const r = p.getBoundingClientRect();
    return {
      session: p.querySelector("div[data-session-id]")?.getAttribute("data-session-id") ?? null,
      left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
    };
  });
`;

async function runIn(bridge, sessionId, marker) {
  await bridge.typeInTerminal(sessionId, `echo ${marker}\n`);
  await bridge.waitForTerminal(sessionId, new RegExp(`^${marker}$`), { timeoutMs: 20_000 });
}

await runScenario(SCENARIO, async ({ log, assert, apps, evidenceDir }) => {
  log("step 1: launch, finish the welcome, open one plain terminal");
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);
  const first = await createPlainTerminal(bridge, log);
  let panes = await bridge.eval(PANES);
  assert(panes.length === 1 && panes[0].session === first, "one pane, showing the first terminal");
  const full = panes[0];

  log("step 2: View ▸ Split Right, with a new plain terminal in the new pane");
  await menuAction(bridge, "view.split-horizontal");
  const second = await finishPlainShellWizard(bridge, log);
  panes = await bridge.waitFor("two panes, one terminal each", `
    const panes = (() => { ${PANES} })();
    return panes.length === 2 && panes.every((p) => p.session) ? panes : null;
  `);
  log(`  panes: ${JSON.stringify(panes)}`);
  const [left, right] = panes;
  assert(left.session === first && right.session === second, "the first terminal stays in the left pane, the new one is in the right pane");
  assert(Math.abs(left.top - right.top) <= 2, `side by side: both panes start at the same height (${left.top} / ${right.top})`);
  assert(right.left >= left.left + left.width - 2, `the new pane is to the right of the first (${left.left}+${left.width} <= ${right.left})`);
  assert(left.width < full.width * 0.75 && right.width < full.width * 0.75, "each pane got part of the width the single pane had");
  await runIn(bridge, first, "left-pane-ok");
  await runIn(bridge, second, "right-pane-ok");
  assert(!(await bridge.readTerminal(first)).includes("right-pane-ok"), "each pane runs its own session (the left one did not get the right one's command)");
  await bridge.screenshot(join(evidenceDir, "01-split-right.png"));

  log("step 3: View ▸ Split Down on the right pane, with a third terminal");
  await menuAction(bridge, "view.split-vertical");
  const third = await finishPlainShellWizard(bridge, log);
  panes = await bridge.waitFor("three panes, one terminal each", `
    const panes = (() => { ${PANES} })();
    return panes.length === 3 && panes.every((p) => p.session) ? panes : null;
  `);
  log(`  panes: ${JSON.stringify(panes)}`);
  const byId = Object.fromEntries(panes.map((p) => [p.session, p]));
  const [l, top, bottom] = [byId[first], byId[second], byId[third]];
  assert(!!l && !!top && !!bottom, "the three terminals each have a pane");
  assert(Math.abs(top.left - bottom.left) <= 2, `stacked: the split pane and the new one share their left edge (${top.left} / ${bottom.left})`);
  assert(bottom.top >= top.top + top.height - 2, `the new pane is below the one that was split (${top.top}+${top.height} <= ${bottom.top})`);
  assert(top.height < right.height * 0.75 && bottom.height < right.height * 0.75, "the split pane gave up part of its height to the new one");
  assert(Math.abs(l.height - right.height) <= 2 && l.left === left.left, "the left pane is untouched by the split on the right");
  await runIn(bridge, third, "bottom-pane-ok");
  await bridge.screenshot(join(evidenceDir, "02-split-down.png"));

  log("step 4: close the bottom pane with its close button");
  await bridge.clickWhenReady(`
    const pane = e2e.all(".split-pane").find((p) => p.querySelector('div[data-session-id=${JSON.stringify(third)}]'));
    return e2e.click(e2e.must(pane?.querySelector(".split-pane-close"), "the bottom pane's close button"));
  `);
  panes = await bridge.waitFor("the split to collapse back to two panes", `
    const panes = (() => { ${PANES} })();
    return panes.length === 2 ? panes : null;
  `);
  log(`  panes: ${JSON.stringify(panes)}`);
  const after = Object.fromEntries(panes.map((p) => [p.session, p]));
  assert(!after[third], "the closed pane is gone");
  assert(!!after[first] && !!after[second], "the other two panes are still there");
  assert(Math.abs(after[second].height - right.height) <= 2 && Math.abs(after[second].top - right.top) <= 2,
    `the right pane takes the whole height again (${after[second].height} vs ${right.height})`);
  await runIn(bridge, second, "still-running");
  await bridge.screenshot(join(evidenceDir, "03-closed.png"));
});
