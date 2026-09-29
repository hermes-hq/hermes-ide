#!/usr/bin/env node
// Scenario: UI-kit — the control set (src/components/ui) on the REAL app.
//
// A first-time user's app, Settings > Flags (the hidden section, unlocked by
// clicking the Settings title seven times) > Controls preview, which renders
// every control in every state. For every one of the eight themes:
//
//   - control heights are 28 / 32 / 36 px (buttons sm/md/lg, fields, select
//     triggers, icon buttons, segmented, tabs; chips 28, toggle 18, box 16)
//   - the focus ring: a solid 2 px outline 2 px away, in --focus-ring, at
//     ≥ 3:1 against the panel; a field keeps its border on focus
//   - button, field and badge colours as rendered meet 4.5:1 (text) / 3:1
//     (field edge), computed from the live computed styles
//   - a plain <button> takes the UI font (the base.css reset) and no rule
//     shrinks a pressed button
// and, in Frosted Dark and Frosted Light, screenshots of the whole sheet,
// the open listbox and the open menu. The ring is also found in the
// pictures: showing it on a row of controls adds ring-coloured pixels.
// Keyboard on the real webview: ↓ opens the Select, type-ahead picks an
// option, Esc closes the list without closing Settings; ↓ opens the Menu.
//
// Focus: the test window is never focused, so :focus-visible may not match
// (it does on CI runners where the window gets focus; the log says which).
// The "focus" state is then drawn by the preview's copy of the stylesheet's
// own :focus-visible rules (UiKitScreen previewPseudoStates), which is what
// the heights, colours and pictures of the ring are measured on.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_UIKIT_EXPECT_MD=30   expects 30 px default controls
//   HERMES_E2E_UIKIT_NO_RING=1      sets --focus-ring-width to 0 first
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/UI-kit.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/UI-kit.

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, pngColourCount, sleep } from "../harness.mjs";

const SCENARIO = "UI-kit";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

const MD = Number(process.env.HERMES_E2E_UIKIT_EXPECT_MD || 32);
const NO_RING = process.env.HERMES_E2E_UIKIT_NO_RING === "1";
const THEMES = ["frosted-dark", "atelier", "observatory", "phosphor", "frosted-light", "linen", "newsprint", "atrium"];
const SHOT_THEMES = new Set(["frosted-dark", "frosted-light"]);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const screen of ["welcome", "theme", "AI tools"]) {
    await sleep(300);
    await inkSweep(bridge, `welcome: ${screen}`);
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return true;
  `);
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

/** Settings > (7 clicks on the title) Flags > Controls preview. */
async function openControlsPreview(bridge) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.eval(`
    const title = e2e.must(e2e.first(".settings-title"), "settings title");
    for (let i = 0; i < 7; i++) e2e.click(title);
    return true;
  `);
  await bridge.waitFor("the hidden Flags tab", `return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Flags");`);
  // Every Settings tab: readable controls after the reset.
  const tabs = await bridge.eval(`return e2e.all(".settings-tab").map((el) => e2e.norm(el.innerText));`);
  for (const [i, name] of tabs.entries()) {
    await bridge.eval(`return e2e.click(e2e.all(".settings-tab")[${i}]);`);
    await sleep(400);
    await inkSweep(bridge, `Settings > ${name}`);
  }
  await bridge.eval(`return e2e.click(e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Flags"));`);
  await bridge.click('[data-testid="ui-kit-open"]');
  await bridge.waitFor("the controls preview", `return !!e2e.first('[data-testid="ui-kit-screen"]');`, { timeoutMs: 20_000 });
}

/** In-page helpers: colour parsing, WCAG contrast, the colour behind an element. */
const PAGE = String.raw`
// Computed colours come as rgb()/rgba(), or as color(srgb r g b / a) for a
// color-mix() result in WebKit; anything else is an error, never a skip.
const rgb = (s) => {
  let m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  }
  m = /^color\(srgb ([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[ \/]+/).filter(Boolean).map(Number);
    return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] === undefined ? 1 : p[3] };
  }
  throw new Error("unreadable colour: " + s);
};
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = ({ r, g, b }) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** The opaque colour painted behind el (its own background included). */
const backdrop = (el, includeSelf = true) => {
  const layers = [];
  for (let n = includeSelf ? el : el.parentElement; n; n = n.parentElement) {
    const c = rgb(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 };
  for (const c of layers.reverse()) acc = c.a >= 1 ? c : over(c, acc);
  return acc;
};
const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const kit = (name) => document.querySelector('[data-kit="' + name + '"]');
`;

/**
 * The base.css reset makes buttons and fields inherit the page's ink. A
 * control that still had the browser's white field or grey button behind it
 * would then show light text on a light fill. Every visible control on
 * screen is checked: its text must stay readable (≥ 3:1; the design target
 * is 4.5, which older screens reach as they move to the control set).
 */
async function inkSweep(bridge, where) {
  const found = await bridge.eval(`${PAGE}
    const out = [];
    const sel = 'button, select, textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=hidden])';
    for (const el of e2e.all(sel)) {
      if (el.closest(".ui-kit-screen")) continue;
      const text = (el.tagName === "INPUT" || el.tagName === "TEXTAREA") ? (el.value || el.placeholder) : el.innerText;
      if (!text || !text.trim()) continue;
      const bg = backdrop(el);
      const fg = over(rgb(getComputedStyle(el).color), bg);
      out.push({ what: e2e.nameOf(el).slice(0, 40) || el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), ratio: +ratio(fg, bg).toFixed(2), fg: hex(fg), bg: hex(bg) });
    }
    return out;
  `);
  const low = found.filter((c) => c.ratio < 3);
  const soft = found.filter((c) => c.ratio >= 3 && c.ratio < 4.5);
  log(`  ink sweep (${where}): ${found.length} controls, ${soft.length} between 3 and 4.5:1, ${low.length} under 3:1`);
  for (const c of soft) log(`    below target: "${c.what}" .${c.cls} ${c.fg} on ${c.bg} = ${c.ratio}:1`);
  for (const c of low) log(`    UNREADABLE: "${c.what}" .${c.cls} ${c.fg} on ${c.bg} = ${c.ratio}:1`);
  assert(low.length === 0, `${where}: every visible control's text is readable (≥ 3:1) after the reset`);
  return found.length;
}

async function pickTheme(bridge, id) {
  await bridge.eval(`
    const sel = document.querySelector('[data-kit="theme"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, ${JSON.stringify(id)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
  await bridge.waitFor(`the ${id} theme`, `return document.documentElement.dataset.theme === ${JSON.stringify(id)};`);
  // Controls fade their colours (--dur-quick); measure once that is over.
  await sleep(500);
  await bridge.settle();
}

async function measure(bridge) {
  return bridge.eval(`${PAGE}
    const h = (sel) => { const el = typeof sel === "string" ? (kit(sel) || document.querySelector(sel)) : sel; if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { h: +r.height.toFixed(2), w: +r.width.toFixed(2), css: cs.height + " " + cs.display + " " + cs.boxSizing, cls: String(el.className) }; };
    return {
      btnSm: h("btn-sm"), btnMd: h("btn-md"), btnLg: h("btn-lg"),
      inputMd: h("input-md"), inputSm: h("input-sm"), inputCode: h("input-code"),
      select: h("#ui-kit-select"), selectSm: h("#ui-kit-select-sm"), native: h("native-select"),
      iconMd: h("icon-md"), iconSm: h("icon-sm"), close: h("close-sample"),
      segmented: h('.ui-kit-screen .h-segmented:not(.h-segmented--sm)'), segmentedSm: h(".ui-kit-screen .h-segmented--sm"),
      tab: h(".ui-kit-screen .h-tabs--horizontal .h-tab"), vtab: h(".ui-kit-screen .h-tabs--vertical .h-tab"),
      chip: h(".ui-kit-screen .h-chip--md"), chipSm: h(".ui-kit-screen .h-chip--sm"),
      toggle: h(".ui-kit-screen .h-toggle"), checkbox: h(".ui-kit-screen .h-checkbox"), badge: h(".ui-kit-screen .h-badge"),
      counter: h(".ui-kit-screen .h-counter"),
    };
  `);
}

async function colours(bridge) {
  return bridge.eval(`${PAGE}
    const out = [];
    const text = (el, what) => {
      const s = getComputedStyle(el);
      const bg = backdrop(el);
      out.push({ what, fg: hex(over(rgb(s.color), bg)), bg: hex(bg), ratio: +ratio(over(rgb(s.color), bg), bg).toFixed(2), min: 4.5 });
    };
    for (const el of document.querySelectorAll('.ui-kit-screen [data-kit^="btn-"]')) {
      const k = el.getAttribute("data-kit");
      if (/disabled/.test(k) || !/^btn-(primary|secondary|quiet|danger|danger-solid|link)-/.test(k)) continue;
      text(el, k);
    }
    text(kit("input-code"), "field value");
    text(document.querySelector(".ui-kit-screen .h-field-error"), "field error");
    for (const b of document.querySelectorAll(".ui-kit-screen .h-badge, .ui-kit-screen .h-counter")) text(b, "badge " + b.className);
    text(document.querySelector('.ui-kit-screen .h-segment[aria-checked="true"]'), "selected segment");
    text(document.querySelector('.ui-kit-screen .h-segment[aria-checked="false"]'), "segment");
    text(document.querySelector('.ui-kit-screen .h-tabs--vertical .h-tab[aria-selected="true"]'), "current nav row");
    // Field edge against the panel it sits on.
    const input = kit("input-md");
    const edge = rgb(getComputedStyle(input).borderTopColor);
    const panel = backdrop(input, false);
    out.push({ what: "field edge", fg: hex(edge), bg: hex(panel), ratio: +ratio(edge, panel).toFixed(2), min: 3 });
    return out;
  `);
}

async function focusRing(bridge) {
  return bridge.eval(`${PAGE}
    // Try the real thing first: keyboard modality, then focus.
    const target = kit("btn-secondary-default");
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    target.focus();
    const real = { pageHasFocus: document.hasFocus(), focusVisible: target.matches(":focus-visible"), outline: getComputedStyle(target).outlineStyle + " " + getComputedStyle(target).outlineWidth };
    target.blur();
    const el = kit("btn-secondary-focus");
    const s = getComputedStyle(el);
    const ringColour = rgb(s.outlineColor);
    const panel = backdrop(el, false);
    const input = kit("input-focus");
    const plain = kit("input-md");
    const expected = getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim();
    return {
      real,
      style: s.outlineStyle, width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset),
      colour: hex(ringColour), expected, ratio: +ratio(ringColour, panel).toFixed(2), panel: hex(panel),
      inputRing: getComputedStyle(input).outlineStyle + " " + getComputedStyle(input).outlineWidth,
      inputBorderSame: getComputedStyle(input).borderTopColor === getComputedStyle(plain).borderTopColor,
    };
  `);
}

let app;
let failed = false;
const details = {};

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   expect md=${MD}px   no-ring control=${NO_RING}`);
  app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  const { bridge } = app;
  await completeOnboarding(bridge);

  log("step 1: Settings > Flags > Controls preview");
  await openControlsPreview(bridge);
  const startTheme = await bridge.eval(`return document.documentElement.dataset.theme;`);
  log(`  theme before: ${startTheme}`);
  if (NO_RING) {
    await bridge.eval(`document.documentElement.style.setProperty("--focus-ring-width", "0px"); return true;`);
    log("  NEGATIVE CONTROL: --focus-ring-width forced to 0px");
  }

  log("step 2: the base reset on a plain button");
  const reset = await bridge.eval(`
    const b = document.createElement("button");
    b.textContent = "x";
    b.setAttribute("data-preview", "active");
    document.querySelector(".ui-kit-screen").appendChild(b);
    const s = getComputedStyle(b);
    const body = getComputedStyle(document.body);
    const out = { font: s.fontFamily, bodyFont: body.fontFamily, transform: s.transform, color: s.color, bodyColor: body.color };
    b.remove();
    return out;
  `);
  log(`  plain button: font ${reset.font}; pressed transform ${reset.transform}`);
  assert(reset.font === reset.bodyFont, "a plain <button> takes the UI font of the page");
  assert(reset.color === reset.bodyColor, "a plain <button> takes the ink of the page");
  assert(reset.transform === "none", "no rule scales a pressed button");

  for (const theme of THEMES) {
    log(`step 3: theme ${theme}`);
    await pickTheme(bridge, theme);
    const m = await measure(bridge);
    details[theme] = { sizes: m };
    const near = (v, want) => v && Math.abs(v.h - want) <= 0.5;
    const sm = MD - 4;
    const lg = MD + 4;
    for (const [k, want] of [
      ["btnSm", sm], ["btnMd", MD], ["btnLg", lg], ["inputMd", MD], ["inputSm", sm], ["inputCode", MD],
      ["select", MD], ["selectSm", sm], ["native", MD], ["iconMd", MD], ["iconSm", sm], ["close", sm],
      ["segmented", MD], ["segmentedSm", sm], ["tab", MD], ["vtab", MD], ["chip", 28], ["chipSm", 24],
      ["toggle", 18], ["checkbox", 16], ["badge", 18], ["counter", 16],
    ]) {
      assert(near(m[k], want), `${theme}: ${k} is ${want} px tall (measured ${m[k]?.h}${near(m[k], want) ? "" : `; ${m[k]?.css}; .${m[k]?.cls}`})`);
    }
    assert(Math.abs(m.iconMd.w - m.iconMd.h) <= 0.5 && Math.abs(m.iconSm.w - m.iconSm.h) <= 0.5, `${theme}: icon buttons are square`);

    const ring = await focusRing(bridge);
    details[theme].ring = ring;
    log(`  real focus: page has focus=${ring.real.pageHasFocus}, :focus-visible=${ring.real.focusVisible}, outline "${ring.real.outline}"`);
    assert(ring.style === "solid" && ring.width === 2 && ring.offset === 2, `${theme}: focus ring is solid 2px, 2px away (${ring.style} ${ring.width}px +${ring.offset}px)`);
    assert(ring.ratio >= 3, `${theme}: focus ring ${ring.colour} is ${ring.ratio}:1 against the panel ${ring.panel} (≥ 3)`);
    assert(ring.inputRing.startsWith("solid") && ring.inputBorderSame, `${theme}: a focused field shows the ring and keeps its border (${ring.inputRing})`);
    if (ring.real.focusVisible) {
      assert(ring.real.outline.startsWith("solid 2"), `${theme}: real keyboard focus draws the same ring (${ring.real.outline})`);
    }

    const cs = await colours(bridge);
    details[theme].contrast = cs;
    const low = cs.filter((c) => !(c.ratio >= c.min));
    for (const c of low) log(`  LOW ${c.what}: ${c.fg} on ${c.bg} = ${c.ratio}:1 (min ${c.min})`);
    assert(low.length === 0, `${theme}: all ${cs.length} rendered text/edge pairs meet their contrast minimum (lowest ${Math.min(...cs.map((c) => c.ratio))}:1)`);

    if (SHOT_THEMES.has(theme)) {
      const shot = await bridge.screenshot(join(evidenceDir, `${theme}-01-sheet.png`));
      log(`  screenshot ${shot.file}`);
      // The ring in the picture: hide the focus previews and compare.
      const ringArea = await bridge.eval(`
        // Only rings fully inside the window are in the picture.
        const els = [...document.querySelectorAll('.ui-kit-screen [data-preview~="focus"]')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 4 && r.left >= 4 && r.bottom <= window.innerHeight - 4 && r.right <= window.innerWidth - 4;
        });
        const scale = ${shot.width} / window.innerWidth;
        const w = els.length ? parseFloat(getComputedStyle(els[0]).outlineWidth) || 0 : 0;
        let area = 0;
        for (const el of els) { const r = el.getBoundingClientRect(); area += 2 * (r.width + r.height + 8) * w; }
        return { count: els.length, expectedPx: Math.round(area * scale * scale), scale };
      `);
      await bridge.eval(`for (const el of document.querySelectorAll('.ui-kit-screen [data-preview~="focus"]')) { el.dataset.previewWas = el.dataset.preview; el.dataset.preview = ""; } return true;`);
      const bare = await bridge.screenshot(join(evidenceDir, `${theme}-02-sheet-no-focus.png`));
      await bridge.eval(`for (const el of document.querySelectorAll('.ui-kit-screen [data-preview-was]')) { el.dataset.preview = el.dataset.previewWas; delete el.dataset.previewWas; } return true;`);
      const withRing = pngColourCount(shot.file, ring.colour, 28);
      const without = pngColourCount(bare.file, ring.colour, 28);
      log(`  ring-coloured pixels: ${withRing} with the focus previews, ${without} without; ${ringArea.count} rings ≈ ${ringArea.expectedPx} px expected`);
      details[theme].ringPixels = { withRing, without, expected: ringArea.expectedPx };
      assert(ringArea.expectedPx > 0 && withRing - without >= ringArea.expectedPx * 0.5, `${theme}: the focus rings are visible in the picture (+${withRing - without} px)`);
      // The rest of the sheet: chips, segmented, tabs, toggles, boxes, radios, badges.
      await bridge.eval(`const b = document.querySelector(".ui-kit-body"); b.scrollTop = b.scrollHeight; return true;`);
      await bridge.screenshot(join(evidenceDir, `${theme}-05-sheet-bottom.png`));
      await bridge.eval(`document.querySelector(".ui-kit-body").scrollTop = 0; return true;`);
    }
  }

  log("step 4: keyboard on the real webview (Frosted Dark)");
  await pickTheme(bridge, "frosted-dark");
  const key = (sel, k, extra = {}) =>
    bridge.eval(`
      const el = document.querySelector(${JSON.stringify(sel)});
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }));
      return true;
    `);
  await key("#ui-kit-select", "ArrowDown");
  await bridge.waitFor("the listbox to open", `return document.getElementById("ui-kit-select").getAttribute("aria-expanded") === "true";`);
  const list = await bridge.eval(`
    const lb = document.getElementById("ui-kit-select-listbox");
    const opts = [...lb.querySelectorAll('[role="option"]')];
    return { visible: e2e.visible(lb), heights: opts.map((o) => +o.getBoundingClientRect().height.toFixed(1)), active: document.getElementById(document.getElementById("ui-kit-select").getAttribute("aria-activedescendant"))?.innerText };
  `);
  assert(list.visible && list.heights.every((h) => Math.abs(h - (MD - 4)) <= 0.5), `the open listbox shows ${list.heights.length} options ${MD - 4} px tall (${list.heights.join(", ")})`);
  await bridge.screenshot(join(evidenceDir, "frosted-dark-03-select-open.png"));
  await key("#ui-kit-select", "g");
  await key("#ui-kit-select", "Enter");
  const picked = await bridge.waitFor("type-ahead to pick goose", `const t = document.getElementById("ui-kit-select").innerText; return t.includes("goose") ? t : null;`);
  assert(picked.includes("goose"), `type-ahead + Enter chose "${picked.trim()}"`);
  await key("#ui-kit-select", "ArrowDown");
  await key("#ui-kit-select", "Escape");
  await bridge.waitFor("the listbox to close", `return document.getElementById("ui-kit-select").getAttribute("aria-expanded") === "false";`);
  await sleep(200);
  assert(await bridge.exists('[data-testid="ui-kit-screen"]'), "Esc closed the list only: Settings and the preview are still open");

  await bridge.click('[data-kit="menu-trigger"]');
  await bridge.waitFor("the menu to open", `return e2e.all('[role="menu"]').length === 1;`);
  await bridge.screenshot(join(evidenceDir, "frosted-dark-04-menu-open.png"));
  // One key per task, as a keyboard delivers them.
  for (const k of ["ArrowDown", "Enter"]) {
    await bridge.eval(`
      const m = document.querySelector('[role="menu"]:not([hidden])');
      m.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
      return true;
    `);
  }
  const ran = await bridge.waitFor("the menu action to run", `return document.querySelector('[data-kit="menu-last"]')?.innerText || null;`);
  assert(ran === "duplicate", `↓ then Enter in the menu ran "${ran}" (the second item)`);

  await pickTheme(bridge, "frosted-light");
  await key("#ui-kit-select", "ArrowDown");
  await bridge.waitFor("the listbox to open", `return document.getElementById("ui-kit-select").getAttribute("aria-expanded") === "true";`);
  await bridge.screenshot(join(evidenceDir, "frosted-light-03-select-open.png"));
  await key("#ui-kit-select", "Escape");

  log("step 5: close the preview; the user's theme comes back");
  await bridge.click('[data-kit="close"]');
  await bridge.waitFor("the preview to close", `return !e2e.first('[data-testid="ui-kit-screen"]');`);
  const after = await bridge.eval(`return { theme: document.documentElement.dataset.theme, preview: !!document.querySelector("style[data-ui-kit-preview]") };`);
  assert(after.theme === startTheme, `the theme is ${startTheme} again`);
  assert(!after.preview, "the state previews are gone with the screen");
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
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details: { negativeControl: NO_RING || MD !== 32, themes: details } });
