#!/usr/bin/env node
// Scenario: UI-chrome — the always-visible chrome on the control set, on the
// REAL app.
//
// Two fake `claude` sessions (tools/fake-agents/fake-cli.mjs on PATH) ask
// for permission (their PermissionRequest hook: an exact "needs approval"),
// so the sidebar has two rows, the pane has its header chips and status
// strip, and the attention inbox has two items. Then, in Frosted Dark and
// in Frosted Light (switched in Settings > Appearance, as a person does):
//
//   sidebar   the current session's row is filled with --row-active-bg and
//             carries a 2 px rail in --primary-bg (brass); it is the only
//             current row; every piece of text in every row (metadata
//             included) is ≥ 4.5:1 on what it is drawn on; a row's model
//             and permission-mode tags are 18 px and share one line,
//             clear of the row's Close; both rows show both tags, and keep
//             the model when Hermes's own identity update (no model) comes
//             after the agent's (the order the CI runners saw)
//   header    the pane header line is 28 px; its chips are 24 px Chips
//   strip     28 px, its inbox button a 28 px Button, its text ≥ 4.5:1
//   close     every close / remove / dismiss button in the chrome is the one
//             Close: a 28 × 28 icon button with a single 12 px drawn ×;
//             nothing draws a text "×" any more
//   bars      the status bar's icon buttons are 28 px and sit inside it; the
//             activity bar's count is a neutral 16 px Counter; the title-bar
//             inbox badge's count is brass (attention) while agents wait
//   labels    each activity-bar label, hovered, is a tooltip beside the
//             bar: opaque, edged, on top of the sidebar; the button keeps
//             its size
//   inbox     opened with ⌘⇧I (Ctrl+Shift+A): 44 px rows; ↓ moves the
//             highlight (aria-activedescendant, the hover fill); the session
//             in view is the current row (fill + brass rail); text ≥ 4.5:1;
//             Esc closes it
//   palette   opened with ⌘⇧P (Ctrl+Shift+P): 32 px rows; ↓ moves the
//             highlight (aria-selected, aria-activedescendant on the input);
//             the session in view is the current row; text ≥ 4.5:1; Esc
//   ⌘I        (Ctrl+Shift+I) jumps to the agent waiting longest, and the
//             sidebar's current row moves with it
//   focus     every control of the sidebar, pane header, strip, status bar,
//             activity bar, inbox and palette draws the solid focus ring
//             (the stylesheets' own :focus-visible rules, copied in place as
//             in UI-focus-ring: the test window has no keyboard focus
//             locally), and the ring shows whole: its rectangle (the box
//             grown by outline-offset + outline-width) fits inside the
//             window and inside every ancestor that clips (overflow not
//             visible)
// with screenshots of the sidebar and header, the strip, the inbox and the
// palette in both themes.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_UICHROME_NEGATIVE=1     puts back the old current row (the
//                                      grey --bg-active fill, no rail)
//                                      before the checks.
//   HERMES_E2E_UICHROME_NEGATIVE=clip  draws the rings of the strip, the
//                                      pane header, the scope bar and the
//                                      status bar 2 px outside the control
//                                      again, where their containers clip
//                                      them.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/UI-chrome.mjs

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";

const SCENARIO = "UI-chrome";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const MAC = platform() === "darwin";
const NEGATIVE = process.env.HERMES_E2E_UICHROME_NEGATIVE === "1";
const NEGATIVE_CLIP = process.env.HERMES_E2E_UICHROME_NEGATIVE === "clip";
const THEMES = [
  { id: "frosted-dark", label: "Frosted Dark" },
  { id: "frosted-light", label: "Frosted Light" },
];

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** A per-item check: logged, and the run goes on so one log lists every miss. */
const problems = [];
function check(condition, message) {
  if (condition) log(`  ok — ${message}`);
  else {
    log(`  FAILED — ${message}`);
    problems.push(message);
  }
}

// ─── A fake `claude` on PATH ──────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), "hermes-e2e-uichrome-"));
const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
const privateHome = join(work, "home");
for (const d of [fakeBin, recordDir, privateHome]) mkdirSync(d, { recursive: true });
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
if (onWindows) {
  writeFileSync(join(fakeBin, "claude.cmd"), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
} else {
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
}
const hasRealClaude = (dir) => ["claude", "claude.exe", "claude.cmd"].some((n) => existsSync(join(dir, n)));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasRealClaude(d))].join(delimiter);
for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_")) delete process.env[name];

// Windows terminals rebuild PATH from the registry (see N12); the fake goes
// on the user's registry Path, only on a throwaway CI runner.
const canEditRegistryPath = onWindows && process.env.GITHUB_ACTIONS === "true";
function addFakeBinToRegistryPath() {
  if (!canEditRegistryPath) return null;
  let old = null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    const m = out.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
    old = m ? m[1].trim() : "";
  } catch {
    old = null;
  }
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old ? `${old};${fakeBin}` : fakeBin, "/f"]);
  log("  (CI runner: added the fake claude folder to the user's registry Path)");
  return () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    log("  (CI runner: restored the user's registry Path)");
  };
}
if (onWindows && !canEditRegistryPath) {
  log("this scenario needs the fake claude on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

function launch() {
  const common = { runDir: join(evidenceDir, "run"), log, env: { HERMES_FAKE_DIR: recordDir } };
  return onWindows ? launchApp({ ...common, home: "real", resetData: true }) : launchApp({ ...common, home: "private", homeDir: privateHome });
}

/**
 * Once on macOS CI the shell stopped `hi run` right after it started ("[1]+
 * Stopped"). Say how far the fake got (its records end at "raw-mode" when
 * changing the terminal's settings stopped it) and which processes are
 * stopped (STAT T) against the terminal's foreground group (TPGID).
 */
function describeStoppedLaunch(appPid) {
  try {
    const records = readdirSync(recordDir).filter((f) => f.startsWith("launch-"));
    log(`  fake launches: ${records.length}`);
    for (const f of records) {
      const r = JSON.parse(readFileSync(join(recordDir, f), "utf8"));
      log(`    ${f}: events ${JSON.stringify(r.events.map((e) => `${e.ev}@${e.t}`))}, exit ${JSON.stringify(r.exit)}`);
    }
  } catch (e) {
    log(`  (could not read the fake's records: ${e.message})`);
  }
  if (onWindows) return;
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,stat=,command="], { encoding: "utf8" }).split("\n");
    const cols = rows.map((r) => r.trim().split(/\s+/)).filter((c) => c.length > 5);
    const parent = new Map(cols.map((c) => [c[0], c[1]]));
    // The terminals live under the app, or under its session host (whose
    // data folder is in this run's home).
    const roots = new Set([String(appPid), ...cols.filter((c) => c.slice(5).join(" ").includes(privateHome)).map((c) => c[0])]);
    const underApp = (pid) => {
      for (let p = pid, hops = 0; p && p !== "0" && p !== "1" && hops < 50; p = parent.get(p), hops++) if (roots.has(p)) return true;
      return false;
    };
    log("  processes under the app (pid ppid pgid tpgid stat command):");
    for (const c of cols) if (underApp(c[0])) log(`    ${c.join(" ").slice(0, 160)}`);
  } catch (e) {
    log(`  (ps failed: ${e.message})`);
  }
}

// ─── UI steps ─────────────────────────────────────────────────────────

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (let i = 0; i < 3; i++) {
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
  await dismissWhatsNew(bridge);
}

/** New Session wizard: a Claude session in a terminal, default folder. */
async function createClaudeSession(bridge) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  if (await bridge.exists('.session-creator-mode-card[data-category="universal"]')) {
    await bridge.click('.session-creator-mode-card[data-category="universal"]');
    await sleep(200);
    if (await bridge.exists(".session-creator-mode-step")) await bridge.click(".session-creator-actions .session-creator-btn-primary");
  }
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(card, "the Claude card"));
  `);
  await bridge.eval(`
    const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
    if (box && box.checked) e2e.click(box);
    return true;
  `);
  for (let i = 0; i < 8; i++) {
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
  return bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

/** A key the way the keyboard sends it, to whatever has the keyboard. */
function pressKey(bridge, init) {
  return bridge.eval(`
    const target = document.activeElement || document.body;
    const opts = { ...${JSON.stringify(init)}, bubbles: true, cancelable: true, composed: true, view: window };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return true;
  `);
}
const INBOX_KEY = MAC ? { key: "I", code: "KeyI", metaKey: true, shiftKey: true } : { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true };
const NEXT_KEY = MAC ? { key: "i", code: "KeyI", metaKey: true } : { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true };
const PALETTE_KEY = MAC ? { key: "P", code: "KeyP", metaKey: true, shiftKey: true } : { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true };

async function pickTheme(bridge, theme) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.clickWhenReady(`
    const tab = e2e.all(".settings-tab").find((el) => /appearance/i.test(e2e.norm(el.innerText)));
    return e2e.click(e2e.must(tab, "the Appearance tab"));
  `);
  await bridge.clickWhenReady(`
    const item = e2e.all(".settings-theme-item").find((el) => e2e.norm(el.innerText) === ${JSON.stringify(theme.label)});
    // Each theme is a control-set Chip inside its item: press the chip's button.
    return e2e.click(e2e.must(item && (item.querySelector("button") ?? item), ${JSON.stringify(theme.label)}));
  `);
  await bridge.waitFor(`the ${theme.id} theme`, `return document.documentElement.dataset.theme === ${JSON.stringify(theme.id)};`);
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
  // Controls fade their colours (--dur-quick); measure once that is over.
  await sleep(600);
}

// ─── In-page helpers ──────────────────────────────────────────────────

/** Colour maths, the colour behind an element, a token's resolved colour, and the focus probe. */
const PAGE = String.raw`
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
  // WebKit reports some color-mix() results in OKLab.
  m = /^oklab\(([^)]+)\)$/.exec(s);
  if (m) {
    const [L, A, B, alpha] = m[1].split(/[ \/]+/).filter(Boolean).map(Number);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const k = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const enc = (x) => 255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
    return {
      r: enc(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * k),
      g: enc(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * k),
      b: enc(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * k),
      a: alpha === undefined ? 1 : alpha,
    };
  }
  throw new Error("unreadable colour: " + s);
};
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = ({ r, g, b }) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** The opaque colour painted behind el (its own background included). */
const backdrop = (el, includeSelf = true) => {
  const layers = [];
  for (let n = includeSelf ? el : el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
    const c = rgb(getComputedStyle(n).backgroundColor);
    if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 };
  for (const c of layers.reverse()) acc = c.a >= 1 ? c : over(c, acc);
  return acc;
};
/** How opaque el is as painted (its own opacity times its ancestors'). */
const opacityOf = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
/** A token's colour as the element sees it (a probe inside it). */
const tokenColour = (el, token) => {
  const probe = document.createElement("span");
  probe.style.color = "var(" + token + ")";
  // A field cannot hold a child with its own style (WebView2 gives it plain
  // black), so a field's token is read in its parent, where it inherits from.
  const host = /^(INPUT|TEXTAREA|SELECT|IMG)$/.test(el.tagName) ? el.parentElement : el;
  host.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
};
const sameColour = (a, b) => { const x = rgb(a), y = rgb(b); return Math.abs(x.r - y.r) < 2 && Math.abs(x.g - y.g) < 2 && Math.abs(x.b - y.b) < 2 && Math.abs(x.a - y.a) < 0.02; };
const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
/** Every visible piece of text under root: its ink over what it is drawn on. */
const textContrast = (root) => {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = t.textContent.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const el = t.parentElement;
    if (!el || !shown(el) || el.closest(".h-visually-hidden, .attention-live, .xterm")) continue;
    const alpha = opacityOf(el);
    if (alpha === 0) continue;
    const bg = backdrop(el);
    const ink = rgb(getComputedStyle(el).color);
    const fg = over({ ...ink, a: ink.a * alpha }, bg);
    out.push({ text: text.slice(0, 40), cls: String(el.className).slice(0, 70), fg: hex(fg), bg: hex(bg), ratio: +ratio(fg, bg).toFixed(2) });
  }
  return out;
};
const box = (el) => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };

/**
 * Where the ring as drawn (the element's box grown by outline-offset +
 * outline-width on every side) is cut off: by the window, or by an ancestor
 * whose overflow is not visible (its padding box clips). An ancestor clips a
 * positioned element only if it is on that element's containing-block chain.
 * Returns one line per cut, [] when the whole ring shows.
 */
const ringClips = (el, cs) => {
  const ext = (parseFloat(cs.outlineOffset) || 0) + (parseFloat(cs.outlineWidth) || 0);
  const r = el.getBoundingClientRect();
  const ring = { top: r.top - ext, bottom: r.bottom + ext, left: r.left - ext, right: r.right + ext };
  const cuts = [];
  const cut = (by, b, x, y) => {
    const c = { top: y ? b.top - ring.top : 0, bottom: y ? ring.bottom - b.bottom : 0, left: x ? b.left - ring.left : 0, right: x ? ring.right - b.right : 0 };
    const sides = Object.entries(c).filter(([, v]) => v > 0.5);
    if (sides.length) cuts.push(by + ": " + sides.map(([k, v]) => k + " " + v.toFixed(1) + "px").join(", "));
  };
  const de = document.documentElement;
  cut("the window", { top: 0, left: 0, right: de.clientWidth, bottom: de.clientHeight }, true, true);
  let pos = cs.position;
  for (let n = el.parentElement; n && n !== de; n = n.parentElement) {
    const s = getComputedStyle(n);
    const holds = pos === "fixed"
      ? s.transform !== "none" || s.filter !== "none" || s.perspective !== "none" || /paint|layout|strict|content/.test(s.contain)
      : pos === "absolute" ? s.position !== "static" || s.transform !== "none" : true;
    if (!holds) continue;
    pos = s.position === "fixed" || s.position === "absolute" ? s.position : "static";
    const x = s.overflowX !== "visible";
    const y = s.overflowY !== "visible";
    if (!x && !y) continue;
    const b = n.getBoundingClientRect();
    const left = b.left + n.clientLeft;
    const top = b.top + n.clientTop;
    cut(n.tagName.toLowerCase() + "." + String(n.className).trim().split(/\s+/)[0] + " (overflow " + s.overflowX + " " + s.overflowY + ")", { left, top, right: left + n.clientWidth, bottom: top + n.clientHeight }, x, y);
  }
  return cuts;
};

window.__uiFocus = window.__uiFocus || (() => {
  const done = new WeakSet();
  const outlineRules = (el) => {
    const out = [];
    const walkRules = (list) => {
      for (const r of list) {
        if (r instanceof CSSStyleRule) {
          if (!/outline/.test(r.style.cssText)) continue;
          let hit = false;
          try { hit = el.matches(r.selectorText); } catch (e) { /* engine-specific selector */ }
          if (hit) out.push(r.selectorText.slice(0, 120) + " { " + r.style.cssText.slice(0, 120) + " }");
        } else if (r.cssRules && !(r instanceof CSSKeyframesRule)) walkRules(r.cssRules);
      }
    };
    for (const sh of document.styleSheets) { try { walkRules(sh.cssRules); } catch (e) { /* cross-origin */ } }
    return out;
  };
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
    },
    probe(root) {
      const els = [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"], [role="tab"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !el.disabled && el.type !== "hidden" && !el.closest(".xterm");
      });
      return els.map((el) => {
        el.setAttribute("data-simfocus", "");
        const cs = getComputedStyle(el);
        const out = { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0, colour: cs.outlineColor, opacity: opacityOf(el) };
        const ring = tokenColour(el, "--focus-ring");
        const clipped = ringClips(el, cs);
        const offset = cs.outlineOffset;
        const ok = out.style === "solid" && out.width >= 2 && sameColour(out.colour, ring) && out.opacity > 0.9;
        // Why a control shows no ring: its focus state and every rule that
        // matches it and sets an outline.
        const why = ok ? null : {
          active: document.activeElement === el, focus: el.matches(":focus"), focusVisible: el.matches(":focus-visible"), pageHasFocus: document.hasFocus(),
          transition: cs.transitionProperty + " " + cs.transitionDuration, animations: el.getAnimations().map((a) => a.animationName || a.transitionProperty || "?"),
          ringToken: ring, rules: outlineRules(el),
        };
        el.removeAttribute("data-simfocus");
        const name = (el.getAttribute("aria-label") || el.innerText || el.placeholder || "").trim().replace(/\s+/g, " ").slice(0, 30);
        return { what: el.tagName.toLowerCase() + "." + String(el.className).trim().split(/\s+/).slice(0, 4).join("."), name, ok, clipped, why, outline: out.style + " " + out.width + "px " + out.colour + " offset " + offset + " opacity " + out.opacity.toFixed(2) };
      });
    },
  };
})();
`;

function logContrast(where, rows, min = 4.5) {
  const low = rows.filter((r) => r.ratio < min);
  log(`  ${where}: ${rows.length} pieces of text, lowest ${rows.length ? Math.min(...rows.map((r) => r.ratio)) : "-"}:1`);
  for (const r of low) log(`    LOW  "${r.text}" .${r.cls} ${r.fg} on ${r.bg} = ${r.ratio}:1`);
  check(rows.length > 0 && low.length === 0, `${where}: every piece of text is ≥ ${min}:1 (${rows.length} checked)`);
}

// ─── The checks, per theme ────────────────────────────────────────────

async function checkSidebar(bridge, theme, active, other) {
  const m = await bridge.eval(`${PAGE}
    const rows = e2e.all(".session-item-wrapper");
    const current = rows.filter((w) => w.hasAttribute("data-current"));
    const cur = current[0];
    const before = cur ? getComputedStyle(cur, "::before") : null;
    return {
      rows: rows.length,
      current: current.map((w) => w.querySelector(".session-item")?.dataset.sessionItemId),
      isRow: cur ? cur.classList.contains("h-row") : false,
      fill: cur ? getComputedStyle(cur).backgroundColor : null,
      fillToken: cur ? tokenColour(cur.parentElement, "--row-active-bg") : null,
      rail: before ? { content: before.content, w: parseFloat(before.width), bg: before.backgroundColor, h: parseFloat(before.height) } : null,
      brass: cur ? tokenColour(cur.parentElement, "--primary-bg") : null,
      text: rows.flatMap((w) => textContrast(w)),
      currentText: cur ? textContrast(cur) : [],
      // The model and permission-mode tags of each row.
      identity: rows.map((w) => {
        const close = w.querySelector(".session-item-close");
        const cb = close ? close.getBoundingClientRect() : null;
        return [...w.querySelectorAll(".session-item-identity-row .h-chip")].filter(shown).map((c) => {
          const r = c.getBoundingClientRect();
          const underClose = !!cb && r.left < cb.right && r.right > cb.left && r.top < cb.bottom && r.bottom > cb.top;
          return { text: e2e.norm(c.innerText), h: box(c).h, w: box(c).w, top: box(c).top, line: box(c.parentElement).w, underClose };
        });
      }).filter((c) => c.length > 0),
    };
  `);
  check(m.rows === 2, `${theme}: two session rows in the sidebar`);
  check(m.current.length === 1 && m.current[0] === active, `${theme}: exactly one current row, the session in view (${m.current.join(",")})`);
  check(m.isRow, `${theme}: the row is the control set's ListRow`);
  check(!!m.fill && sameColourNode(m.fill, m.fillToken), `${theme}: the current row is filled with --row-active-bg (${m.fill} vs ${m.fillToken})`);
  check(!!m.rail && m.rail.content !== "none" && m.rail.w === 2 && m.rail.h > 8 && sameColourNode(m.rail.bg, m.brass), `${theme}: the current row has a 2 px brass rail (${JSON.stringify(m.rail)}, brass ${m.brass})`);
  logContrast(`${theme}: current session row`, m.currentText);
  logContrast(`${theme}: all session rows`, m.text);
  // Density: the model and permission tags are tag-sized chips that share one line.
  log(`  ${theme}: identity tags ${JSON.stringify(m.identity.map((r) => r.map((c) => `${c.text} ${c.w}×${c.h}px in a ${c.line}px line`)))}`);
  // Each row shows both tags its agent reported: its model (from its start
  // signal) and its permission mode. (On the CI runners a row's model went
  // missing: Hermes's own identity update, which has no model, arrived after
  // the agent's and replaced it. Identity now merges field by field.)
  check(m.identity.length === 2 && m.identity.every((r) => r.length === 2), `${theme}: both rows show their model and permission tags (${m.identity.map((r) => r.length).join(", ")})`);
  check(m.identity.every((r) => r.every((c) => c.h === 18)), `${theme}: the tags are 18 px (badge height), not 24 px chips (${m.identity.flat().map((c) => c.h).join(", ")})`);
  check(m.identity.every((r) => r.every((c) => Math.abs(c.top - r[0].top) < 0.5)), `${theme}: a row's tags sit on one line`);
  check(m.identity.every((r) => r.every((c) => !c.underClose)), `${theme}: no tag runs under the row's Close`);
  void other;
}

/** Colour equality on the Node side (both are computed CSS colours). */
function sameColourNode(a, b) {
  const parse = (s) => {
    const ok = /^oklab\(([^)]+)\)$/.exec(s || "");
    if (ok) {
      const [L, A, B, alpha] = ok[1].split(/[ /]+/).filter(Boolean).map(Number);
      const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
      const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
      const k = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
      const enc = (x) => 255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
      return [enc(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * k), enc(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * k), enc(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * k), alpha ?? 1];
    }
    let m = /^rgba?\(([^)]+)\)$/.exec(s || "");
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(s || "");
    if (m) {
      const p = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
    }
    return null;
  };
  const x = parse(a);
  const y = parse(b);
  return !!x && !!y && x.every((v, i) => Math.abs(v - y[i]) < (i === 3 ? 0.02 : 2));
}

async function checkHeaderStripBars(bridge, theme, sessionId) {
  const m = await bridge.eval(`${PAGE}
    const pane = e2e.must(e2e.all(".split-pane").find((p) => p.querySelector('[data-strip-session="${sessionId}"]')), "the pane of the session in view");
    const label = pane.querySelector(".split-pane-label");
    const chips = [...pane.querySelectorAll(".split-pane-label .h-chip, .scope-bar .h-chip")].filter(shown).map((c) => ({ cls: String(c.className), h: box(c).h }));
    const strip = pane.querySelector(".session-status-strip");
    const inboxBtn = strip.querySelector(".session-status-strip-inbox");
    const bar = e2e.must(e2e.first(".status-bar"), "status bar");
    const barBox = box(bar);
    const barButtons = [...bar.querySelectorAll(".h-icon-btn")].filter(shown).map((b) => ({ name: b.getAttribute("aria-label"), ...box(b) }));
    const activityBadge = e2e.first(".activity-bar .activity-bar-badge");
    const topBadge = e2e.first(".topbar .attention-badge");
    const topCounter = topBadge?.querySelector(".h-counter");
    return {
      labelH: box(label).h,
      chips,
      stripInner: strip.clientHeight, stripCls: strip.className,
      inboxBtn: inboxBtn ? { h: box(inboxBtn).h, cls: String(inboxBtn.className) } : null,
      stripText: textContrast(strip),
      headerText: textContrast(label),
      barInner: bar.clientHeight, barBox, barButtons,
      activityBadge: activityBadge ? { cls: String(activityBadge.className), tone: activityBadge.dataset.tone, h: box(activityBadge).h, text: activityBadge.innerText } : null,
      topBadge: topBadge ? { cls: String(topBadge.className), h: box(topBadge).h, count: topBadge.dataset.count } : null,
      topCounter: topCounter ? { tone: topCounter.dataset.tone, h: box(topCounter).h, bg: getComputedStyle(topCounter).backgroundColor, brass: tokenColour(topBadge, "--primary-bg") } : null,
    };
  `);
  log(`  ${theme}: header line ${m.labelH}px, chips ${JSON.stringify(m.chips)}`);
  check(m.labelH === 28, `${theme}: the pane header line is 28 px (${m.labelH})`);
  check(m.chips.length > 0 && m.chips.every((c) => c.h === 24), `${theme}: the header chips are 24 px Chips (${m.chips.map((c) => c.h).join(", ")})`);
  check(m.stripInner === 28, `${theme}: the status strip is 28 px (${m.stripInner})`);
  check(!!m.inboxBtn && m.inboxBtn.h === 28 && m.inboxBtn.cls.includes("h-btn"), `${theme}: the strip's inbox button is a 28 px Button (${JSON.stringify(m.inboxBtn)})`);
  logContrast(`${theme}: status strip`, m.stripText);
  logContrast(`${theme}: pane header`, m.headerText);
  check(m.barInner === 28, `${theme}: the status bar is 28 px inside its rule (${m.barInner})`);
  check(
    m.barButtons.length >= 2 && m.barButtons.every((b) => b.h === 28 && b.w === 28 && b.top >= m.barBox.top - 0.5 && b.bottom <= m.barBox.bottom + 0.5),
    `${theme}: the status bar's icon buttons are 28 × 28 and sit inside it (${JSON.stringify(m.barButtons.map((b) => [b.name, b.w, b.h]))})`,
  );
  check(!!m.activityBadge && m.activityBadge.cls.includes("h-counter") && m.activityBadge.tone === "neutral" && m.activityBadge.h === 16, `${theme}: the activity bar's session count is a neutral 16 px Counter (${JSON.stringify(m.activityBadge)})`);
  check(!!m.topBadge && m.topBadge.h === 28 && m.topBadge.cls.includes("h-btn"), `${theme}: the title-bar inbox badge is a 28 px Button (${JSON.stringify(m.topBadge)})`);
  check(!!m.topCounter && m.topCounter.tone === "attention" && m.topCounter.h === 16 && sameColourNode(m.topCounter.bg, m.topCounter.brass), `${theme}: with agents waiting its count is a brass 16 px Counter (${JSON.stringify(m.topCounter)})`);
}

/** Every close / remove / dismiss button in the chrome is the one Close. */
async function checkOneClose(bridge, theme) {
  const m = await bridge.eval(`${PAGE}
    const roots = [".session-list", ".split-pane-header", ".session-status-strip", ".status-bar", ".topbar", ".activity-bar", ".toast-container", ".attention-inbox", ".command-palette"];
    const buttons = roots.flatMap((sel) => [...document.querySelectorAll(sel + " button")]);
    const closeLike = buttons.filter((b) => {
      const name = (b.getAttribute("aria-label") || b.getAttribute("title") || "").toLowerCase();
      const text = b.textContent.trim();
      return /^(close|dismiss|remove|unpin|delete)\\b/.test(name) || /^[×✕✖x]$/i.test(text);
    });
    const textX = buttons.filter((b) => /[×✕✖]/.test(b.textContent));
    return {
      closes: closeLike.map((b) => {
        const svg = b.querySelectorAll("svg");
        const glyph = b.querySelector("svg.h-glyph--close");
        return { name: b.getAttribute("aria-label"), cls: String(b.className), svgs: svg.length, glyph: glyph ? box(glyph) : null, ...box(b), text: b.textContent.trim() };
      }),
      textX: textX.map((b) => String(b.className) + " " + b.textContent.trim()),
    };
  `);
  log(`  ${theme}: ${m.closes.length} close buttons in the chrome: ${m.closes.map((c) => `${c.name} ${c.w}×${c.h}`).join("; ")}`);
  check(m.closes.length >= 3, `${theme}: there are close buttons to check (${m.closes.length}: rows and the pane)`);
  const wrong = m.closes.filter((c) => !c.cls.includes("h-close-btn") || c.svgs !== 1 || !c.glyph || c.glyph.w !== 12 || c.glyph.h !== 12 || c.w !== 28 || c.h !== 28 || c.text !== "");
  for (const c of wrong) log(`    NOT THE ONE CLOSE: ${JSON.stringify(c)}`);
  check(wrong.length === 0, `${theme}: every close button is the one Close (28 × 28, one 12 px drawn ×, no text)`);
  check(m.textX.length === 0, `${theme}: no button in the chrome draws a text × (${m.textX.join(" | ")})`);
}

/**
 * Each activity-bar label, hovered (its :hover rules copied onto
 * [data-simhover]: the test window has no pointer), is a tooltip: beside
 * the bar, on an opaque edged surface, on top of whatever it lies over
 * (the sidebar's header and rows), and the button keeps its size.
 */
async function checkActivityLabels(bridge, theme) {
  const rows = await bridge.eval(`${PAGE}
    if (!window.__simHover) {
      const css = [];
      const walk = (rules) => { for (const r of rules) {
        if (r.selectorText) { if (r.selectorText.includes("activity-bar") && r.selectorText.includes(":hover")) css.push(r.cssText.replaceAll(":hover", "[data-simhover]")); }
        else if (r.cssRules && !(r instanceof CSSKeyframesRule)) walk(r.cssRules);
      } };
      for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) {} }
      const st = document.createElement("style"); st.textContent = css.join("\\n"); document.head.appendChild(st);
      window.__simHover = true;
    }
    const bar = document.querySelector(".activity-bar-left").getBoundingClientRect();
    return [...document.querySelectorAll(".activity-bar-left button")].map((b) => {
      const w0 = box(b).w;
      b.setAttribute("data-simhover", "");
      const l = b.querySelector(".activity-bar-label");
      for (const a of l.getAnimations()) a.finish();
      const r = box(l), cs = getComputedStyle(l), y = (r.top + r.bottom) / 2;
      // A tooltip takes no pointer events; let the hit test see it.
      l.style.pointerEvents = "auto";
      const onTop = [0.1, 0.5, 0.9].every((f) => l.contains(document.elementFromPoint(r.left + r.w * f, y)));
      l.style.pointerEvents = "";
      const out = { name: b.getAttribute("aria-label") ?? l.textContent, w0, w1: box(b).w, left: r.left, barRight: bar.right, bg: rgb(cs.backgroundColor).a, opacity: +cs.opacity, shadow: cs.boxShadow !== "none", border: parseFloat(cs.borderTopWidth) || 0, onTop };
      b.removeAttribute("data-simhover");
      return out;
    });
  `);
  check(rows.length >= 4, `${theme}: the activity bar has labels to check (${rows.length})`);
  for (const r of rows) {
    const ok = r.w1 === r.w0 && r.left >= r.barRight && r.bg === 1 && r.opacity === 1 && r.shadow && r.border > 0 && r.onTop;
    check(ok, `${theme}: hovering "${r.name}" shows its label beside the bar as an opaque, edged tooltip on top of the sidebar, the button keeps its size (${JSON.stringify(r)})`);
  }
}

async function checkFocus(bridge, theme, roots, { min = 10 } = {}) {
  await bridge.eval(`${PAGE}; window.__uiFocus.install(); return true;`);
  let total = 0;
  for (const sel of roots) {
    const rows = await bridge.eval(`${PAGE}; const root = document.querySelector(${JSON.stringify(sel)}); return root ? window.__uiFocus.probe(root) : null;`);
    if (!rows) {
      check(false, `${theme}: ${sel} is on screen for the focus check`);
      continue;
    }
    total += rows.length;
    const bad = rows.filter((r) => !r.ok);
    for (const r of bad) log(`    NO RING  ${r.what} "${r.name}" (${r.outline}) ${JSON.stringify(r.why)}`);
    check(bad.length === 0, `${theme}: ${sel}: ${rows.length} controls, every one draws the solid focus ring`);
    // The ring must also show whole: nothing may cut it off.
    const cut = rows.filter((r) => r.clipped.length > 0);
    for (const r of cut) log(`    CLIPPED  ${r.what} "${r.name}" (${r.outline}) — ${r.clipped.join("; ")}`);
    check(cut.length === 0, `${theme}: ${sel}: every ring shows whole, none cut off by the window or a clipping container${cut.length ? ` (clipped: ${cut.map((r) => r.what).join(", ")})` : ""}`);
  }
  check(total >= min, `${theme}: the focus check saw the controls (${total} ≥ ${min})`);
}

async function checkInbox(bridge, theme, active) {
  await pressKey(bridge, INBOX_KEY);
  await bridge.waitFor("the inbox to open (⌘⇧I / Ctrl+Shift+A)", `return !!e2e.first(".attention-inbox .attention-list");`);
  await sleep(300);
  const first = await bridge.eval(`${PAGE}
    const list = e2e.first(".attention-list");
    const rows = e2e.all(".attention-option");
    const hl = rows.filter((r) => r.hasAttribute("data-highlighted"));
    const cur = rows.filter((r) => r.hasAttribute("data-current"));
    const c = cur[0];
    const before = c ? getComputedStyle(c, "::before") : null;
    const plain = rows.find((r) => !r.hasAttribute("data-current"));
    return {
      focused: document.activeElement === list,
      activedescendant: list.getAttribute("aria-activedescendant"),
      heights: rows.map((r) => box(r).h),
      highlighted: hl.map((r) => r.id),
      current: cur.map((r) => r.dataset.sessionId),
      currentFill: c ? getComputedStyle(c).backgroundColor : null,
      rowActive: c ? tokenColour(c.parentElement, "--row-active-bg") : null,
      rail: before ? { content: before.content, w: parseFloat(before.width), bg: before.backgroundColor } : null,
      brass: c ? tokenColour(c.parentElement, "--primary-bg") : null,
      plainFill: plain ? getComputedStyle(plain).backgroundColor : null,
      text: textContrast(e2e.first(".attention-inbox")),
    };
  `);
  log(`  ${theme}: inbox rows ${JSON.stringify(first.heights)}, highlighted ${first.highlighted}, current ${first.current}`);
  check(first.focused, `${theme}: the inbox's list has the keyboard`);
  check(first.heights.length === 2 && first.heights.every((h) => h === 44), `${theme}: two inbox rows, 44 px each`);
  check(first.highlighted.length === 1 && first.activedescendant === first.highlighted[0], `${theme}: one highlighted row, the list's aria-activedescendant`);
  check(first.current.length === 1 && first.current[0] === active, `${theme}: the session in view is the inbox's current row`);
  check(sameColourNode(first.currentFill, first.rowActive), `${theme}: the current inbox row is filled with --row-active-bg`);
  check(!!first.rail && first.rail.content !== "none" && first.rail.w === 2 && sameColourNode(first.rail.bg, first.brass), `${theme}: the current inbox row has the 2 px brass rail`);
  logContrast(`${theme}: inbox`, first.text);
  await bridge.screenshot(join(evidenceDir, `${theme}-inbox.png`));

  await pressKey(bridge, { key: "ArrowDown", code: "ArrowDown" });
  await sleep(200);
  const moved = await bridge.eval(`${PAGE}
    const list = e2e.first(".attention-list");
    const hl = e2e.all(".attention-option[data-highlighted]");
    const h = hl[0];
    return {
      activedescendant: list.getAttribute("aria-activedescendant"),
      highlighted: hl.map((r) => r.id),
      selected: e2e.all('.attention-option[aria-selected="true"]').map((r) => r.id),
      fill: h && !h.hasAttribute("data-current") ? getComputedStyle(h).backgroundColor : null,
      hover: h ? tokenColour(h.parentElement, "--quiet-hover-bg") : null,
      text: textContrast(e2e.first(".attention-inbox")),
    };
  `);
  check(moved.highlighted.length === 1 && moved.highlighted[0] !== first.highlighted[0] && moved.activedescendant === moved.highlighted[0], `${theme}: ↓ moves the highlight and aria-activedescendant to the next row`);
  check(moved.selected.length === 1 && moved.selected[0] === moved.highlighted[0], `${theme}: the highlighted row is the selected option`);
  if (moved.fill) check(sameColourNode(moved.fill, moved.hover), `${theme}: a highlighted row takes the quiet hover fill (${moved.fill})`);
  logContrast(`${theme}: inbox after ↓`, moved.text);
  // Focus ring of the inbox (its list) while it is open.
  await checkFocus(bridge, `${theme} (inbox)`, [".attention-inbox"], { min: 1 });
  await pressKey(bridge, { key: "Escape", code: "Escape" });
  await bridge.waitFor("Esc to close the inbox", `return !e2e.first(".attention-inbox");`);
  log(`  ok — ${theme}: Esc closed the inbox`);
}

async function checkPalette(bridge, theme, active) {
  await pressKey(bridge, PALETTE_KEY);
  await bridge.waitFor("the palette to open (⌘⇧P / Ctrl+Shift+P)", `return !!e2e.first(".command-palette .command-palette-results");`);
  await sleep(300);
  const read = () =>
    bridge.eval(`${PAGE}
      const input = e2e.first(".command-palette-input");
      const rows = e2e.all(".command-palette-item");
      const hl = rows.filter((r) => r.hasAttribute("data-highlighted"));
      const cur = rows.filter((r) => r.hasAttribute("data-current"));
      const c = cur[0];
      const before = c ? getComputedStyle(c, "::before") : null;
      const h = hl[0];
      return {
        focused: document.activeElement === input,
        activedescendant: input.getAttribute("aria-activedescendant"),
        role: input.getAttribute("role"),
        heights: [...new Set(rows.map((r) => box(r).h))],
        count: rows.length,
        highlighted: hl.map((r) => r.id),
        selected: rows.filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.id),
        current: cur.map((r) => r.querySelector(".command-palette-label")?.innerText),
        currentFill: c ? getComputedStyle(c).backgroundColor : null,
        rowActive: c ? tokenColour(c.parentElement, "--row-active-bg") : null,
        rail: before ? { content: before.content, w: parseFloat(before.width), bg: before.backgroundColor } : null,
        brass: c ? tokenColour(c.parentElement, "--primary-bg") : null,
        hlFill: h && !h.hasAttribute("data-current") ? getComputedStyle(h).backgroundColor : null,
        hover: h ? tokenColour(h.parentElement, "--quiet-hover-bg") : null,
        text: textContrast(e2e.first(".command-palette-results")),
      };
    `);
  const a = await read();
  log(`  ${theme}: palette ${a.count} rows, heights ${JSON.stringify(a.heights)}, current ${JSON.stringify(a.current)}`);
  check(a.focused && a.role === "combobox", `${theme}: the palette's field has the keyboard (a combobox)`);
  check(a.count > 5 && a.heights.length === 1 && a.heights[0] === 32, `${theme}: every palette row is 32 px`);
  check(a.highlighted.length === 1 && a.activedescendant === a.highlighted[0] && a.selected[0] === a.highlighted[0], `${theme}: one highlighted row, selected and named by aria-activedescendant`);
  check(a.current.length === 1 && a.current[0] === active.label, `${theme}: the session in view is the palette's current row (${JSON.stringify(a.current)})`);
  check(sameColourNode(a.currentFill, a.rowActive), `${theme}: the current palette row is filled with --row-active-bg`);
  check(!!a.rail && a.rail.content !== "none" && a.rail.w === 2 && sameColourNode(a.rail.bg, a.brass), `${theme}: the current palette row has the 2 px brass rail`);
  check(!!a.hlFill && sameColourNode(a.hlFill, a.hover), `${theme}: the highlighted row takes the quiet hover fill`);
  logContrast(`${theme}: palette`, a.text);
  await bridge.screenshot(join(evidenceDir, `${theme}-palette.png`));
  await pressKey(bridge, { key: "ArrowDown", code: "ArrowDown" });
  await pressKey(bridge, { key: "ArrowDown", code: "ArrowDown" });
  await sleep(150);
  const b = await read();
  const idx = (id) => Number(String(id).split("-").pop());
  check(b.highlighted.length === 1 && idx(b.highlighted[0]) === idx(a.highlighted[0]) + 2 && b.activedescendant === b.highlighted[0], `${theme}: ↓↓ moves the highlight two rows (${a.highlighted[0]} → ${b.highlighted[0]})`);
  logContrast(`${theme}: palette after ↓↓`, b.text);
  // Focus ring of the palette (its field included) while it is open.
  await checkFocus(bridge, `${theme} (palette)`, [".command-palette"], { min: 1 });
  await pressKey(bridge, { key: "Escape", code: "Escape" });
  await bridge.waitFor("Esc to close the palette", `return !e2e.first(".command-palette");`);
  log(`  ok — ${theme}: Esc closed the palette`);
}

// ─── Run ──────────────────────────────────────────────────────────────

let app;
let failed = false;
let undoRegistryPath = null;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (the old current row)" : ""}${NEGATIVE_CLIP ? "   NEGATIVE CONTROL (rings outside clipping containers)" : ""}`);
  undoRegistryPath = addFakeBinToRegistryPath();
  app = await launch();
  const { bridge } = app;
  await completeOnboarding(bridge);
  // Measure the chrome at rest: no transition or entrance animation is
  // half-way when a box, a colour or a ring is read (a CI runner draws the
  // palette's entrance slower than the 300 ms the checks wait). Nothing in
  // the app waits for an animation to end. UI-focus-ring does the same.
  await bridge.eval(`
    const st = document.createElement("style");
    st.dataset.uichromeStill = "";
    st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.appendChild(st);
    return true;
  `);

  log("step 1: two fake Claude sessions ask for permission");
  // Each asks while it is in view (only the pane in view has a terminal to type into).
  const askPermission = async () => {
    const id = await createClaudeSession(bridge);
    await bridge.waitForTerminal(id, /fake-cli: ready/, { timeoutMs: 30_000 }).catch((e) => {
      describeStoppedLaunch(app.child.pid);
      throw e;
    });
    await bridge.typeInTerminal(id, "p");
    await bridge.waitFor(`the strip of ${id} to say needs approval`, `return e2e.first('.session-status-strip[data-strip-session="${id}"]')?.dataset.statusKind === "needs_approval";`, { timeoutMs: 15_000 });
    return id;
  };
  const A = await askPermission();
  const B = await askPermission();
  await bridge.waitFor("the inbox badge to count both", `return Number(e2e.first(".attention-badge")?.dataset.count) === 2;`, { timeoutMs: 15_000 });
  const activeId = await bridge.eval(`return e2e.first(".session-item-active")?.dataset.sessionItemId ?? null;`);
  assert(activeId === B, `the session created last is in view (${activeId})`);
  const activeLabel = await bridge.eval(`return e2e.norm(e2e.first(".session-item-active .session-item-name")?.innerText ?? "");`);
  log(`  sessions: A=${A}, B=${B} ("${activeLabel}")`);
  // Both rows show the model their agent named, and keep it when Hermes's
  // own view of the terminal (no model, the launch's permission mode) is
  // reported after the agent's: the order the CI runners saw.
  const modelTags = () => bridge.eval(`return e2e.all(".session-item-identity-row").map((r) => [...r.querySelectorAll(".session-model-chip")].map((c) => e2e.norm(c.innerText)).join(","));`);
  await bridge.waitFor("both rows to show their agent's model", `return e2e.all(".session-item-identity-row .session-model-chip").length === 2;`, { timeoutMs: 15_000 });
  for (const id of [A, B]) {
    const snap = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)}).identity;`);
    const injected = await bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(id)}, ${JSON.stringify({ type: "identity", at: Date.now(), source: "hermes", vendorSessionId: null, model: null, permissionMode: "acceptEdits" })});`);
    assert(injected, `Hermes's terminal identity (no model) replayed for ${id} after the agent's (${JSON.stringify(snap)})`);
  }
  await sleep(300);
  const tagsAfter = await modelTags();
  assert(tagsAfter.length === 2 && tagsAfter.every((t) => t === "fake-default-model"), `a later identity without a model keeps each row's model tag (${JSON.stringify(tagsAfter)})`);

  // The header chips of a Claude session: the instruction-files chip.
  await bridge.waitFor("the header's instruction-files chip", `return !!e2e.first(".split-pane-label .agent-rules-chip");`, { timeoutMs: 20_000 });

  if (NEGATIVE) {
    log("NEGATIVE CONTROL: the old current row (grey --bg-active fill, no rail)");
    await bridge.eval(`
      const st = document.createElement("style");
      st.textContent = ".h-row[data-current]{background:var(--bg-active)!important;--text-3:#5c5c61!important}.h-row[data-current]::before{content:none!important}";
      document.head.appendChild(st);
      return true;
    `);
  }

  if (NEGATIVE_CLIP) {
    log("NEGATIVE CONTROL: the rings of the strip, header, scope bar and status bar drawn 2 px outside again");
    await bridge.eval(`
      const st = document.createElement("style");
      st.textContent = ".session-status-strip :focus-visible, .split-pane-header :focus-visible, .scope-bar :focus-visible, .status-bar :focus-visible { outline-offset: var(--focus-ring-offset) !important; }";
      document.head.appendChild(st);
      return true;
    `);
  }

  for (const theme of THEMES) {
    log(`theme: ${theme.label}`);
    await pickTheme(bridge, theme);
    assert((await bridge.eval(`return document.documentElement.dataset.theme;`)) === theme.id, `the app is in ${theme.label}`);
    await bridge.screenshot(join(evidenceDir, `${theme.id}-sidebar-header-strip.png`));
    await checkSidebar(bridge, theme.id, B, A);
    await checkHeaderStripBars(bridge, theme.id, B);
    await checkOneClose(bridge, theme.id);
    await checkFocus(bridge, theme.id, [".session-list", ".split-pane-header", ".session-status-strip", ".status-bar", ".activity-bar", ".topbar .attention-center"]);
    await checkActivityLabels(bridge, theme.id);
    // The rings as drawn: the current row's Close, the strip's ⌘I, "+ Add
    // Project", the pane's Close and the status bar's buttons with the
    // simulated focus (one screenshot; each ring shows whole).
    await bridge.eval(`for (const sel of [".session-item-active .session-item-close", ".session-status-strip-inbox", ".scope-bar-add", ".split-pane-close", ".status-bug-btn", ".status-shortcuts-btn"]) e2e.first(sel)?.setAttribute("data-simfocus", ""); return true;`);
    await bridge.screenshot(join(evidenceDir, `${theme.id}-close-focus.png`));
    await bridge.eval(`document.querySelectorAll("[data-simfocus]").forEach((el) => el.removeAttribute("data-simfocus")); return true;`);
    await checkInbox(bridge, theme.id, B);
    await checkPalette(bridge, theme.id, { id: B, label: activeLabel });
  }

  log("⌘I (Ctrl+Shift+I): the current row moves to the agent waiting longest");
  await pressKey(bridge, NEXT_KEY);
  await bridge.waitFor("⌘I to bring the other waiting agent into view", `
    const cur = e2e.all(".session-item-wrapper[data-current]");
    return cur.length === 1 && cur[0].querySelector(".session-item")?.dataset.sessionItemId === ${JSON.stringify(A)};
  `);
  log(`  ok — ⌘I jumped to ${A}; its row is now the only current row`);

  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
  log("all checks passed");
} catch (e) {
  failed = true;
  log(`ERROR: ${e.stack || e.message}`);
  if (app) {
    try {
      await app.bridge.screenshot(join(evidenceDir, "failure.png"));
    } catch {
      /* the app may be gone */
    }
  }
} finally {
  if (app) {
    try {
      const exit = await app.stop();
      log(`  app exited: ${JSON.stringify(exit)}`);
    } catch (e) {
      log(`  (stopping the app failed: ${e.message})`);
    }
  }
  try {
    undoRegistryPath?.();
  } catch (e) {
    log(`  (restoring the registry Path failed: ${e.message})`);
  }
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
