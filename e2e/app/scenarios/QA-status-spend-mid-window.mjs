#!/usr/bin/env node
// QA-status-spend-mid-window — between the narrow layout (760 px) and a
// roomy window, the status bar's spend amount is always shown whole: the
// "Open sessions:" words give way first, then the folder name.
//
//   1. two fake agents report what they spent ($1234.56 and $3.00); one of
//      them works in a folder with a long name
//   2. the window is set to 761, 800, 900 and 1000 px wide, in English and
//      in German
//   EXPECT: at every width "$1237.56" is on the bar uncut and inside the
//   window; the words before it and the folder name are what get shortened;
//   the tooltip still says the total covers the open sessions; no control
//   lies outside the window
//
// Was broken: the whole "Open sessions: $1237.56" was cut from the end, so
// at 761 px only "Op…" was left while the folder name and the age stayed.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runScenario } from "../n11-steps.mjs";
import { emitFromRust } from "../fleet-steps.mjs";
import { invoke, sleep, startAgent, startApp } from "../qa-status-steps.mjs";

const offscreen = (bridge) =>
  bridge.eval(`
  return e2e.all("button, a, [role=button], [role=menuitem]").map((el) => ({ n: e2e.nameOf(el).slice(0, 40), r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 0 && (x.r.left < -1 || x.r.right > innerWidth + 1 || x.r.bottom > innerHeight + 1)).map((x) => x.n + " @x=" + Math.round(x.r.left) + ".." + Math.round(x.r.right));`);

const resize = async (bridge, width, height) => {
  await invoke(bridge, "plugin:window|set_size", { label: "main", value: { Logical: { width, height } } });
  await bridge.waitFor(`the window at ${width} px`, `return innerWidth <= ${width} + 2 && innerWidth >= ${width} - 40;`, { timeoutMs: 10_000 });
  await sleep(700);
};

await runScenario("QA-status-spend-mid-window", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-spend-mid", evidenceDir, log, onCleanup, apps);
  const longFolder = join(fx.repo, "services-authentication-gateway-backend");
  mkdirSync(longFolder, { recursive: true });
  const B = await startAgent(bridge, fx, { cwd: fx.otherRepo, label: "web: dark mode" }, 1);
  // Started last, so it is the session in view (its folder is on the bar).
  const A = await startAgent(bridge, fx, { cwd: longFolder, label: "api: fix login" }, 2);
  await sleep(2000);
  const usage = (costUsd) => ({ type: "usage", at: Date.now(), source: "hook:claude", inputTokens: 1000, outputTokens: 2000, costUsd, confidence: "exact" });
  await emitFromRust(bridge, A, usage(1234.56));
  await emitFromRust(bridge, B, usage(3.0));
  await bridge.waitFor("the total on the bar", `return /1237\\.56/.test(e2e.first(".status-bar-cost")?.textContent ?? "");`, { timeoutMs: 10_000 });

  for (const lang of ["en", "de"]) {
    if (lang !== "en") {
      await invoke(bridge, "set_setting", { key: "ui_language", value: lang });
      await bridge.eval(`localStorage.setItem("hermes.ui_language", ${JSON.stringify(lang)}); return true;`);
      await bridge.reload();
      // The reloaded page starts with no usage reports: send them again.
      await bridge.waitFor("the status bar after the reload", `return !!e2e.first(".status-bar-cost");`, { timeoutMs: 30_000 });
      await emitFromRust(bridge, A, usage(1234.56));
      await emitFromRust(bridge, B, usage(3.0));
      await bridge.waitFor("the app after the reload", `return /1237[.,]56/.test(e2e.first(".status-bar-cost")?.textContent ?? "");`, { timeoutMs: 30_000 });
      await sleep(1500);
    }
    for (const w of [761, 800, 900, 1000]) {
      await resize(bridge, w, 600);
      const bar = await bridge.eval(`
        const cost = e2e.first(".status-bar-cost"); const amount = e2e.first(".status-bar-cost-amount");
        const scope = e2e.first(".status-bar-cost-scope"); const cwd = e2e.first(".status-bar-cwd");
        const ar = amount.getBoundingClientRect(); const cr = cost.getBoundingClientRect();
        return { amount: e2e.norm(amount.textContent), amountW: Math.round(ar.width), amountFull: amount.scrollWidth <= amount.clientWidth + 1,
          inCost: ar.left >= cr.left - 1 && ar.right <= cr.right + 1, inWindow: ar.right <= innerWidth,
          scope: scope ? { text: e2e.norm(scope.textContent), w: Math.round(scope.getBoundingClientRect().width) } : null,
          cwd: cwd ? { w: Math.round(cwd.getBoundingClientRect().width), cut: cwd.scrollWidth > cwd.clientWidth + 1 } : null,
          title: cost.getAttribute("title"), innerWidth };`);
      const out = await offscreen(bridge);
      log(`  [${lang} ${w}] ${JSON.stringify(bar)} outside=${JSON.stringify(out)}`);
      await bridge.screenshot(join(evidenceDir, `bar-${lang}-${w}.png`));
      assert(bar.amount === "$1237.56", `[${lang} ${w}] the amount reads $1237.56 (${bar.amount})`);
      assert(bar.amountFull && bar.inCost && bar.inWindow && bar.amountW > 30, `[${lang} ${w}] the amount is shown whole (${JSON.stringify(bar)})`);
      assert(/open sessions|offene Sitzungen/i.test(bar.title), `[${lang} ${w}] the tooltip says it covers the open sessions`);
      assert(out.length === 0, `[${lang} ${w}] every control is inside the window (${JSON.stringify(out)})`);
    }
  }
});
