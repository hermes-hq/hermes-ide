#!/usr/bin/env node
// Scenario UI-launch-surfaces: the launch surfaces are built from the control
// set (src/components/ui), on the REAL app, with fake `claude` and `codex`
// CLIs (tools/fake-agents) and a throwaway repository. No real account.
//
// A fresh install with the real 2.0 flag defaults, then every launch surface
// in turn:
//   - the three-step welcome: 1 agents (the agent doctor), 2 repository,
//     3 first task (the task launcher inline);
//   - the ⌘N task launcher: closed, with the where menu open (segmented,
//     field, select), and with + options open (view, fields, checkbox, the
//     second agent's selects);
//   - the New Session creator (Advanced…): the agent step, the SSH form, the
//     folder step, the branch step (both views) and the confirm step.
// On each, in Frosted Dark and in Frosted Light (a screenshot of each):
//   - every visible button, field, select, checkbox and radio is a control
//     of the set (the only exceptions: the agent cards and colour swatches of
//     the creator, which have no control), and no <select> is drawn by the OS;
//   - control heights are 28, 32 or 36 px (chips 28, segmented wells 28/32,
//     checkbox and radio rows at least 32; inline link buttons are text);
//   - no control sticks out of the surface sideways (it would be cut off),
//     on the agent check also with a wider font (as on Windows);
//   - there is exactly one primary button, and exactly one button filled
//     with the brass --primary-bg (so no look-alike primary either);
//   - every control draws the solid focus ring (--focus-ring, ≥ 2 px) when
//     focused from the keyboard. Locally the window has no keyboard focus,
//     so each stylesheet's :focus-visible rules are copied onto an attribute
//     in place (the UI-focus-ring technique); on the Linux and Windows CI
//     runners (HERMES_E2E_OS_KEYS=1) a real Tab is pressed from a field of
//     the surface and the control it reaches must match :focus-visible and
//     draw the ring.
// And what those controls do on the creator:
//   - a plain shell's folder is a radio: picking the chosen folder again
//     (its row, its box's label) keeps it chosen;
//   - on the branch step, a name typed in the New branch form is what the
//     step's Continue uses (the confirm step shows it as a new branch), a
//     name that cannot be created holds Continue back, and the field keeps
//     its element (so the focus) while its error comes and goes.
// The tmux step of the creator needs a reachable SSH server; it is not
// driven here (its rows are the same Radio as the folder list).
//
// Negative controls (each must end in RESULT: FAIL), injected into the
// launcher sheet only:
//   HERMES_E2E_UILAUNCH_BREAK=native-select  an OS-drawn <select>
//   HERMES_E2E_UILAUNCH_BREAK=height         chips forced to 30 px
//   HERMES_E2E_UILAUNCH_BREAK=primary        a second primary button
//   HERMES_E2E_UILAUNCH_BREAK=ring           outline: none on the chips
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/UI-launch-surfaces.mjs

import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { osKeysAvailable, pressChords } from "../os-keys.mjs";
import { dismissWhatsNew, expandOptions, invoke, launcherFixtures, openChip, openLauncher, typeInto } from "../launcher-steps.mjs";

const SCENARIO = "UI-launch-surfaces";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const OS_KEYS = process.env.HERMES_E2E_OS_KEYS === "1";
const BREAK = process.env.HERMES_E2E_UILAUNCH_BREAK || "";
const THEMES = ["frosted-dark", "frosted-light"];

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** A per-surface check: logged, and the run goes on so one log lists every miss. */
const problems = [];
function check(condition, message) {
  if (condition) log(`  ok — ${message}`);
  else {
    log(`  FAILED — ${message}`);
    problems.push(message);
  }
}

/** In-page helpers: the simulated keyboard focus and the audit of a surface. */
const PAGE = String.raw`
window.__uiLaunch = window.__uiLaunch || (() => {
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
  const install = () => {
    for (const sh of document.styleSheets) {
      if (done.has(sh)) continue;
      try { sh.cssRules; } catch (e) { continue; }
      done.add(sh);
      walk(sh);
    }
    if (!document.querySelector("style[data-uilaunch-still]")) {
      const st = document.createElement("style");
      st.dataset.uilaunchStill = "";
      st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
      document.head.appendChild(st);
      done.add(st.sheet);
    }
  };
  const colourOf = (cssValue, prop) => {
    const probe = document.createElement("span");
    probe.style[prop] = cssValue;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe)[prop];
    probe.remove();
    return c;
  };
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const KIT_BUTTON = ["h-btn", "h-icon-btn", "h-chip-button", "h-chip-remove", "h-segment", "h-tab", "h-toggle"];
  // Choices with no control of their own (documented in SessionCreator.css).
  const EXCEPTIONS = [".session-creator-provider-card", ".session-creator-color-swatch"];
  const describe = (el) => el.tagName.toLowerCase() + (el.type && el.tagName !== "BUTTON" ? "[" + el.type + "]" : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "");
  const nameOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.placeholder || el.value || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const isKit = (el) => {
    if (el.tagName === "BUTTON") return KIT_BUTTON.some((c) => el.classList.contains(c));
    if (el.tagName === "INPUT") {
      if (el.type === "checkbox") return el.classList.contains("h-checkbox");
      if (el.type === "radio") return el.classList.contains("h-radio");
      return el.classList.contains("h-input");
    }
    if (el.tagName === "TEXTAREA") return el.classList.contains("h-input");
    if (el.tagName === "SELECT") return el.classList.contains("h-native-select-field");
    return el.classList.contains("h-select-trigger");
  };
  const ALLOWED = [28, 32, 36];
  const near = (h, list) => list.some((x) => Math.abs(h - x) <= 0.5);
  /** The box whose height the rules speak of, and the heights it may have. */
  const sizing = (el) => {
    if (el.classList.contains("h-btn--link")) return null; // inline text
    if (el.classList.contains("h-chip-button") || el.classList.contains("h-chip-remove")) return { box: el.closest(".h-chip"), allowed: ALLOWED };
    if (el.classList.contains("h-segment")) return { box: el.closest(".h-segmented"), allowed: ALLOWED };
    if (el.type === "checkbox" || el.type === "radio") return { box: el.closest(".h-choice"), min: 32 };
    if (el.tagName === "TEXTAREA") return null; // grows with its text
    if (el.tagName === "SELECT") return { box: el.closest(".h-native-select") || el, allowed: ALLOWED };
    if (EXCEPTIONS.some((s) => el.matches(s))) return null;
    return { box: el, allowed: ALLOWED };
  };
  const audit = (rootSel) => {
    const root = document.querySelector(rootSel);
    if (!root) return { error: "no " + rootSel };
    install();
    const ring = colourOf(token("--focus-ring"), "color");
    const brass = colourOf(token("--primary-bg"), "backgroundColor");
    const out = { controls: 0, links: 0, nonKit: [], nativeSelects: [], badHeights: [], heights: {}, primaries: [], brassFilled: [], noRing: [], clipped: [], ringColour: ring };
    const bounds = root.getBoundingClientRect();
    const els = [...root.querySelectorAll('button, input, select, textarea, [role="combobox"]')].filter(visible);
    for (const el of els) {
      out.controls++;
      const what = describe(el) + ' "' + nameOf(el) + '"';
      // Sideways, nothing sticks out of the surface (it would be cut off).
      const r = el.getBoundingClientRect();
      if (r.left < bounds.left - 1 || r.right > bounds.right + 1) out.clipped.push(what + " (" + Math.round(r.left) + "–" + Math.round(r.right) + " in " + Math.round(bounds.left) + "–" + Math.round(bounds.right) + ")");
      const exception = EXCEPTIONS.some((s) => el.matches(s));
      if (!isKit(el) && !exception) out.nonKit.push(what);
      if (el.tagName === "SELECT" && getComputedStyle(el).appearance !== "none") out.nativeSelects.push(what);
      if (el.classList.contains("h-btn--link")) out.links++;
      const s = sizing(el);
      if (s && s.box) {
        const h = +s.box.getBoundingClientRect().height.toFixed(2);
        out.heights[h] = (out.heights[h] || 0) + 1;
        const ok = s.min !== undefined ? h >= s.min - 0.5 : near(h, s.allowed);
        if (!ok) out.badHeights.push(what + " " + h + "px");
      }
      if (el.tagName === "BUTTON") {
        if (el.classList.contains("h-btn--primary")) out.primaries.push(what);
        if (getComputedStyle(el).backgroundColor === brass) out.brassFilled.push(what);
      }
      // Keyboard focus: the ring the stylesheets draw for :focus-visible.
      if (el.tabIndex >= 0 || el.getAttribute("role") === "radio") {
        el.setAttribute("data-simfocus", "");
        const cs = getComputedStyle(el);
        const width = parseFloat(cs.outlineWidth) || 0;
        const good = cs.outlineStyle === "solid" && width >= 2 && cs.outlineColor === ring;
        el.removeAttribute("data-simfocus");
        if (!good) out.noRing.push(what + " (" + cs.outlineStyle + " " + width + "px " + cs.outlineColor + ")");
      }
    }
    return out;
  };
  /**
   * Where a real click lands to give the window the keyboard (page
   * coordinates). The field is scrolled into view first: a click below the
   * fold of a scrolling body would land outside the window.
   */
  const pointOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const cx = r.left + Math.min(12, r.width / 2);
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return { offscreen: true, x: Math.round(cx), y: Math.round(cy), innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit))) return { covered: hit ? describe(hit) : "nothing", x: Math.round(cx), y: Math.round(cy) };
    return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + r.height / 2), innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  };
  const focusedRing = (rootSel, startSel) => {
    const el = document.activeElement;
    const root = document.querySelector(rootSel);
    const ring = colourOf(token("--focus-ring"), "color");
    if (!el || el === document.body || !root) return { moved: false, what: el ? describe(el) : "none" };
    const cs = getComputedStyle(el);
    return {
      moved: el !== document.querySelector(startSel),
      inSurface: root.contains(el),
      focusVisible: el.matches(":focus-visible"),
      hasFocus: document.hasFocus(),
      what: describe(el) + ' "' + nameOf(el) + '"',
      outline: cs.outlineStyle + " " + (parseFloat(cs.outlineWidth) || 0) + "px",
      colourOk: cs.outlineColor === ring,
    };
  };
  return { audit, pointOf, focusedRing, install };
})();
`;

const setTheme = async (bridge, theme) => {
  await bridge.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true;`);
  await sleep(350);
  await bridge.settle();
};

const details = { surfaces: {}, realTab: {}, break: BREAK || null };
let shot = 0;

/**
 * Audits one surface in both themes, screenshots it, and (on CI runners with
 * real keys) presses Tab from `startSel` and checks the ring it lands on.
 */
async function surface(app, name, rootSel, { startSel = null, primaries = 1 } = {}) {
  const { bridge } = app;
  log(`surface: ${name} (${rootSel})`);
  const summary = {};
  for (const theme of THEMES) {
    await setTheme(bridge, theme);
    const a = await bridge.eval(`${PAGE}; return window.__uiLaunch.audit(${JSON.stringify(rootSel)});`);
    if (a.error) {
      check(false, `${name}: ${a.error}`);
      continue;
    }
    shot++;
    await bridge.screenshot(join(evidenceDir, `${String(shot).padStart(2, "0")}-${name}-${theme}.png`));
    summary[theme] = { controls: a.controls, links: a.links, heights: a.heights, primaries: a.primaries, brassFilled: a.brassFilled };
    log(`  ${theme}: ${a.controls} controls (${a.links} inline links), heights ${JSON.stringify(a.heights)}`);
    for (const x of a.nonKit) log(`    NOT FROM THE CONTROL SET  ${x}`);
    for (const x of a.nativeSelects) log(`    OS-DRAWN SELECT  ${x}`);
    for (const x of a.badHeights) log(`    HEIGHT  ${x}`);
    for (const x of a.noRing) log(`    NO RING  ${x}`);
    for (const x of a.clipped) log(`    CUT OFF  ${x}`);
    check(a.controls > 0, `${name} (${theme}): there are controls to check`);
    check(a.clipped.length === 0, `${name} (${theme}): no control sticks out of the surface (${a.clipped.length} do)`);
    check(a.nonKit.length === 0, `${name} (${theme}): every button, field, select, checkbox and radio comes from the control set (${a.nonKit.length} not)`);
    check(a.nativeSelects.length === 0, `${name} (${theme}): no select is drawn by the OS (${a.nativeSelects.length})`);
    check(a.badHeights.length === 0, `${name} (${theme}): control heights are 28 / 32 / 36 px, choice rows ≥ 32 (${a.badHeights.length} off)`);
    check(a.primaries.length === primaries, `${name} (${theme}): ${primaries} primary button (${a.primaries.join(", ") || "none"})`);
    check(a.brassFilled.length === primaries, `${name} (${theme}): ${primaries} button filled with the brass --primary-bg (${a.brassFilled.join(", ") || "none"})`);
    check(a.noRing.length === 0, `${name} (${theme}): every control draws the ${a.ringColour} ring when focused from the keyboard (${a.noRing.length} do not)`);
  }
  details.surfaces[name] = summary;

  if (startSel) {
    // Where a real click would land: checked on every OS, pressed on CI.
    await setTheme(bridge, THEMES[0]);
    const at = await bridge.eval(`${PAGE}; return window.__uiLaunch.pointOf(${JSON.stringify(startSel)});`);
    const clickable = !!at && !at.offscreen && !at.covered;
    check(clickable, `${name}: the field to start Tab from (${startSel}) is there, in the window and on top (${JSON.stringify(at)})`);
    if (!clickable) return;
    if (OS_KEYS) {
      const diag = await pressChords(app.child.pid, ["tab"], { clickAt: at });
      log(`  real Tab from ${startSel}: ${JSON.stringify(diag)}`);
      const got = await bridge
        .waitFor(`focus to move off ${startSel}`, `${PAGE}; const r = window.__uiLaunch.focusedRing(${JSON.stringify(rootSel)}, ${JSON.stringify(startSel)}); return r.moved ? r : false;`, { timeoutMs: 5_000 })
        .catch(async () => bridge.eval(`${PAGE}; return window.__uiLaunch.focusedRing(${JSON.stringify(rootSel)}, ${JSON.stringify(startSel)});`));
      details.realTab[name] = got;
      log(`  after Tab: ${JSON.stringify(got)}`);
      check(got.moved && got.inSurface, `${name}: a real Tab moves the focus onto the next control of the surface (${got.what})`);
      check(got.focusVisible && /^solid [2-9]/.test(got.outline) && got.colourOk, `${name}: that control matches :focus-visible and draws the solid ring (${got.outline})`);
      shot++;
      await bridge.screenshot(join(evidenceDir, `${String(shot).padStart(2, "0")}-${name}-real-tab.png`));
    } else {
      log(`  real Tab: only on the Linux and Windows CI runners (this is ${platform()}${OS_KEYS ? "" : ", HERMES_E2E_OS_KEYS unset"}); the ring was checked on the copied :focus-visible rules above`);
    }
  }
}

/**
 * The same surface with a wider font (Verdana, or DejaVu Sans on Linux, and
 * extra letter spacing): text that fits by a hair on macOS does not on
 * Windows, where the agent check once pushed its buttons out of the welcome.
 */
async function wideFont(bridge, name, rootSel) {
  await bridge.eval(`const st = document.createElement("style"); st.dataset.uilaunchWide = ""; st.textContent = ${JSON.stringify(`${rootSel}, ${rootSel} * { font-family: Verdana, "DejaVu Sans", sans-serif !important; letter-spacing: .04em !important; }`)}; document.head.appendChild(st); return true;`);
  await sleep(300);
  const a = await bridge.eval(`${PAGE}; return window.__uiLaunch.audit(${JSON.stringify(rootSel)});`);
  await bridge.eval(`document.querySelector("style[data-uilaunch-wide]")?.remove(); return true;`);
  await sleep(200);
  for (const x of a.clipped || []) log(`    CUT OFF (wide font)  ${x}`);
  check(!a.error && a.clipped.length === 0, `${name}: with a wider font too, no control sticks out of the surface (${a.error || a.clipped.length})`);
}

/** Breaks the launcher sheet on purpose, for the negative controls. */
async function breakLauncher(bridge) {
  if (!BREAK) return;
  const js = {
    "native-select": `const s = document.createElement("select"); s.innerHTML = "<option>Claude Code</option><option>Codex</option>"; e2e.first(".task-launcher-chips").appendChild(s);`,
    height: `const st = document.createElement("style"); st.textContent = ".task-launcher .h-chip { height: 30px !important; }"; document.head.appendChild(st);`,
    primary: `const b = document.createElement("button"); b.type = "button"; b.className = "h-btn h-btn--primary h-btn--md"; b.textContent = "Launch too"; e2e.first(".task-launcher-actions").appendChild(b);`,
    ring: `const st = document.createElement("style"); st.textContent = ".task-launcher .h-chip-button:focus-visible { outline: none !important; }"; document.head.appendChild(st);`,
  }[BREAK];
  if (!js) throw new Error(`unknown HERMES_E2E_UILAUNCH_BREAK=${BREAK} (native-select, height, primary, ring)`);
  await bridge.eval(`${js} return true;`);
  log(`  NEGATIVE CONTROL: ${BREAK} injected into the launcher sheet`);
}

const fx = launcherFixtures("uilaunch", log);
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-uilaunch-home-"));
let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   real Tab: ${OS_KEYS ? "yes" : "no"}${BREAK ? `   NEGATIVE CONTROL: ${BREAK}` : ""}`);
  if (OS_KEYS && !osKeysAvailable()) throw new Error("HERMES_E2E_OS_KEYS=1 needs a Linux or Windows CI runner (CI=true); never on macOS");

  const runDir = join(evidenceDir, "run-1");
  const common = { runDir, log, flagDefaults: null, env: { HERMES_FAKE_DIR: fx.recordDir, HERMES_E2E_AGENT_PATH: fx.fakeBin } };
  app = await (onWindows ? launchApp({ ...common, home: "real", resetData: true }) : launchApp({ ...common, home: "private", homeDir }));
  const { bridge } = app;

  // ── The three-step welcome ─────────────────────────────────────────
  log("step 1: the three-step welcome (a fresh install, the real flag defaults)");
  await bridge.waitFor("the welcome's agent check", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "agents" && e2e.all("tr.agent-doctor-row").length >= 2 && e2e.first(".agent-doctor")?.getAttribute("data-loading") === "false";`, { timeoutMs: 60_000 });
  // A project, so the repository step lists it as a recent one (its radios).
  await invoke(bridge, "create_project", { path: fx.repo, name: null });
  await surface(app, "welcome-1-agents", ".setup-dialog", { startSel: "#setup-policy-accept" });
  await wideFont(bridge, "welcome-1-agents", ".setup-dialog");
  await bridge.clickWhenReady(`const box = e2e.must(e2e.first("#setup-policy-accept"), "policy"); return box.checked ? true : e2e.click(box);`);
  await bridge.waitFor("Continue to be enabled", `return !e2e.first(".setup-continue").disabled;`);
  await bridge.click(".setup-continue");
  await bridge.waitFor("the repository step with its recent repository", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo" && e2e.all(".setup-recent input[type=radio]").length >= 1;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`const r = e2e.all(".setup-recent input[type=radio]")[0]; return r.checked ? true : e2e.click(r);`);
  await bridge.waitFor("the repository to be accepted", `return e2e.first(".setup-repo-state")?.getAttribute("data-git") === "true";`, { timeoutMs: 20_000 });
  await surface(app, "welcome-2-repo", ".setup-dialog", { startSel: ".setup-repo-input" });
  await bridge.click(".setup-continue");
  await bridge.waitFor("the first-task step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task" && e2e.first(".setup-dialog .task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
  await surface(app, "welcome-3-task", ".setup-dialog", { startSel: ".task-launcher-task" });
  const finishIsPrimary = await bridge.eval(`return e2e.first(".setup-finish")?.classList.contains("h-btn--primary") && !e2e.first(".setup-dialog .task-launcher-launch")?.classList.contains("h-btn--primary");`);
  check(finishIsPrimary, "welcome step 3: Finish is the step's primary, the inline launcher's Launch is not");
  await bridge.click(".setup-finish");
  await bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop, .setup-pill");`, { timeoutMs: 20_000 });
  await dismissWhatsNew(bridge);

  // ── The ⌘N task launcher ───────────────────────────────────────────
  log("step 2: the ⌘N task launcher");
  await openLauncher(bridge);
  await breakLauncher(bridge);
  await surface(app, "launcher", ".task-launcher-sheet", { startSel: ".task-launcher-task" });
  // A new worktree is the starting choice: its menu shows the branch and base fields.
  await openChip(bridge, "where");
  await bridge.waitFor("the where menu's fields", `return !!e2e.first(".task-launcher-menu .task-launcher-branch") && !!e2e.first(".task-launcher-menu .task-launcher-base");`);
  await surface(app, "launcher-where", ".task-launcher-sheet", { startSel: ".task-launcher-menu .task-launcher-branch" });
  // The base branch list, open: the control set's listbox, not the OS one.
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".task-launcher-menu .task-launcher-base"), "base branch"));`);
  const list = await bridge.waitFor("the base branch list", `
    const t = e2e.first(".task-launcher-menu .task-launcher-base");
    const l = t && document.getElementById(t.getAttribute("aria-controls"));
    return l && !l.hidden ? { options: [...l.querySelectorAll('[role="option"]')].map((o) => o.getAttribute("data-value")), expanded: t.getAttribute("aria-expanded") } : false;
  `);
  check(list.expanded === "true" && list.options.includes("develop"), `the base branch opens as a listbox with the repository's branches (${JSON.stringify(list.options)})`);
  for (const theme of THEMES) {
    await setTheme(bridge, theme);
    shot++;
    await bridge.screenshot(join(evidenceDir, `${String(shot).padStart(2, "0")}-launcher-base-list-${theme}.png`));
  }
  await bridge.eval(`e2e.first(".task-launcher-menu .task-launcher-base").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
  await bridge.waitFor("the list to close, the sheet to stay", `return e2e.first(".task-launcher-menu .task-launcher-base")?.getAttribute("aria-expanded") === "false" && !!e2e.first(".task-launcher-sheet");`);
  await bridge.click('[data-chip="where"]');
  await bridge.waitFor("the where menu to close", `return !e2e.first(".task-launcher-menu");`);
  await expandOptions(bridge);
  await bridge.clickWhenReady(`const b = e2e.must(e2e.first(".task-launcher-also-toggle"), "also on"); return b.getAttribute("aria-pressed") === "true" ? true : e2e.click(b);`);
  await bridge.waitFor("the second agent's selects", `return !!e2e.first(".task-launcher-also-agent");`);
  await surface(app, "launcher-options", ".task-launcher-sheet", { startSel: ".task-launcher-extra-args" });

  // ── The New Session creator ────────────────────────────────────────
  log("step 3: the New Session creator (Advanced…)");
  await bridge.click(".task-launcher-advanced");
  await bridge.waitFor("the creator's agent step", `return !e2e.first(".task-launcher-sheet") && e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  // A plain shell first: its folder list is a radio group.
  await bridge.click(".session-creator-provider-card:not([data-agent-id])");
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the shell's folder radios", `return e2e.all(".session-creator-list .project-picker-item input[type=radio]").length > 0;`, { timeoutMs: 20_000 });
  const repoRow = `e2e.must(e2e.all(".session-creator-list .project-picker-item").find((r) => r.innerText.includes("launcher-repo")), "the fixture repository's row")`;
  const radioState = `const row = ${repoRow}; return { row: row.classList.contains("project-picker-item-attached"), box: row.querySelector("input[type=radio]").checked, rows: e2e.all(".session-creator-list .project-picker-item-attached").length };`;
  await bridge.clickWhenReady(`const row = ${repoRow}; return row.classList.contains("project-picker-item-attached") ? true : e2e.click(row);`);
  await bridge.waitFor("the shell's folder chosen", `const row = ${repoRow}; return row.classList.contains("project-picker-item-attached");`);
  await bridge.eval(`const row = ${repoRow}; return e2e.click(e2e.must(row.querySelector(".project-picker-name"), "its label"));`);
  await sleep(200);
  const afterLabel = await bridge.eval(radioState);
  await bridge.eval(`const row = ${repoRow}; return e2e.click(row);`);
  await sleep(200);
  const afterRow = await bridge.eval(radioState);
  log(`  shell folder picked again: by its label ${JSON.stringify(afterLabel)}, by its row ${JSON.stringify(afterRow)}`);
  check(afterLabel.row && afterLabel.box && afterLabel.rows === 1, "a plain shell's folder stays chosen when its label is clicked again");
  check(afterRow.row && afterRow.box && afterRow.rows === 1, "a plain shell's folder stays chosen when its row is clicked again");
  await bridge.clickByName("Back", { within: ".session-creator-actions" });
  await bridge.waitFor("the agent step again", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.click('.session-creator-provider-card[data-agent-id="claude"]');
  await bridge.waitFor("Claude's options", `return !!e2e.first(".session-creator-permission-pill-active") && !!e2e.first(".session-creator-agent-view input[type=checkbox]");`);
  await surface(app, "creator-1-agent", ".session-creator", { startSel: ".session-creator-custom-suffix-input" });
  await bridge.click(".session-creator-ssh-link");
  await bridge.waitFor("the SSH form", `return !!e2e.first(".session-creator-ssh-fields");`);
  await surface(app, "creator-ssh", ".session-creator", { startSel: ".session-creator-ssh-fields input" });
  await bridge.clickByName("Back", { within: ".session-creator-actions" });
  await bridge.waitFor("the agent step again", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input") && e2e.all(".session-creator-list .project-picker-item").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const row = e2e.all(".session-creator-list .project-picker-item").find((r) => r.innerText.includes("launcher-repo"));
    e2e.must(row, "the fixture repository's row");
    return row.classList.contains("project-picker-item-attached") ? true : e2e.click(row);
  `);
  await bridge.waitFor("the repository picked", `return e2e.all(".session-creator-list .project-picker-item-attached").length === 1;`);
  await surface(app, "creator-2-folders", ".session-creator", { startSel: ".session-creator-filter" });
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-branch-multi");`, { timeoutMs: 30_000 });
  // The default new branch is chosen on its own and the project folds; open it again.
  await bridge.waitFor("a default branch to be chosen", `return !!e2e.first(".session-creator-branch-selected-label");`, { timeoutMs: 20_000 });
  await sleep(300);
  await bridge.clickWhenReady(`return e2e.first(".branch-selector-body") ? true : e2e.click(e2e.must(e2e.first(".session-creator-branch-project-header"), "project header"));`);
  await bridge.waitFor("the branch picker", `return !!e2e.first(".branch-selector-tabs");`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".branch-selector-tabs [role=radio]")[1], "New branch"));`);
  await bridge.waitFor("the new-branch form", `return !!e2e.first(".branch-selector-field-select");`);
  await surface(app, "creator-3-branch-new", ".session-creator", { startSel: ".branch-selector-field-input" });
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".branch-selector-tabs [role=radio]")[0], "Existing branch"));`);
  await bridge.waitFor("the branch list", `return e2e.all(".branch-selector-item").length > 0;`);
  await surface(app, "creator-3-branch-existing", ".session-creator", { startSel: ".branch-selector-filter" });
  // A name typed in the New branch form, then the step's own Continue.
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".branch-selector-tabs [role=radio]")[1], "New branch"));`);
  await bridge.waitFor("the new-branch form", `return !!e2e.first(".branch-selector-field-input");`);
  await bridge.eval(`e2e.first(".branch-selector-field-input").dataset.uilaunchMark = "1"; return true;`);
  const continueState = `const b = e2e.first(".session-creator-footer-actions .session-creator-btn-primary"); const f = e2e.first(".branch-selector-field-input"); return { disabled: !!b?.disabled, error: e2e.norm(e2e.first(".branch-selector-validation-error")?.innerText || ""), sameField: !!f && f.dataset.uilaunchMark === "1", describedBy: !!f && !!f.getAttribute("aria-describedby") };`;
  await typeInto(bridge, ".branch-selector-field-input", "develop");
  const taken = await bridge
    .waitFor("the name's error", `const s = (() => { ${continueState} })(); return s.error ? s : false;`, { timeoutMs: 10_000 })
    .catch(() => bridge.eval(continueState));
  log(`  typed an existing branch's name: ${JSON.stringify(taken)}`);
  check(/already exists/.test(taken.error) && taken.disabled, "a typed name that cannot be created holds the branch step's Continue back");
  check(taken.sameField && taken.describedBy, "the name field keeps its element (and the focus) while its error shows, and names the error");
  await typeInto(bridge, ".branch-selector-field-input", "ui/typed-by-hand");
  const typed = await bridge
    .waitFor("Continue to take the typed name", `const s = (() => { ${continueState} })(); return !s.disabled && !s.error ? s : false;`, { timeoutMs: 10_000 })
    .catch(() => bridge.eval(continueState));
  check(!typed.disabled && typed.sameField, "a valid typed name lets Continue go on, in the same field");
  await bridge.click(".session-creator-footer-actions .session-creator-btn-primary");
  await bridge.waitFor("the confirm step", `return !!e2e.first(".session-creator-name");`, { timeoutMs: 20_000 });
  const summary = await bridge.eval(`return e2e.norm(e2e.first(".session-creator-summary")?.innerText || "");`);
  log(`  confirm step: ${summary}`);
  check(/Branch:\s*ui\/typed-by-hand \(new\)/.test(summary), "the confirm step shows the typed name as the new branch (Continue committed it without Create & use)");
  await surface(app, "creator-4-confirm", ".session-creator", { startSel: ".session-creator-name" });
  await bridge.click(".session-creator-close");
  await bridge.waitFor("the creator to close", `return !e2e.first(".session-creator");`);

  assert(problems.length === 0, `every launch surface is built from the control set and behaves (${problems.length} check(s) failed)`);
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
  if (!failed) fx.cleanup();
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details });
