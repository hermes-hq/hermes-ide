#!/usr/bin/env node
// Scenario UI-focus-ring: the one focus ring reaches the controls of the
// screens that exist today, on the REAL app, in the real cascade order.
//
// The global rule in base.css (:focus-visible { outline: 2px solid … }) has
// the lowest specificity there is, and the stylesheets of lazily loaded
// screens land after it. So an `outline: none` in a more specific rule, or
// in one of those late stylesheets, silently takes the ring away again.
// This walks the screens where that happened and checks every control:
//
//   - the three-step welcome (fresh install, real flag defaults): the agent
//     check, the repository step (its path field) and the first-task step
//     (the task launcher's fields, a late stylesheet);
//   - every Settings tab, including the command-prefix chips of AI Agent;
//   - controls that need an agent session or a panel to appear (model and
//     effort picker rows, the New Session prefix chips, the notes sheet,
//     the prompt composer, role/style creators, new-project and command
//     search fields): built with the app's own class names inside the
//     running app, so the app's stylesheets style them;
//   - a focused button keeps its own box-shadow (the ring adds an outline,
//     it does not reset shadows);
//   - with real OS key presses (CI runners, Linux and Windows): Tab in
//     Settings moves focus, :focus-visible matches for real, and the focused
//     control draws the ring.
//
// Focus: the test window is not focused locally, so :focus-visible does not
// match on its own. Each stylesheet's :focus and :focus-visible rules are
// copied right after themselves with the pseudo-class replaced by an
// attribute (same sheet, same place, same specificity), and a control is
// "focused" by setting that attribute. The cascade is the app's own.
//
// Negative controls (must end in RESULT: FAIL):
//   HERMES_E2E_UIFOCUS_SUPPRESS=1   adds `outline: none` to the repository
//                                   field, the prefix chips and the picker
//                                   rows, the way the old rules did.
//   Running against a build from before the fix (HERMES_E2E_OUT pointing at
//   it) fails on the same controls.
//
//   node e2e/app/scenarios/UI-focus-ring.mjs

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { osKeysAvailable, pressChords } from "../os-keys.mjs";

const SCENARIO = "UI-focus-ring";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const SUPPRESS = process.env.HERMES_E2E_UIFOCUS_SUPPRESS === "1";
const OS_KEYS = process.env.HERMES_E2E_OS_KEYS === "1";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** A per-control check: logged, and the run goes on so one log lists every miss. */
const problems = [];
function check(condition, message) {
  if (condition) log(`  ok — ${message}`);
  else {
    log(`  FAILED — ${message}`);
    problems.push(message);
  }
}

// The agent check looks for CLIs in this empty folder only (a test-build
// override), so no agent installed on the machine is ever run.
const noAgents = mkdtempSync(join(tmpdir(), "hermes-e2e-uifocus-agents-"));
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-uifocus-home-"));

/** In-page helpers: the simulated focus and the probe. */
const PAGE = String.raw`
window.__uiFocus = window.__uiFocus || (() => {
  const done = new WeakSet();
  const selectors = new Set();
  const focusOnly = (sel) => sel.split(",").map((s) => s.trim())
    .filter((s) => /:focus(-visible)?(?![-\w])/.test(s) && !/:not\([^)]*:focus/.test(s))
    .map((s) => s.replace(/:focus-visible/g, "[data-simfocus]").replace(/:focus(?![-\w])/g, "[data-simfocus]"))
    .join(", ");
  const walk = (holder) => {
    const rules = holder.cssRules;
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r instanceof CSSStyleRule) {
        for (const s of r.selectorText.split(",")) selectors.add(s.trim());
        const copy = focusOnly(r.selectorText);
        if (copy) { try { holder.insertRule(copy + " { " + r.style.cssText + " }", i + 1); } catch (e) { /* not a selector this engine takes */ } }
      } else if (r.cssRules && !(r instanceof CSSKeyframesRule)) walk(r);
    }
  };
  return {
    /** Copy the focus rules of every stylesheet not seen yet (lazy screens add sheets). */
    install() {
      let n = 0;
      for (const sh of document.styleSheets) {
        if (done.has(sh)) continue;
        try { sh.cssRules; } catch (e) { continue; }
        done.add(sh);
        walk(sh);
        n++;
      }
      if (!document.querySelector("style[data-uifocus-still]")) {
        const st = document.createElement("style");
        st.dataset.uifocusStill = "";
        st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
        document.head.appendChild(st);
        done.add(st.sheet);
      }
      return n;
    },
    hasRuleFor(cls) { return [...selectors].some((s) => s.includes(cls)); },
    probe(root) {
      const els = [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"], [role="tab"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !el.disabled && el.type !== "hidden";
      });
      return els.map((el) => {
        el.setAttribute("data-simfocus", "");
        const cs = getComputedStyle(el);
        const out = { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0, colour: cs.outlineColor };
        el.removeAttribute("data-simfocus");
        const name = (el.getAttribute("aria-label") || el.innerText || el.placeholder || el.value || "").trim().replace(/\s+/g, " ").slice(0, 30);
        const ring = out.style === "solid" && out.width >= 2 && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(out.colour);
        return { what: el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""), name, ring, outline: out.style + " " + out.width + "px" };
      });
    },
  };
})();
`;

async function probe(bridge, where, rootSelector, { min = 1 } = {}) {
  const installed = await bridge.eval(`${PAGE}; return window.__uiFocus.install();`);
  const rows = await bridge.eval(`${PAGE}; const root = e2e.must(e2e.first(${JSON.stringify(rootSelector)}), ${JSON.stringify(rootSelector)}); return window.__uiFocus.probe(root);`);
  const without = rows.filter((r) => !r.ring);
  log(`  ${where}: ${rows.length} controls, ${rows.length - without.length} with the ring${installed ? ` (${installed} new stylesheet(s) walked)` : ""}`);
  for (const r of without) log(`    NO RING  ${r.what} "${r.name}" (outline ${r.outline})`);
  assert(rows.length >= min, `${where}: there are controls to check (${rows.length} ≥ ${min})`);
  return without;
}

// Controls that need an agent session or a panel open to appear. Built with
// the app's own classes inside the running app; each class must have a rule
// in the loaded stylesheets, or the check would prove nothing.
const BUILT = [
  { cls: "model-picker-item", html: '<button type="button" class="model-picker-item">Sonnet</button>' },
  { cls: "effort-picker-item", html: '<button type="button" class="effort-picker-item">high</button>' },
  // The New Session prefix chips are the control set's chips now.
  { cls: "h-chip-button", html: '<span class="h-chip h-chip--md h-chip--interactive"><button type="button" class="h-chip-button session-creator-prefix-chip">nice</button></span>' },
  { cls: "workbench-notes-textarea", html: '<textarea class="workbench-notes-textarea" aria-label="Notes"></textarea>' },
  { cls: "prompt-composer-field", html: '<div class="prompt-composer-field"><textarea aria-label="Prompt"></textarea></div>' },
  { cls: "role-selector-create-field", html: '<div class="role-selector-create-field"><input aria-label="Role name"><textarea aria-label="Role prompt"></textarea></div>' },
  { cls: "style-selector-create-field", html: '<div class="style-selector-create-field"><input aria-label="Style name"></div>' },
  { cls: "session-list-new-project-input", html: '<div class="session-list-new-project-input"><input aria-label="Project name"></div>' },
  { cls: "commands-popover-search", html: '<div class="commands-popover-search"><input aria-label="Search commands"></div>' },
];

let app;
let failed = false;
const details = { suppress: SUPPRESS, realKeys: null };

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   real key presses: ${OS_KEYS ? "yes" : "no"}${SUPPRESS ? "   NEGATIVE CONTROL (outline: none added back)" : ""}`);
  if (OS_KEYS && !osKeysAvailable()) throw new Error("HERMES_E2E_OS_KEYS=1 needs a Linux or Windows CI runner (CI=true); never on macOS");

  const runDir = join(evidenceDir, "run-1");
  const common = { runDir, log, flagDefaults: null, env: { HERMES_E2E_AGENT_PATH: noAgents } };
  app = await (onWindows ? launchApp({ ...common, home: "real", resetData: true }) : launchApp({ ...common, home: "private", homeDir }));
  const { bridge } = app;

  if (SUPPRESS) {
    await bridge.eval(`
      const st = document.createElement("style");
      st.textContent = ".setup-repo-input:focus, .settings-agent-prefix-chip:focus-visible, .model-picker-item:focus-visible { outline: none; }";
      document.head.appendChild(st);
      return true;
    `);
    log("  NEGATIVE CONTROL: outline: none added to the repository field, the prefix chips and the model picker rows");
  }

  const missing = [];

  log("step 1: the three-step welcome (a fresh install, the real flag defaults)");
  await bridge.waitFor("the three-step welcome", `return !!e2e.first(".setup-dialog");`, { timeoutMs: 30_000 });
  await sleep(500);
  missing.push(...(await probe(bridge, "welcome: agents", ".setup-dialog", { min: 3 })));
  await bridge.click("#setup-policy-accept");
  await bridge.waitFor("Continue to be enabled", `return !e2e.first(".setup-continue").disabled;`);
  await bridge.click(".setup-continue");
  await bridge.waitFor("the repository step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
  await sleep(300);
  const repoMissing = await probe(bridge, "welcome: repository", ".setup-dialog", { min: 3 });
  missing.push(...repoMissing);
  check(!repoMissing.some((r) => r.what.includes("setup-repo-input")), "the repository path field shows the ring");
  await bridge.click(".setup-skip");
  await bridge.waitFor("the first-task step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task" && !!e2e.first(".setup-dialog .task-launcher-task");`, { timeoutMs: 20_000 });
  await sleep(500);
  const taskMissing = await probe(bridge, "welcome: first task (task launcher)", ".setup-dialog", { min: 4 });
  missing.push(...taskMissing);
  check(!taskMissing.some((r) => /task-launcher/.test(r.what) || /^(input|select|textarea)/.test(r.what)), "the task launcher's task, repository and agent fields show the ring");
  await bridge.screenshot(join(evidenceDir, "01-first-task.png"));
  await bridge.click(".setup-finish");
  await bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop, .setup-pill");`, { timeoutMs: 20_000 });
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }

  log("step 2: every Settings tab");
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await sleep(400);
  const tabs = await bridge.eval(`return e2e.all(".settings-tab").map((el) => e2e.norm(el.innerText));`);
  assert(tabs.length >= 8, `Settings has its tabs (${tabs.join(", ")})`);
  for (const [i, name] of tabs.entries()) {
    await bridge.eval(`return e2e.click(e2e.all(".settings-tab")[${i}]);`);
    await sleep(400);
    const m = await probe(bridge, `Settings > ${name}`, '[role="dialog"]', { min: 2 });
    missing.push(...m);
    if (name === "AI Agent") {
      const chips = await bridge.eval(`return e2e.all(".settings-agent-prefix-chip").length;`);
      check(chips > 0 && !m.some((r) => r.what.includes("settings-agent-prefix-chip")), `the ${chips} command-prefix chips show the ring`);
    }
  }

  log("step 3: real keyboard focus (Tab) in Settings");
  if (OS_KEYS) {
    const at = await bridge.eval(`
      const r = e2e.must(e2e.first(".settings-title"), "settings title").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 };
    `);
    await bridge.eval(`document.activeElement?.blur(); return true;`);
    const diag = await pressChords(app.child.pid, ["tab"], { clickAt: at });
    log(`  real key presses sent: ${JSON.stringify(diag)}`);
    const real = await bridge.waitFor("focus on a control after Tab", `
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { hasFocus: document.hasFocus(), inDialog: !!el.closest('[role="dialog"]'), focusVisible: el.matches(":focus-visible"), what: el.tagName.toLowerCase() + "." + String(el.className).trim().split(/\\s+/).join("."), outline: cs.outlineStyle + " " + (parseFloat(cs.outlineWidth) || 0) + "px" };
    `, { timeoutMs: 10_000 });
    details.realKeys = real;
    log(`  after Tab: ${JSON.stringify(real)}`);
    assert(real.hasFocus && real.inDialog, "the app window has keyboard focus and Tab moved it onto a Settings control");
    assert(real.focusVisible, `the real :focus-visible matches on ${real.what}`);
    assert(/^solid [2-9]/.test(real.outline), `the control focused with Tab draws the solid ring (${real.outline})`);
    await bridge.screenshot(join(evidenceDir, "02-real-tab-focus.png"));
  } else {
    log(`  skipped here: real key presses run only on Linux and Windows CI runners (this is ${platform()}${OS_KEYS ? "" : ", HERMES_E2E_OS_KEYS unset"})`);
  }

  log("step 4: controls that need an agent session or a panel, built inside the app");
  await bridge.eval(`${PAGE}; window.__uiFocus.install(); return true;`);
  const unstyled = await bridge.eval(`${PAGE}; return ${JSON.stringify(BUILT.map((b) => b.cls))}.filter((c) => !window.__uiFocus.hasRuleFor("." + c));`);
  assert(unstyled.length === 0, `every built control has its stylesheet loaded${unstyled.length ? ` (missing: ${unstyled.join(", ")})` : ""}`);
  await bridge.eval(`
    const host = document.createElement("div");
    host.id = "uifocus-built";
    host.style.cssText = "position:fixed;left:0;bottom:0;display:flex;gap:8px;padding:8px;z-index:99999;background:var(--bg-1)";
    host.innerHTML = ${JSON.stringify(BUILT.map((b) => b.html).join(""))};
    document.body.appendChild(host);
    return true;
  `);
  missing.push(...(await probe(bridge, "built controls", "#uifocus-built", { min: BUILT.length })));
  await bridge.eval(`document.getElementById("uifocus-built")?.remove(); return true;`);

  log("step 5: a focused button keeps its own shadow (the ring does not reset box-shadow)");
  const shadows = await bridge.eval(`
    const out = [];
    for (const cls of ["session-composer-send-btn", "whatsnew-btn-primary"]) {
      if (!window.__uiFocus.hasRuleFor("." + cls)) { out.push({ cls, missing: true }); continue; }
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = "Send";
      document.body.appendChild(b);
      const before = getComputedStyle(b).boxShadow;
      b.setAttribute("data-simfocus", "");
      const focused = getComputedStyle(b).boxShadow;
      const cs = getComputedStyle(b);
      out.push({ cls, before, focused, ring: cs.outlineStyle + " " + (parseFloat(cs.outlineWidth) || 0) + "px" });
      b.remove();
    }
    return out;
  `);
  for (const s of shadows) {
    log(`  .${s.cls}: ${s.missing ? "no rule loaded" : `shadow "${s.before}" → focused "${s.focused}", outline ${s.ring}`}`);
    check(!s.missing && s.before !== "none" && s.focused === s.before && /^solid [2-9]/.test(s.ring), `.${s.cls} keeps its shadow and draws the ring when focused`);
  }

  assert(missing.length === 0 && problems.length === 0, `every control checked draws the focus ring (${missing.length} without it, ${problems.length} check(s) failed)`);
} catch (e) {
  failed = true;
  log(`ERROR: ${e.stack || e.message}`);
  if (app) {
    try {
      await app.bridge.screenshot(join(evidenceDir, "zz-failure.png"));
    } catch {
      // no picture
    }
  }
} finally {
  if (app) await app.stop();
  rmSync(noAgents, { recursive: true, force: true });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details });
