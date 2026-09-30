#!/usr/bin/env node
// Scenario: UI-dialogs — the dialog long tail on the control set, on the
// REAL app, in Frosted Dark and Frosted Light.
//
// Opened through their real triggers:
//   close-session    a plain terminal's close button in the session list
//   update           an update (window.__HERMES_E2E__.forceUpdateReady) and
//                    the status bar's version chip
//   toast            a session that could not be restored (the app's own
//                    event), whose toast carries an action button
//   project-picker   "+ Add Project" of a terminal pane
//   plugin-manager   Settings > Plugins with a synthetic plugin built for the
//                    old API (the "old API" badge) with a toggle, a select and
//                    a text setting; its Uninstall asks in a confirm dialog
// Opened through the test build's dialog gallery (src/e2e/DialogGallery.tsx:
// the app's own components with synthetic data, for triggers a test run
// cannot make cheaply): quit with working agents, plugin update, what's
// new, handoff, branch in use, uncommitted changes, permission request,
// projects, shortcuts, cost, add MCP server, the startup problem screen,
// branch mismatch, a crashed pane.
//
// For each dialog, in each theme:
//   - every button, select and checkbox inside is a control-set component
//     (no bespoke class-styled control left)
//   - heights: buttons 28/32/36, icon buttons 28/32 and square, fields 28/32,
//     checkboxes 16, toggles 18, tabs 32, chips 24/28, badges 18, counters 16
//   - at most one primary (brass) or confirm danger-solid button, and it is
//     the right-most button of its row
//   - every focusable control draws the solid 2 px ring in --focus-ring at
//     >= 3:1 against what is behind it (the stylesheets' own :focus-visible
//     rules, copied in cascade order onto an attribute, because the test
//     window has no keyboard focus; the log says whether the real
//     :focus-visible matched too)
//   - button and field text >= 4.5:1, field edges >= 3:1 (disabled exempt)
//   - a screenshot
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_UIDIALOGS_BESPOKE=1  adds a class-styled <button> to the
//                                   close dialog before it is measured
//   HERMES_E2E_UIDIALOGS_EXPECT_MD=30  expects 30 px default controls
//   HERMES_E2E_UIDIALOGS_NO_RING=1  sets --focus-ring-width to 0
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/UI-dialogs.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/UI-dialogs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "UI-dialogs";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);

const BESPOKE = process.env.HERMES_E2E_UIDIALOGS_BESPOKE === "1";
const MD = Number(process.env.HERMES_E2E_UIDIALOGS_EXPECT_MD || 32);
const NO_RING = process.env.HERMES_E2E_UIDIALOGS_NO_RING === "1";
const THEMES = [
  ["dark", "frosted-dark"],
  ["light", "frosted-light"],
];
const PLUGIN_ID = "e2e.old-api";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** Per-dialog checks: logged, and the run goes on so one log lists every miss. */
const problems = [];
function check(condition, message) {
  if (condition) log(`  ok — ${message}`);
  else {
    log(`  FAILED — ${message}`);
    problems.push(message);
  }
}

// ─── Synthetic data ──────────────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), "hermes-e2e-uidialogs-"));
const projectDir = join(work, "demo-project");
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# Demo project\n");
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-uidialogs-home-"));

/** A plugin built for the original API (no apiVersion) with one setting of each kind. */
function installPlugin(dataDir) {
  const dir = join(dataDir, "plugins", PLUGIN_ID);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "hermes-plugin.json"),
    JSON.stringify(
      {
        id: PLUGIN_ID,
        name: "Old API sample",
        version: "1.0.0",
        description: `Synthetic plugin for the ${SCENARIO} scenario`,
        author: "Hermes e2e",
        main: "dist/index.js",
        activationEvents: [{ type: "onStartup" }],
        contributes: {
          settings: {
            enabled: { type: "boolean", title: "Show the badge", description: "A setting that is on or off", default: true, order: 1 },
            mode: {
              type: "select",
              title: "Mode",
              default: "fast",
              order: 2,
              options: [
                { value: "fast", label: "Fast" },
                { value: "careful", label: "Careful" },
              ],
            },
            label: { type: "string", title: "Label", default: "demo", order: 3 },
          },
        },
        permissions: ["sessions.read"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "dist", "index.js"),
    `(() => { window.__hermesPlugins = window.__hermesPlugins || {}; window.__hermesPlugins[${JSON.stringify(PLUGIN_ID)}] = { activate() {} }; })();`,
  );
  log(`  installed ${PLUGIN_ID} into the test app's data folder`);
}

// ─── In-page helpers ─────────────────────────────────────────────────

const PAGE = String.raw`
const rgb = (s) => {
  let m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; }
  m = /^color\(srgb ([^)]+)\)$/.exec(s);
  if (m) { const p = m[1].split(/[ \/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] === undefined ? 1 : p[3] }; }
  throw new Error("unreadable colour: " + s);
};
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const backdrop = (el, includeSelf = true) => {
  const layers = [];
  for (let n = includeSelf ? el : el.parentElement; n; n = n.parentElement) {
    const c = rgb(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
  }
  let acc = rgb(getComputedStyle(document.body).backgroundColor);
  for (const c of layers.reverse()) acc = c.a >= 1 ? c : over(c, acc);
  return acc;
};
const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// Each stylesheet's :focus / :focus-visible rules copied right after
// themselves onto [data-simfocus]: same sheet, same place, same specificity.
window.__uiDlgFocus = window.__uiDlgFocus || (() => {
  const done = new WeakSet();
  const focusOnly = (sel) => sel.split(",").map((s) => s.trim())
    .filter((s) => /:focus(-visible)?(?![-\w])/.test(s) && !/:not\([^)]*:focus/.test(s))
    .map((s) => s.replace(/:focus-visible/g, "[data-simfocus]").replace(/:focus(?![-\w])/g, "[data-simfocus]"))
    .join(", ");
  const walk = (holder) => {
    const rules = holder.cssRules;
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r instanceof CSSStyleRule) {
        const copy = focusOnly(r.selectorText);
        if (copy) { try { holder.insertRule(copy + " { " + r.style.cssText + " }", i + 1); } catch (e) { /* not a selector this engine takes */ } }
      } else if (r.cssRules && !(r instanceof CSSKeyframesRule)) walk(r);
    }
  };
  return {
    install() {
      for (const sh of document.styleSheets) {
        if (done.has(sh)) continue;
        try { sh.cssRules; } catch (e) { continue; }
        done.add(sh);
        walk(sh);
      }
      if (!document.querySelector("style[data-uidlg-still]")) {
        const st = document.createElement("style");
        st.dataset.uidlgStill = "";
        st.textContent = "*,*::before,*::after{transition:none!important}";
        document.head.appendChild(st);
        done.add(st.sheet);
      }
    },
  };
})();

const KIT_BUTTON = ".h-btn, .h-icon-btn, .h-segment, .h-tab, .h-toggle, .h-chip-button, .h-chip-remove";
const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
const nameOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.placeholder || el.value || el.className || el.tagName).toString().trim().replace(/\s+/g, " ").slice(0, 40);

window.__uiDlgInspect = (rootSel, opts) => {
  const root = document.querySelector(rootSel);
  if (!root) return { missing: rootSel };
  const inRoot = (sel) => [...root.querySelectorAll(sel)].filter(visible).filter((el) => !(opts.skip && el.closest(opts.skip)));
  const out = { bespoke: [], sizes: [], strong: [], ring: [], contrast: [], realFocus: null, counts: {} };

  // 1. No bespoke control: every button, select and checkbox is the kit's.
  for (const b of inRoot("button")) if (!b.matches(KIT_BUTTON)) out.bespoke.push("button." + String(b.className).trim().replace(/\s+/g, ".") + " " + nameOf(b));
  for (const s of inRoot("select")) if (!s.matches(".h-native-select-field")) out.bespoke.push("select." + String(s.className) + " " + nameOf(s));
  for (const c of [...root.querySelectorAll('input[type="checkbox"]')].filter((el) => !(opts.skip && el.closest(opts.skip)))) {
    if (!c.matches(".h-checkbox")) out.bespoke.push("checkbox." + String(c.className));
  }

  // 2. Heights.
  const h = (el) => +el.getBoundingClientRect().height.toFixed(2);
  const want = (sel, allowed, what, square) => {
    for (const el of inRoot(sel)) {
      const got = h(el);
      const w = +el.getBoundingClientRect().width.toFixed(2);
      out.sizes.push({ what, name: nameOf(el), h: got, ok: allowed.some((a) => Math.abs(a - got) <= 0.5) && (!square || Math.abs(w - got) <= 0.5) });
    }
  };
  const md = opts.md, sm = opts.md - 4, lg = opts.md + 4;
  want(".h-btn:not(.h-btn--link)", [sm, md, lg], "button");
  want(".h-icon-btn", [sm, md], "icon button", true);
  want(".h-input:not(.h-textarea)", [sm, md], "field");
  want(".h-checkbox", [16], "checkbox");
  want(".h-toggle", [18], "toggle");
  want(".h-tab", [md], "tab");
  want(".h-segmented", [sm, md], "segmented");
  want(".h-chip", [24, 28], "chip");
  want(".h-badge", [18], "badge");
  want(".h-counter", [16], "counter");
  for (const k of ["h-btn", "h-icon-btn", "h-input", "h-checkbox", "h-toggle", "h-tab", "h-chip", "h-badge", "h-counter"]) out.counts[k] = inRoot("." + k).length;

  // 3. One strong button, right-most in its row.
  for (const s of inRoot(".h-btn--primary, .h-btn--danger-solid")) {
    const row = [...s.parentElement.children].filter((c) => c.tagName === "BUTTON" && visible(c));
    out.strong.push({ name: nameOf(s), variant: s.matches(".h-btn--primary") ? "primary" : "danger-solid", last: row[row.length - 1] === s });
  }

  // 4. The ring, on every focusable control.
  window.__uiDlgFocus.install();
  const focusables = inRoot('button:not(:disabled), select:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), [role="combobox"], [tabindex="0"]');
  for (const el of focusables) {
    el.setAttribute("data-simfocus", "");
    const cs = getComputedStyle(el);
    const width = parseFloat(cs.outlineWidth) || 0;
    const col = rgb(cs.outlineColor);
    const bg = backdrop(el, false);
    const r = col.a > 0 ? ratio(over(col, bg), bg) : 0;
    out.ring.push({ name: nameOf(el), style: cs.outlineStyle, width, offset: parseFloat(cs.outlineOffset) || 0, colour: hex(col), ratio: +r.toFixed(2) });
    el.removeAttribute("data-simfocus");
  }
  // The real thing, when the window has keyboard focus (CI runners).
  const first = focusables[0];
  if (first) {
    first.focus();
    out.realFocus = { hasFocus: document.hasFocus(), focusVisible: first.matches(":focus-visible"), outline: getComputedStyle(first).outlineStyle + " " + getComputedStyle(first).outlineWidth };
    first.blur();
  }

  // 5. Contrast of text on every enabled button and field, and field edges.
  const text = (el, what) => {
    const bg = backdrop(el);
    const fg = over(rgb(getComputedStyle(el).color), bg);
    out.contrast.push({ what, name: nameOf(el), fg: hex(fg), bg: hex(bg), ratio: +ratio(fg, bg).toFixed(2), min: 4.5 });
  };
  for (const b of inRoot(".h-btn:not(:disabled):not([aria-disabled='true'])")) if ((b.innerText || "").trim()) text(b, "button");
  for (const f of inRoot(".h-input:not(:disabled)")) {
    if ((f.value || f.innerText || "").trim()) text(f, "field text");
    const edge = rgb(getComputedStyle(f).borderTopColor);
    const panel = backdrop(f, false);
    out.contrast.push({ what: "field edge", name: nameOf(f), fg: hex(edge), bg: hex(panel), ratio: +ratio(over(edge, panel), panel).toFixed(2), min: 3 });
  }
  return out;
};
`;

async function inspect(bridge, where, rootSel, opts = {}) {
  await bridge.eval(`${PAGE}; return true;`);
  const r = await bridge.eval(`return window.__uiDlgInspect(${JSON.stringify(rootSel)}, ${JSON.stringify({ md: MD, skip: opts.skip ?? null })});`);
  if (r.missing) {
    check(false, `${where}: ${r.missing} is on screen`);
    return null;
  }
  const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
  log(`  ${where}: ${JSON.stringify(r.counts)}`);
  check(total > 0, `${where}: has control-set controls (${total})`);
  check(r.bespoke.length === 0, `${where}: no bespoke button, select or checkbox${r.bespoke.length ? ` (found ${r.bespoke.join("; ")})` : ""}`);
  const badSizes = r.sizes.filter((s) => !s.ok);
  check(badSizes.length === 0, `${where}: all ${r.sizes.length} controls have their size${badSizes.length ? ` (off: ${badSizes.map((s) => `${s.what} "${s.name}" ${s.h}px`).join("; ")})` : ""}`);
  const strong = r.strong;
  check(strong.length <= (opts.maxStrong ?? 1), `${where}: at most ${opts.maxStrong ?? 1} primary / confirm button (${strong.map((s) => `${s.variant} "${s.name}"`).join(", ") || "none"})`);
  if (opts.strong !== undefined) check(strong.length === 1 && strong[0].variant === opts.strong, `${where}: its ${opts.strong} button is there`);
  check(strong.every((s) => s.last), `${where}: the primary is the right-most button of its row`);
  // Tabs and segments draw the same ring inset (offset -2 px) so their container does not clip it.
  const badRing = r.ring.filter((x) => !(x.style === "solid" && x.width >= 2 && x.offset >= -2 && x.ratio >= 3));
  check(r.ring.length > 0 && badRing.length === 0, `${where}: all ${r.ring.length} focusable controls draw the solid 2 px ring at >= 3:1${badRing.length ? ` (missing on: ${badRing.map((x) => `"${x.name}" ${x.style} ${x.width}px ${x.ratio}:1`).join("; ")})` : ""}`);
  if (r.realFocus) log(`  real focus: window has focus=${r.realFocus.hasFocus}, :focus-visible=${r.realFocus.focusVisible}, outline "${r.realFocus.outline}"`);
  if (r.realFocus?.focusVisible) check(r.realFocus.outline.startsWith("solid 2"), `${where}: real keyboard focus draws the ring too`);
  const low = r.contrast.filter((c) => !(c.ratio >= c.min));
  const lowest = r.contrast.length ? Math.min(...r.contrast.map((c) => c.ratio)) : null;
  check(low.length === 0, `${where}: ${r.contrast.length} text/edge pairs meet 4.5:1 / 3:1 (lowest ${lowest}:1)${low.length ? ` (low: ${low.map((c) => `${c.what} "${c.name}" ${c.fg} on ${c.bg} = ${c.ratio}`).join("; ")})` : ""}`);
  return r;
}

async function setTheme(bridge, id) {
  await bridge.eval(`document.documentElement.dataset.theme = ${JSON.stringify(id)}; return true;`);
  await sleep(250);
}

/** Screenshots and checks one dialog in both themes; `open` shows it, `close` hides it. */
async function eachTheme(bridge, name, rootSel, opts = {}) {
  for (const [label, id] of THEMES) {
    await setTheme(bridge, id);
    if (opts.before) await opts.before(bridge);
    await bridge.settle();
    await bridge.screenshot(join(evidenceDir, `${name}-${label}.png`));
    await inspect(bridge, `${name} (${label})`, rootSel, opts);
  }
}

async function returningUser(bridge) {
  // Skip the first-launch welcome the way a returning user's data does.
  await bridge.eval(`
    await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "onboarding_completed", value: "true" });
    setTimeout(() => location.reload(), 50);
    return true;
  `);
  await sleep(1500);
  await bridge.waitFor(
    "the app UI after the reload",
    `return document.readyState === "complete" && !!window.__HERMES_E2E__ && !e2e.first(".onboarding-backdrop, .onboarding-dialog");`,
    { timeoutMs: 30_000 },
  );
  await sleep(500);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.clickByName("Got it");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   expect md=${MD}px   bespoke control=${BESPOKE}   no ring=${NO_RING}`);
  app = await launchApp({
    runDir: join(evidenceDir, "run"),
    log,
    home: onWindows ? "real" : "private",
    homeDir,
    prepareDataDir: installPlugin,
  });
  const { bridge } = app;
  await returningUser(bridge);
  if (NO_RING) {
    await bridge.eval(`document.documentElement.style.setProperty("--focus-ring-width", "0px"); return true;`);
    log("  NEGATIVE CONTROL: --focus-ring-width forced to 0px");
  }

  log("step 1: a plain terminal, then its close button: the close-session dialog");
  const sessionId = await bridge.eval(`return await window.__HERMES_E2E__.newTerminal({ label: "Dialogs demo", cwd: ${JSON.stringify(projectDir)} });`, { timeoutMs: 30_000 });
  assert(!!sessionId, `a terminal session was created (${sessionId})`);
  await bridge.waitFor("the session row", `return e2e.all(".session-item").length === 1;`, { timeoutMs: 20_000 });
  const openClose = async () => {
    await bridge.clickWhenReady(`
      const row = e2e.must(e2e.first(".session-item"), "the session row");
      const b = [...row.querySelectorAll("button")].find((x) => /close/i.test(x.getAttribute("aria-label") || x.title || ""));
      return e2e.click(e2e.must(b, "the session's close button"));
    `);
    await bridge.waitFor("the close dialog", `return !!e2e.first(".close-dialog");`);
    if (BESPOKE) {
      await bridge.eval(`
        const b = document.createElement("button");
        b.className = "close-dialog-btn legacy";
        b.textContent = "Legacy";
        document.querySelector(".close-dialog-actions").prepend(b);
        return true;
      `);
      log("  NEGATIVE CONTROL: a bespoke class-styled button added to the close dialog");
    }
  };
  await openClose();
  await eachTheme(bridge, "close-session", ".close-dialog", { strong: "danger-solid" });
  await bridge.clickByName("Cancel", { within: ".close-dialog" });
  await bridge.waitFor("the close dialog to close", `return !e2e.first(".close-dialog");`);
  assert((await bridge.eval(`return e2e.all(".session-item").length;`)) === 1, "Cancel kept the session");

  log("step 2: the project picker from the pane's + Add Project, scanning a folder");
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".split-pane")?.querySelector(".scope-bar-add"), "+ Add Project"));`);
  await bridge.waitFor("the project picker", `return !!e2e.first(".project-picker");`);
  await bridge.eval(`
    const input = e2e.must(e2e.first(".project-picker-scan-input"), "folder field");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(projectDir)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  await bridge.waitFor("the scanned project in the list", `return e2e.all(".project-picker-item").some((el) => el.innerText.includes("demo-project"));`, { timeoutMs: 20_000 });
  await eachTheme(bridge, "project-picker", ".project-picker", { strong: "primary" });
  await bridge.clickByName("Done", { within: ".project-picker-footer" });
  await bridge.waitFor("the project picker to close", `return !e2e.first(".project-picker");`);

  log("step 3: an update, opened from the status bar's version chip");
  await bridge.eval(`window.__HERMES_E2E__.forceUpdateReady("99.0.0", "A synthetic update for the dialog check"); return true;`);
  await bridge.click(".status-version-chip");
  await bridge.waitFor("the update dialog", `return !!e2e.first(".update-dialog");`, { timeoutMs: 10_000 });
  await eachTheme(bridge, "update", ".update-dialog", { strong: "primary" });
  await bridge.clickByName("Later", { within: ".update-dialog-actions" });
  await bridge.waitFor("the update dialog to close", `return !e2e.first(".update-dialog");`);

  log("step 4: a toast with an action (a session that could not be restored)");
  await bridge.eval(`
    window.dispatchEvent(new CustomEvent("hermes:session-restore-failed", { detail: { id: "e2e-missing", label: "Old session", error: "its folder is gone" } }));
    return true;
  `);
  await bridge.waitFor("the toast", `return e2e.all(".toast").some((t) => t.querySelector(".toast-actions"));`);
  await eachTheme(bridge, "toast", ".toast-container");
  await bridge.clickByName("Close", { within: ".toast-container" });
  await bridge.waitFor("the toast to go", `return !e2e.first(".toast-actions");`);

  log("step 5: Settings > Plugins: tabs, counters, the old-API badge, a plugin's settings, the uninstall confirm");
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"]') && e2e.all('[role="tab"], .settings-tab').length > 0;`);
  await bridge.clickWhenReady(`
    const tab = e2e.all('[role="tab"], .settings-tab').find((el) => e2e.norm(el.innerText) === "Plugins");
    return e2e.click(e2e.must(tab, "Plugins tab"));
  `);
  await bridge.waitFor("the synthetic plugin's row", `return !!document.querySelector('[data-plugin-row="${PLUGIN_ID}"] .pm-row');`, { timeoutMs: 20_000 });
  const badges = await bridge.eval(`return [...document.querySelectorAll('[data-plugin-row="${PLUGIN_ID}"] .pm-row-badges .h-badge')].map((b) => ({ text: e2e.norm(b.textContent), cls: b.className, h: b.getBoundingClientRect().height }));`);
  log(`  badges: ${JSON.stringify(badges)}`);
  check(badges.some((b) => /old api/i.test(b.text) && /h-badge--warning/.test(b.cls)), `the plugin built for the old API wears the "old API" warning badge`);
  await bridge.click(`[data-plugin-row="${PLUGIN_ID}"] .pm-row-info`);
  await bridge.waitFor("its details and settings", `return !!document.querySelector('[data-plugin-row="${PLUGIN_ID}"] .pm-detail .ps-form [role="switch"]');`, { timeoutMs: 15_000 });
  await eachTheme(bridge, "plugin-manager", ".pm");
  const tabs = await bridge.eval(`return e2e.all('.pm [role="tab"]').map((t) => ({ name: e2e.norm(t.querySelector(".h-tab-label")?.innerText), selected: t.getAttribute("aria-selected") }));`);
  check(tabs.length === 2 && tabs[0].selected === "true", `the Installed / Browse tabs are the kit's tabs (${JSON.stringify(tabs)})`);
  await bridge.clickByName("Uninstall", { within: `[data-plugin-row="${PLUGIN_ID}"]` });
  await bridge.waitFor("the uninstall confirm", `return !!e2e.first(".pm-confirm-dialog");`);
  await eachTheme(bridge, "plugin-uninstall-confirm", ".pm-confirm-dialog", { strong: "danger-solid" });
  await bridge.clickByName("Cancel", { within: ".pm-confirm-dialog" });
  await bridge.waitFor("the confirm to close", `return !e2e.first(".pm-confirm-dialog");`);
  assert(await bridge.exists(`[data-plugin-row="${PLUGIN_ID}"]`), "Cancel kept the plugin");
  await bridge.eval(`
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector(".pm"));
    const close = [...(dlg || document).querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "Close" && !b.closest(".pm"));
    if (close) close.click(); else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  `);
  await bridge.waitFor("Settings to close", `return !e2e.first(".pm");`);

  log("step 6: the dialogs whose real trigger needs more than a test run can make (the app's components, synthetic data)");
  const gallery = [
    ["quit-with-agents", ".quit-dialog", { strong: "primary" }],
    ["plugin-update", ".puc-dialog", { strong: "primary" }],
    ["whats-new", ".whatsnew-dialog", { strong: "primary" }],
    ["handoff", ".handoff-modal", { strong: "primary" }],
    ["branch-conflict", ".branch-conflict-modal", { strong: "primary" }],
    ["dirty-worktree", ".dirty-wt-modal", { strong: "primary" }],
    ["permission-request", ".perm-modal", { strong: "primary" }],
    ["workspace", ".workspace-panel", { strong: "primary" }],
    ["shortcuts", ".shortcuts-panel", {}],
    ["cost", ".cost-dashboard", {}],
    ["add-mcp", ".add-mcp-card", { strong: "primary" }],
    ["startup-problem", ".startup-problem-card", { strong: "primary" }],
    ["branch-mismatch", ".branch-mismatch-alert", {}],
    ["pane-crash", ".contained-error", { strong: "primary" }],
  ];
  for (const [name, rootSel, opts] of gallery) {
    log(`  — ${name}`);
    await bridge.eval(`window.__HERMES_E2E__.showDialog(${JSON.stringify(name)}); return true;`);
    try {
      await bridge.waitFor(`the ${name} dialog`, `return !!e2e.first(${JSON.stringify(rootSel)});`, { timeoutMs: 15_000 });
    } catch (e) {
      check(false, `${name}: opens (${rootSel}) — ${e.message}`);
      await bridge.eval(`window.__HERMES_E2E__.showDialog(null); return true;`);
      continue;
    }
    await sleep(300);
    await eachTheme(bridge, name, rootSel, opts);
    await bridge.eval(`window.__HERMES_E2E__.showDialog(null); return true;`);
    await bridge.waitFor(`the ${name} dialog to close`, `return !e2e.first(${JSON.stringify(rootSel)});`, { timeoutMs: 10_000 });
  }

  await setTheme(bridge, "frosted-dark");
  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
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
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({
  scenario: SCENARIO,
  evidenceDir,
  failed,
  startedAt,
  log,
  details: { negativeControl: BESPOKE || NO_RING || MD !== 32, problems },
});
