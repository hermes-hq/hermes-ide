#!/usr/bin/env node
// Scenario UI-review-settings (track UI-C): the Review Desk, the Land sheet,
// the turn sheet, Settings and the agent composer's pickers are built from
// the control set (src/components/ui), on the REAL app, in Frosted Dark and
// Frosted Light.
//
// A throwaway git repository (synthetic identity), a plain shell session on
// it (its own worktree) with two changed files and one recorded turn (turn
// start/end injected as exact signals), and an Agent view session on a fake
// Claude bridge (e2e/app/fixtures/fake-claude-bridge.mjs through
// HERMES_BRIDGE_PATH; no account, no network). For each theme:
//
//   Settings     the nav is a vertical tab list, 32 px rows at 13 px, the
//                current row filled with a brass rail, ↓ moves and selects;
//                on General, Git, Plugins and Privacy every on/off is a switch
//                (role=switch, no checkbox left) and every choice a styled
//                select; Export/Import are control-set buttons whose text
//                meets 4.5:1; a real click on a switch saves the setting;
//                the window-size boxes are named apart (width / height).
//   Folders      the command palette's Folders panel has the set's close button.
//   Review Desk  Review / Repository / Worktrees are tabs with the brass rail;
//                By file / By turn is a segmented control (→ picks By turn);
//                each file's viewed box is the control-set checkbox; every
//                button of the Changes section (each file's Open / Discard /
//                Stage, the Discard confirm as a danger button, Commit / Pull
//                / Push) is a control-set button.
//   Land sheet   radios, the archive checkbox, the message box and the footer
//                buttons are the control set, with one primary.
//   Turn sheet   Close/Restore and the restore confirm (solid danger).
//   Pickers      the model, effort and permission chips open the kit Menu
//                with ↓ / ↑; Home/End jump; type-ahead moves ("o" → Opus);
//                Enter picks, Esc closes and gives focus back to the chip;
//                each menu's note says that a change restarts Claude.
//
// Everywhere: every control's height is its size's (28/32/36; toggle 18,
// box 16, chip 24/28), every control's text meets 4.5:1 on what it is drawn
// on, and the focus ring (each stylesheet's :focus-visible rules, copied in
// place so the cascade is the app's own — the test window has no keyboard
// focus locally) is a solid 2 px outline 2 px away at ≥ 3:1. Screenshots of
// every surface in both themes go to the evidence folder.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_UIRS_NEGATIVE=keys      the pickers get only Esc, like the old
//                                      ones (a capturing listener eats the
//                                      rest before React sees it)
//   HERMES_E2E_UIRS_NEGATIVE=ring      `outline: none` on focused controls in
//                                      Settings, the way the old rules did
//   HERMES_E2E_UIRS_NEGATIVE=checkbox  a native checkbox is put back into
//                                      Settings > General
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/UI-review-settings.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_FLAG_DEFAULTS, REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { invoke, menuAction, setInput } from "../fleet-steps.mjs";
import { sendAgentMessage, startAgentViewSession } from "../agent-setup-steps.mjs";

const SCENARIO = "UI-review-settings";
const NEGATIVE = process.env.HERMES_E2E_UIRS_NEGATIVE || "";
const onWindows = platform() === "win32";
const THEMES = ["frosted-dark", "frosted-light"];
const SHELL_LABEL = "uirs-shell";

/** In-page helpers: colours, contrast, the simulated focus and the measurements. */
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
  throw new Error("unreadable colour: " + s);
};
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = ({ r, g, b }) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
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
const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
const name = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 40);
const disabled = (el) => el.disabled || !!el.closest('[aria-disabled="true"], :disabled, .h-choice--disabled');

/** The size every control of the set must have. */
const EXPECT = [
  // A link button is inline text: it has no control height.
  [".h-btn--sm:not(.h-btn--link)", 28], [".h-btn--md:not(.h-btn--link)", 32], [".h-btn--lg:not(.h-btn--link)", 36],
  [".h-icon-btn--sm", 28], [".h-icon-btn--md", 32],
  ["input.h-input--sm", 28], ["input.h-input--md", 32], ["select.h-input--md", 32], ["select.h-input--sm", 28],
  [".h-tab", 32], [".h-segmented--sm", 28], [".h-segmented--md", 32],
  [".h-toggle", 18], [".h-checkbox", 16], [".h-radio", 16],
  [".h-chip--sm", 24], [".h-chip--md", 28],
];
window.__uirs = {
  /**
   * Every control of the set under root: its height against its size's.
   * Layout heights (offsetHeight): a dialog's scale-in transform must not
   * count, and a slow runner may still be running it.
   */
  heights(root) {
    const out = [];
    for (const [sel, want] of EXPECT) {
      for (const el of root.querySelectorAll(sel)) {
        if (!shown(el)) continue;
        const h = +el.offsetHeight;
        out.push({ sel, want, h, ok: Math.abs(h - want) <= 0.5, what: name(el) });
      }
    }
    return out;
  },
  /** Text of every control of the set under root against what it is drawn on. */
  contrast(root) {
    const out = [];
    const sel = ".h-btn, .h-tab, .h-segment, select.h-input, .h-chip-button, .h-choice-label, .h-option-label";
    for (const el of root.querySelectorAll(sel)) {
      if (!shown(el) || disabled(el) || !(el.innerText || el.value || "").trim()) continue;
      const bg = backdrop(el);
      const fg = over(rgb(getComputedStyle(el).color), bg);
      const r = +ratio(fg, bg).toFixed(2);
      out.push({ what: name(el), cls: String(el.className).slice(0, 70), ratio: r, fg: hex(fg), bg: hex(bg), ok: r >= 4.5 });
    }
    return out;
  },
  /** Controls in root that are not from the set (a native box, an unstyled select). */
  legacy(root) {
    const out = [];
    for (const el of root.querySelectorAll('input[type="checkbox"]:not(.h-checkbox), input[type="radio"]:not(.h-radio), select:not(.h-native-select-field)')) {
      if (shown(el)) out.push(el.outerHTML.slice(0, 90));
    }
    return out;
  },
  /** The ring each control draws with the focus rules applied. */
  ring(els) {
    return els.map((el) => {
      el.setAttribute("data-simfocus", "");
      const cs = getComputedStyle(el);
      const out = { what: name(el) || el.className, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0, offset: parseFloat(cs.outlineOffset) || 0, colour: cs.outlineColor };
      el.removeAttribute("data-simfocus");
      let c;
      try { c = rgb(out.colour); } catch (e) { c = null; }
      // An inset ring (negative offset) is drawn on the control itself.
      const bg = out.offset < 0 ? backdrop(el) : backdrop(el, false);
      out.ratio = c && c.a > 0 ? +ratio(over(c, bg), bg).toFixed(2) : 0;
      out.ok = out.style === "solid" && out.width >= 2 && out.ratio >= 3;
      return out;
    });
  },
};
// Copies of every stylesheet's :focus / :focus-visible rules, right after
// them, with the pseudo-class replaced by [data-simfocus]: same sheet, same
// place, same specificity, so the app's own cascade decides.
window.__uirsFocus = window.__uirsFocus || (() => {
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
      if (!document.querySelector("style[data-uirs-still]")) {
        const st = document.createElement("style");
        st.dataset.uirsStill = "";
        st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
        document.head.appendChild(st);
        done.add(st.sheet);
      }
      return true;
    },
  };
})();
`;

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? `   NEGATIVE CONTROL: ${NEGATIVE}` : ""}`);
  /** A per-control check: logged, and the run goes on so one log lists every miss. */
  const problems = [];
  const check = (condition, message) => {
    if (condition) log(`  ok — ${message}`);
    else {
      log(`  FAILED — ${message}`);
      problems.push(message);
    }
  };

  // ── A throwaway repository (synthetic identity) and the fake bridge ──
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-uirs-")));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  const repo = join(work, "uirs-repo");
  const homeDir = onWindows ? undefined : join(work, "home");
  if (homeDir) mkdirSync(homeDir, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Hermes Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Hermes Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const gitIn = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  for (const [k, v] of [["user.name", "Hermes Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    gitIn(repo, "config", k, v);
  }
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.js"), "export const a = 1;\n");
  writeFileSync(join(repo, "README.md"), "# uirs\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "base");
  const bridgeCopy = join(work, "fake-claude-bridge.mjs");
  copyFileSync(join(REPO_ROOT, "e2e", "app", "fixtures", "fake-claude-bridge.mjs"), bridgeCopy);
  log(`  throwaway repo ${repo}`);

  const env = { HERMES_BRIDGE_PATH: bridgeCopy };
  const runDir = join(evidenceDir, "run-1");
  const app = await (onWindows
    ? launchApp({ runDir, log, home: "real", resetData: true, env, flagDefaults: E2E_FLAG_DEFAULTS })
    : launchApp({ runDir, log, home: "private", homeDir, env, flagDefaults: E2E_FLAG_DEFAULTS }));
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);
  await bridge.eval(`${PAGE}; return true;`);

  if (NEGATIVE === "ring") {
    await bridge.eval(`
      const st = document.createElement("style");
      st.textContent = ".settings-panel :focus-visible, .settings-panel :focus { outline: none; }";
      document.head.appendChild(st);
      return true;
    `);
    log("  NEGATIVE CONTROL: outline: none on focused controls in Settings");
  }
  if (NEGATIVE === "keys") {
    await bridge.eval(`
      document.addEventListener("keydown", (e) => {
        const t = e.target;
        const inPicker = t && t.closest && (t.closest('[role="menu"]') || t.closest(".composer-chip"));
        if (inPicker && e.key !== "Escape") e.stopPropagation();
      }, true);
      return true;
    `);
    log("  NEGATIVE CONTROL: the pickers get only Esc");
  }

  // ── Sessions ──────────────────────────────────────────────────────
  log("setup: a plain shell session on the repository (its own worktree)");
  const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";
  const clickPrimary = async (what) => {
    const r = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return { clicked: null };
      return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
    `);
    log(`  wizard ${what}: ${r.clicked === null ? "already closed" : `clicked "${r.clicked}"`}`);
    await sleep(300);
  };
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.click(".activity-bar-left > .activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await clickPrimary("agent");
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`, { timeoutMs: 20_000 });
  await setInput(bridge, ".session-creator-scan-input", repo);
  await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  await bridge.waitFor("the test repo to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("uirs-repo"));
  `);
  await clickPrimary("folder");
  for (let i = 0; i < 6 && (await bridge.exists(".session-creator")); i++) {
    await bridge.eval(`
      const el = e2e.first('input.session-creator-name[placeholder="Session name (optional)"]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      el.focus();
      setter.call(el, ${JSON.stringify(SHELL_LABEL)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await clickPrimary(`step ${i + 1}`);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const shellId = await bridge.waitFor("the new terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  const session = (await invoke(bridge, "get_sessions")).find((s) => s.id === shellId);
  const wt = realpathSync.native(session.working_directory);
  log(`  session ${shellId} works in ${wt}`);
  await bridge.waitFor("the shell to start", `
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(shellId)});
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(shellId)}) || [];
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  // The turn baseline is taken in the background when the session opens.
  await sleep(1500);

  log("setup: one recorded turn that changes two files");
  const inject = (event) => bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(shellId)}, ${JSON.stringify(event)});`);
  assert(await inject({ type: "turn_start", at: Date.now(), n: 1, source: "e2e" }), "turn_start injected");
  // The ledger takes the turn's starting snapshot in the background.
  await sleep(1500);
  writeFileSync(join(wt, "src", "app.js"), "export const a = 2;\nexport const b = 3;\n");
  writeFileSync(join(wt, "README.md"), "# uirs\n\nchanged by the agent\n");
  await sleep(300);
  assert(await inject({ type: "turn_end", at: Date.now(), n: 1, source: "e2e" }), "turn_end injected");
  const chip = `.turn-bar[data-session-id="${shellId}"] .turn-bar-turn[data-turn-n="1"]`;
  await bridge.waitFor("the T1 chip", `return !!document.querySelector(${JSON.stringify(chip)});`, { timeoutMs: 20_000 });

  log("setup: an Agent view session on the fake Claude bridge");
  // A folder of its own: the repository is already the first session's project.
  const agentFolder = join(work, "uirs-agent");
  mkdirSync(agentFolder, { recursive: true });
  writeFileSync(join(agentFolder, "notes.md"), "synthetic\n");
  await startAgentViewSession(bridge, log, { folder: agentFolder });
  // The view mounts its composer a moment after the session opens (a slow
  // runner showed neither the composer nor its button right away).
  await bridge.waitFor("the Agent view composer", `return !!e2e.first(".session-composer-input, .session-composer-fab");`, { timeoutMs: 20_000 });
  await sendAgentMessage(bridge, log, "hello");
  await bridge.waitFor("the fake agent's reply", `return document.body.innerText.includes("fake reply: hello");`, { timeoutMs: 30_000 });
  await bridge.waitFor("the composer's model chip", `return !!e2e.first(".composer-chip-model");`, { timeoutMs: 20_000 });

  // ── Helpers ───────────────────────────────────────────────────────
  const shot = (file) => bridge.screenshot(join(evidenceDir, file));
  const measureAll = async (where, rootSel, { sized = true } = {}) => {
    await bridge.eval(`window.__uirsFocus.install(); return true;`);
    const r = await bridge.eval(`${PAGE}; const root = e2e.must(document.querySelector(${JSON.stringify(rootSel)}), ${JSON.stringify(rootSel)}); return { heights: window.__uirs.heights(root), contrast: window.__uirs.contrast(root), legacy: window.__uirs.legacy(root) };`);
    const badH = r.heights.filter((x) => !x.ok);
    const badC = r.contrast.filter((x) => !x.ok);
    for (const x of badH) log(`    HEIGHT ${x.sel} "${x.what}" is ${x.h}, not ${x.want}`);
    for (const x of badC) log(`    CONTRAST "${x.what}" .${x.cls} ${x.fg} on ${x.bg} = ${x.ratio}:1`);
    for (const x of r.legacy) log(`    LEGACY ${x}`);
    check((!sized || r.heights.length > 0) && badH.length === 0, `${where}: all ${r.heights.length} controls have their size's height`);
    check(r.contrast.length > 0 && badC.length === 0, `${where}: all ${r.contrast.length} control texts meet 4.5:1 (lowest ${Math.min(...r.contrast.map((x) => x.ratio))}:1)`);
    check(r.legacy.length === 0, `${where}: no native checkbox, radio or unstyled select is left`);
    return r;
  };
  const ringOf = async (where, js) => {
    await bridge.eval(`window.__uirsFocus.install(); return true;`);
    const rows = await bridge.eval(`${PAGE}; const els = (() => { ${js} })().filter(Boolean); return window.__uirs.ring(els);`);
    for (const x of rows.filter((y) => !y.ok)) log(`    NO RING "${x.what}": ${x.style} ${x.width}px ${x.colour} (${x.ratio}:1)`);
    check(rows.length > 0 && rows.every((x) => x.ok), `${where}: the ${rows.length} controls checked draw the solid 2 px ring at ≥ 3:1 (${rows.map((x) => x.ratio).join(", ")})`);
  };
  const openSettings = async () => {
    if (!(await bridge.exists(".settings-panel"))) await bridge.clickByName("Settings");
    await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
    // The panel scales in (98% → 100%); sizes are read once that is over, or
    // a slow runner measures 32 px rows as 31.36.
    await bridge.waitFor("the Settings panel to finish opening", `
      const p = document.querySelector(".settings-panel");
      return !!p && p.getAnimations({ subtree: true }).every((a) => a.playState !== "running");
    `);
  };
  const closeSettings = async () => {
    await bridge.click(".settings-close");
    await bridge.waitFor("Settings to close", `return !e2e.first(".settings-panel");`);
  };
  const settingsTab = async (label) => {
    await bridge.clickWhenReady(`
      const tab = e2e.all('.settings-tabs [role="tab"]').find((el) => e2e.norm(el.innerText) === ${JSON.stringify(label)});
      return e2e.click(e2e.must(tab, ${JSON.stringify(label + " tab")}));
    `);
    await bridge.waitFor(`the ${label} tab`, `return e2e.norm(e2e.first('.settings-tabs [aria-selected="true"]')?.innerText ?? "") === ${JSON.stringify(label)};`);
    await sleep(200);
  };
  const setTheme = async (id) => {
    await openSettings();
    await settingsTab("Appearance");
    await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first('.settings-theme-item[data-theme-id="${id}"] button'), "the ${id} chip"));`);
    await bridge.waitFor(`the ${id} chip to be pressed`, `return e2e.first('.settings-theme-item[data-theme-id="${id}"] button')?.getAttribute("aria-pressed") === "true";`);
    await bridge.waitFor(`the ${id} theme`, `return document.documentElement.dataset.theme === ${JSON.stringify(id)};`);
    // Leave the grid so a hover preview never stands in for the saved theme.
    await bridge.eval(`e2e.first(".settings-theme-grid")?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false })); return true;`);
    await closeSettings();
    await sleep(400);
  };
  const focusSession = async (label) => {
    await bridge.clickWhenReady(`
      const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
      return e2e.click(e2e.must(item, "session ${label}"));
    `);
    await sleep(400);
  };
  const keyOn = (sel, k) =>
    bridge.eval(`
      const el = e2e.must(document.querySelector(${JSON.stringify(sel)}), ${JSON.stringify(sel)});
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
      return true;
    `);
  const keyMenu = (k) =>
    bridge.eval(`
      const m = document.querySelector('[role="menu"]:not([hidden])') || document.activeElement;
      m.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
      return true;
    `);
  const menuState = () =>
    bridge.eval(`
      const m = document.querySelector('[role="menu"]:not([hidden])');
      if (!m) return { open: false };
      const id = m.getAttribute("aria-activedescendant");
      const act = id ? document.getElementById(id) : null;
      return { open: true, label: m.getAttribute("aria-label"), active: act ? e2e.norm(act.querySelector(".h-option-label")?.innerText ?? "") : null, focusInMenu: m.contains(document.activeElement) || document.activeElement === m };
    `);
  const waitMenu = (what, pred) => bridge.waitFor(what, `
    const m = document.querySelector('[role="menu"]:not([hidden])');
    const id = m && m.getAttribute("aria-activedescendant");
    const act = id ? document.getElementById(id) : null;
    const s = { open: !!m, active: act ? e2e.norm(act.querySelector(".h-option-label")?.innerText ?? "") : null };
    return (${pred})(s) ? s : null;
  `, { timeoutMs: 4_000 }).catch(() => null);

  /** The open menu's footer note: shown, describing the menu, and saying `text`. */
  const footerSays = async (text) => {
    const f = await bridge.eval(`
      const m = document.querySelector('[role="menu"]:not([hidden])');
      const foot = m && m.querySelector(".h-menu-footer");
      return foot ? { text: e2e.norm(foot.innerText), describes: m.getAttribute("aria-describedby") === foot.id, item: foot.getAttribute("role") } : null;
    `);
    log(`  menu footer: ${JSON.stringify(f)}`);
    return !!f && f.text.includes(text) && f.describes && f.item === "none";
  };

  for (const theme of THEMES) {
    const dark = theme === "frosted-dark";
    log(`══ ${theme} ══`);
    await setTheme(theme);

    // ── Settings ─────────────────────────────────────────────────────
    log(`${theme}: Settings`);
    await openSettings();
    await settingsTab("General");
    if (NEGATIVE === "checkbox") {
      await bridge.eval(`
        const g = document.createElement("label");
        g.className = "settings-group";
        g.innerHTML = '<input type="checkbox" checked> Old checkbox';
        document.querySelector(".settings-content .settings-section").prepend(g);
        return true;
      `);
      log("  NEGATIVE CONTROL: a native checkbox is back in Settings > General");
    }
    const nav = await bridge.eval(`
      const list = e2e.must(document.querySelector('.settings-tabs[role="tablist"]'), "the settings tab list");
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const sel = tabs.find((t) => t.getAttribute("aria-selected") === "true");
      const cs = getComputedStyle(sel);
      const rail = getComputedStyle(sel, "::after");
      const root = getComputedStyle(document.documentElement);
      return {
        orientation: list.getAttribute("aria-orientation"),
        count: tabs.length,
        heights: tabs.map((t) => +t.offsetHeight),
        fonts: [...new Set(tabs.map((t) => getComputedStyle(t).fontSize))],
        tabStops: tabs.filter((t) => t.tabIndex === 0).length,
        selectedBg: cs.backgroundColor,
        railBg: rail.backgroundColor, railW: rail.width,
        rowActive: root.getPropertyValue("--row-active-bg").trim(),
        primary: root.getPropertyValue("--primary-bg").trim(),
      };
    `);
    log(`  nav: ${JSON.stringify(nav)}`);
    check(nav.orientation === "vertical" && nav.count >= 8 && nav.tabStops === 1, `Settings nav is a vertical tab list with one tab stop (${nav.count} tabs)`);
    check(nav.heights.every((h) => Math.abs(h - 32) <= 0.5), `Settings tabs are 32 px rows (${[...new Set(nav.heights)].join(", ")})`);
    // Settings at its smallest height (the resize handle's minimum, and what
    // a short window gives): the rows keep 32 px and the list scrolls.
    const short = await bridge.eval(`
      const panel = e2e.must(document.querySelector(".settings-panel"), "the settings panel");
      const was = panel.style.height;
      panel.style.height = "360px";
      const list = document.querySelector('.settings-tabs[role="tablist"]');
      const heights = [...list.querySelectorAll('[role="tab"]')].map((t) => +t.offsetHeight);
      const out = { heights: [...new Set(heights)], scrolls: list.scrollHeight > list.clientHeight };
      panel.style.height = was;
      return out;
    `);
    check(short.heights.every((h) => Math.abs(h - 32) <= 0.5), `in a 360 px tall Settings the tabs stay 32 px (${short.heights.join(", ")}; the list scrolls: ${short.scrolls})`);
    check(nav.fonts.length === 1 && nav.fonts[0] === "13px", `Settings tabs are 13 px (${nav.fonts.join(", ")})`);
    check(nav.railW === "2px" && !/rgba\(0, 0, 0, 0\)|transparent/.test(nav.railBg), `the current tab has a 2 px rail (${nav.railBg})`);
    await shot(`${theme}-01-settings-general.png`);
    await measureAll(`${theme} Settings > General`, ".settings-panel");

    const switches = [];
    for (const label of ["General", "Git", "Plugins", "Privacy"]) {
      await settingsTab(label);
      const r = await bridge.eval(`${PAGE};
        const panel = e2e.must(document.querySelector('.settings-content[role="tabpanel"]'), "the tab panel");
        return {
          labelled: panel.getAttribute("aria-labelledby") === document.querySelector('.settings-tabs [aria-selected="true"]').id,
          // The switch is named by its label (aria-labelledby).
          switches: [...panel.querySelectorAll('[role="switch"]')].map((s) => ({
            name: (s.getAttribute("aria-label") || (s.getAttribute("aria-labelledby") || "").split(" ").map((id) => document.getElementById(id)?.innerText ?? "").join(" ")).trim(),
            checked: s.getAttribute("aria-checked"),
            h: +s.offsetHeight,
          })),
          legacy: window.__uirs.legacy(panel),
        };
      `);
      log(`  ${label}: switches ${JSON.stringify(r.switches.map((s) => s.name + "=" + s.checked))}`);
      check(r.labelled, `${label}: the panel is labelled by its tab`);
      check(r.legacy.length === 0, `${label}: no native checkbox or unstyled select${r.legacy.length ? ` (${r.legacy.join("; ")})` : ""}`);
      check(r.switches.length > 0 && r.switches.every((s) => s.name && Math.abs(s.h - 18) <= 0.5), `${label}: every on/off is a named 18 px switch (${r.switches.length})`);
      switches.push(...r.switches);
      if (label === "Git") await shot(`${theme}-02-settings-git-switches.png`);
    }
    check(switches.length >= 7, `Settings has at least 7 switches across General, Git, Plugins and Privacy (${switches.length})`);

    // Appearance: the window-size stepper. Each box is named for what it
    // holds, and the press-and-hold buttons select no text on the way.
    await settingsTab("Appearance");
    const stepper = await bridge.eval(`
      const inputs = e2e.all(".settings-stepper input");
      const btns = e2e.all(".settings-stepper button");
      return {
        names: inputs.map((i) => i.getAttribute("aria-label")),
        btnNames: btns.map((b) => b.getAttribute("aria-label")),
        kit: btns.every((b) => b.classList.contains("h-icon-btn")),
        hold: btns.map((b) => { const cs = getComputedStyle(b); return cs.touchAction + "/" + (cs.userSelect || cs.webkitUserSelect); }),
      };
    `);
    log(`  stepper: ${JSON.stringify(stepper)}`);
    check(JSON.stringify(stepper.names) === JSON.stringify(["Window width", "Window height"]), `the window-size boxes are named apart (${stepper.names.join(", ")})`);
    check(stepper.btnNames.length === 4 && stepper.kit && new Set(stepper.btnNames).size === 4, `the stepper's four buttons are named control-set icon buttons (${stepper.btnNames.join(", ")})`);
    check(stepper.hold.every((h) => h === "none/none"), `the press-and-hold buttons select no text and do not pan (${[...new Set(stepper.hold)].join(", ")})`);

    await settingsTab("General");
    const footer = await bridge.eval(`${PAGE};
      const out = [];
      for (const cls of ["settings-export", "settings-import"]) {
        const b = e2e.must(document.querySelector("." + cls), cls);
        const bg = backdrop(b);
        const fg = over(rgb(getComputedStyle(b).color), bg);
        out.push({ cls, kit: b.classList.contains("h-btn") && b.classList.contains("h-btn--secondary"), h: +b.offsetHeight, ratio: +ratio(fg, bg).toFixed(2), fg: hex(fg), bg: hex(bg) });
      }
      return out;
    `);
    for (const b of footer) {
      check(b.kit && Math.abs(b.h - 32) <= 0.5 && b.ratio >= 4.5, `${b.cls}: a 32 px secondary button whose text is ${b.ratio}:1 (${b.fg} on ${b.bg})`);
    }
    await ringOf(`${theme} Settings`, `
      return [
        document.querySelector('.settings-tabs [aria-selected="true"]'),
        document.querySelector('.settings-content [role="switch"]'),
        document.querySelector(".settings-content select"),
        document.querySelector(".settings-content input.h-input"),
        document.querySelector(".settings-export"),
        document.querySelector(".settings-close"),
      ];
    `);

    if (dark) {
      log("  keyboard: ↓ on the current tab selects the next one");
      await keyOn('.settings-tabs [aria-selected="true"]', "ArrowDown");
      const moved = await bridge.waitFor("the next tab", `
        const sel = e2e.first('.settings-tabs [aria-selected="true"]');
        return sel && e2e.norm(sel.innerText) === "Appearance" ? { focused: document.activeElement === sel } : null;
      `, { timeoutMs: 3_000 }).catch(() => null);
      check(!!moved && moved.focused, "↓ on General selects and focuses Appearance");

      log("  a real click on a switch saves the setting at once");
      await settingsTab("General");
      const sw = '[data-setting="status_strip"] [role="switch"]';
      const was = await bridge.eval(`return e2e.must(e2e.first('${sw}'), "status strip switch").getAttribute("aria-checked");`);
      await bridge.click(sw);
      const flipped = await bridge.waitFor("the setting to be saved", `
        const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
        const now = e2e.first('${sw}').getAttribute("aria-checked");
        return now !== ${JSON.stringify(was)} && (raw.status_strip || "on") === (now === "true" ? "on" : "off") ? { now, saved: raw.status_strip } : null;
      `).catch(() => null);
      check(!!flipped, `the status strip switch flips (${was} → ${flipped?.now}) and saves "${flipped?.saved}"`);
      await bridge.click(sw);
      await bridge.waitFor("the switch to go back", `return e2e.first('${sw}').getAttribute("aria-checked") === ${JSON.stringify(was)};`);
    }
    await closeSettings();

    // ── Folders (command palette) ───────────────────────────────────
    // It shared Settings' old close-button rule; it has the set's own now.
    log(`${theme}: the Folders panel`);
    await menuAction(bridge, "view.command-palette");
    await bridge.waitFor("the command palette", `return !!e2e.first(".command-palette .command-palette-input");`);
    await bridge.clickWhenReady(`
      const item = e2e.all(".command-palette-label").find((el) => e2e.norm(el.innerText) === "Folders");
      return e2e.click(e2e.must(item, "the Folders command"));
    `);
    await bridge.waitFor("the Folders panel", `return !!e2e.first(".workspace-panel .workspace-header");`, { timeoutMs: 10_000 });
    const folders = await bridge.eval(`
      const b = e2e.first(".workspace-header button");
      return b ? { kit: b.classList.contains("h-close-btn"), h: +b.offsetHeight, name: b.getAttribute("aria-label") } : null;
    `);
    check(!!folders && folders.kit && Math.abs(folders.h - 28) <= 0.5 && folders.name === "Close", `the Folders panel closes with the control-set close button (${JSON.stringify(folders)})`);
    await shot(`${theme}-02b-folders-panel.png`);
    await ringOf(`${theme} Folders panel`, `return [e2e.first(".workspace-header button")];`);
    await bridge.click(".workspace-header button");
    await bridge.waitFor("the Folders panel to close", `return !e2e.first(".workspace-panel");`);

    // ── Review Desk ─────────────────────────────────────────────────
    log(`${theme}: Review Desk`);
    await focusSession(SHELL_LABEL);
    await menuAction(bridge, "view.git-panel");
    await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk") && e2e.first(".review-desk").getAttribute("data-loading") === "0";`, { timeoutMs: 15_000 });
    await bridge.waitFor("the two changed files", `return e2e.all(".review-file-row").length === 2;`, { timeoutMs: 15_000 });
    await bridge.waitFor("the Changes section", `return !!e2e.first(".review-changes .git-btn-commit");`, { timeoutMs: 15_000 });
    const desk = await bridge.eval(`
      const tabs = e2e.all('.review-desk [role="tablist"] [role="tab"]');
      const sel = tabs.find((t) => t.getAttribute("aria-selected") === "true");
      const rail = sel && getComputedStyle(sel, "::after");
      const seg = e2e.first('.review-desk [role="radiogroup"].h-segmented');
      return {
        tabs: tabs.map((t) => e2e.norm(t.innerText)),
        kitTabs: tabs.every((t) => t.classList.contains("h-tab")),
        rail: rail ? { h: rail.height, bg: rail.backgroundColor } : null,
        segmented: seg ? [...seg.querySelectorAll('[role="radio"]')].map((r) => e2e.norm(r.innerText) + "=" + r.getAttribute("aria-checked")) : null,
        boxes: e2e.all(".review-file-row").map((r) => !!r.querySelector("input.h-checkbox")),
        changes: ["git-btn-commit", "git-btn-pull", "git-btn-push"].map((c) => e2e.first(".review-changes ." + c)?.classList.contains("h-btn") ?? false),
        commitBox: !!e2e.first(".review-changes textarea.h-textarea"),
        // Every button in the section: the per-file row actions (Open, Stage,
        // Discard), the group's "+ all" and Commit / Pull / Push.
        rowActions: e2e.all(".review-changes .git-file-row").map((r) => e2e.all(".git-file-actions button", r).map((b) => e2e.norm(b.innerText) + (b.classList.contains("h-btn") ? "" : "!legacy"))),
        legacyButtons: e2e.all(".review-changes button").filter((b) => !b.classList.contains("h-btn") && !b.classList.contains("h-icon-btn")).map((b) => b.className + ":" + e2e.norm(b.innerText)),
        close: !!e2e.first(".review-desk .review-close.h-close-btn"),
      };
    `);
    log(`  desk: ${JSON.stringify(desk)}`);
    check(desk.kitTabs && desk.tabs.includes("Review") && desk.tabs.includes("Repository"), `the desk's views are control-set tabs (${desk.tabs.join(", ")})`);
    check(!!desk.rail && desk.rail.h === "2px" && !/rgba\(0, 0, 0, 0\)|transparent/.test(desk.rail.bg), `the selected tab has the 2 px brass rail (${desk.rail?.bg})`);
    check(JSON.stringify(desk.segmented) === JSON.stringify(["By file=true", "By turn=false"]), `By file / By turn is a segmented control (${desk.segmented})`);
    check(desk.boxes.length === 2 && desk.boxes.every(Boolean), "each file's viewed box is the control-set checkbox");
    check(desk.changes.every(Boolean) && desk.commitBox, "the Changes section's Commit, Pull, Push and message box are the control set");
    check(desk.rowActions.length === 2 && desk.rowActions.every((a) => JSON.stringify(a) === JSON.stringify(["Open", "Discard", "Stage"])), `each changed file's Open, Discard and Stage are control-set buttons (${JSON.stringify(desk.rowActions)})`);
    check(desk.legacyButtons.length === 0, `no button in the Changes section is outside the control set${desk.legacyButtons.length ? ` (${desk.legacyButtons.join("; ")})` : ""}`);
    // Discard asks first: Confirm is the danger button, Cancel a quiet one.
    const firstRow = ".review-changes .git-file-row";
    await bridge.click(`${firstRow} .git-file-action-discard`);
    const confirm = await bridge.waitFor("the discard confirm", `
      const row = e2e.first(${JSON.stringify(firstRow)});
      const c = row && e2e.first(".git-file-action-discard-confirm", row);
      const x = row && e2e.first(".git-file-action-cancel", row);
      return c && x ? { confirm: c.className, cancel: x.className, text: e2e.norm(c.innerText) } : null;
    `, { timeoutMs: 5_000 }).catch(() => null);
    check(!!confirm && confirm.confirm.includes("h-btn--danger") && confirm.cancel.includes("h-btn--quiet") && confirm.text === "Confirm", `Discard asks with a danger Confirm and a quiet Cancel (${JSON.stringify(confirm)})`);
    if (confirm) {
      // The row's actions show on hover; the test pointer is not on it, so
      // show them for the picture only.
      await bridge.eval(`e2e.first(".git-file-actions", e2e.first(${JSON.stringify(firstRow)})).style.opacity = "1"; return true;`);
      await shot(`${theme}-03b-review-discard-confirm.png`);
      await bridge.eval(`e2e.first(".git-file-actions", e2e.first(${JSON.stringify(firstRow)})).style.opacity = ""; return true;`);
      await measureAll(`${theme} Changes discard confirm`, ".review-changes");
      await ringOf(`${theme} Changes discard confirm`, `return [e2e.first(".review-changes .git-file-action-discard-confirm"), e2e.first(".review-changes .git-file-action-cancel")];`);
      await bridge.click(`${firstRow} .git-file-action-cancel`);
      await bridge.waitFor("the confirm to go", `return !e2e.first(".review-changes .git-file-action-discard-confirm");`);
    }
    check(await bridge.eval(`return e2e.all(".review-file-row").length === 2;`), "Cancel discarded nothing: both files are still changed");
    check(desk.close, "the desk closes with the control-set close button");
    await shot(`${theme}-03-review-desk.png`);
    await measureAll(`${theme} Review Desk`, ".review-desk");
    await ringOf(`${theme} Review Desk`, `
      return [
        document.querySelector('.review-desk [role="tab"][aria-selected="true"]'),
        document.querySelector('.review-desk [role="radio"][aria-checked="true"]'),
        document.querySelector(".review-file-row input.h-checkbox"),
        document.querySelector(".review-changes .git-btn-commit"),
        document.querySelector(".review-desk .review-close"),
      ];
    `);
    log("  keyboard: → on By file picks By turn");
    await keyOn('.review-desk [role="radio"][aria-checked="true"]', "ArrowRight");
    const turned = await bridge.waitFor("the by-turn list", `
      return e2e.first(".review-desk")?.getAttribute("data-group") === "turn" && e2e.all(".review-turn-row").length === 1 ? true : null;
    `, { timeoutMs: 5_000 }).catch(() => null);
    check(!!turned, "→ switched the desk to By turn and lists T1");
    await shot(`${theme}-04-review-by-turn.png`);
    await keyOn('.review-desk [role="radio"][aria-checked="true"]', "ArrowLeft");
    await bridge.waitFor("by file again", `return e2e.first(".review-desk")?.getAttribute("data-group") === "file";`);
    if (dark) {
      log("  keyboard: → on the Review tab opens Repository");
      await keyOn('.review-desk [role="tab"][aria-selected="true"]', "ArrowRight");
      const repoTab = await bridge.waitFor("the Repository tab", `return e2e.first(".review-desk")?.getAttribute("data-tab") === "repository" ? true : null;`, { timeoutMs: 5_000 }).catch(() => null);
      check(!!repoTab, "→ on the tabs opened the Repository view");
      await keyOn('.review-desk [role="tab"][aria-selected="true"]', "Home");
      await bridge.waitFor("the Review tab", `return e2e.first(".review-desk")?.getAttribute("data-tab") === "review";`);
    }

    // ── Land sheet ──────────────────────────────────────────────────
    log(`${theme}: Land sheet`);
    const landBtn = await bridge.waitFor("the Land button", `return e2e.first(".review-desk .review-land-btn") ? true : null;`, { timeoutMs: 10_000 }).catch(() => null);
    check(!!landBtn, "the desk offers Land for the session's own worktree");
    if (landBtn) {
      check(await bridge.eval(`return e2e.first(".review-land-btn").classList.contains("h-btn--primary");`), "Land is the desk's primary button");
      await bridge.click(".review-desk .review-land-btn");
      await bridge.waitFor("the Land sheet", `return !!e2e.first(".land-sheet") && !!e2e.first('.land-sheet-option[data-mode="commit"]');`, { timeoutMs: 20_000 });
      await sleep(400);
      const land = await bridge.eval(`
        const s = e2e.first(".land-sheet");
        return {
          radios: e2e.all(".land-sheet-option input", s).map((i) => i.classList.contains("h-radio")),
          box: !!e2e.first(".land-sheet-archive-after input.h-checkbox", s),
          message: !!e2e.first("textarea.land-sheet-message.h-textarea", s),
          primaries: e2e.all(".land-sheet-footer .h-btn--primary", s).map((b) => e2e.norm(b.innerText)),
          footer: e2e.all(".land-sheet-footer button", s).every((b) => b.classList.contains("h-btn")),
          close: !!e2e.first(".land-sheet-x.h-close-btn", s),
        };
      `);
      log(`  land: ${JSON.stringify(land)}`);
      check(land.radios.length === 3 && land.radios.every(Boolean), "the three ways to land are control-set radios");
      check(land.box && land.message && land.close, "the archive box, the message and the close button are the control set");
      check(land.footer && land.primaries.length === 1, `the footer has control-set buttons and one primary (${land.primaries.join(", ")})`);
      await shot(`${theme}-05-land-sheet.png`);
      await measureAll(`${theme} Land sheet`, ".land-sheet");
      await ringOf(`${theme} Land sheet`, `
        return [e2e.first(".land-sheet-option input:not(:disabled)"), e2e.first(".land-sheet-archive-after input"), e2e.first(".land-sheet-cancel"), e2e.first(".land-sheet-x")];
      `);
      await bridge.click(".land-sheet-cancel");
      await bridge.waitFor("the Land sheet to close", `return !e2e.first(".land-sheet");`);
    } else if (await bridge.exists(".review-desk")) {
      await bridge.click(".review-desk .review-close");
    }
    await bridge.waitFor("the desk to be closed", `return !e2e.first(".review-desk");`);

    // ── Turn sheet ──────────────────────────────────────────────────
    log(`${theme}: turn sheet`);
    await focusSession(SHELL_LABEL);
    await bridge.click(chip);
    await bridge.waitFor("the diff sheet", `return !!e2e.first('.turn-sheet[data-sheet="diff"] .turn-diff-text, .turn-sheet[data-sheet="diff"] .turn-diff-empty');`);
    const diffSheet = await bridge.eval(`
      const s = e2e.first(".turn-sheet");
      return { buttons: e2e.all(".turn-sheet-actions button", s).map((b) => b.className), close: !!e2e.first(".turn-sheet-close.h-close-btn", s), primaries: e2e.all(".turn-sheet-actions .h-btn--primary", s).length };
    `);
    check(diffSheet.buttons.length === 2 && diffSheet.buttons.every((c) => c.includes("h-btn")) && diffSheet.primaries === 1 && diffSheet.close, "the turn sheet has control-set Close, one primary Restore and the close button");
    await shot(`${theme}-06-turn-sheet.png`);
    await measureAll(`${theme} turn sheet`, ".turn-sheet");
    await bridge.clickByName("Restore to T1", { within: ".turn-sheet-actions" });
    await bridge.waitFor("the restore sheet", `return !!e2e.first('.turn-sheet[data-sheet="restore"] .turn-sheet-hint');`, { timeoutMs: 15_000 });
    const restore = await bridge.eval(`return { confirm: e2e.first(".turn-sheet-confirm")?.className ?? "" };`);
    check(restore.confirm.includes("h-btn--danger-solid"), "the restore confirm is the solid danger button");
    await shot(`${theme}-07-restore-sheet.png`);
    await measureAll(`${theme} restore sheet`, ".turn-sheet");
    await bridge.clickByName("Cancel", { within: ".turn-sheet-actions" });
    await bridge.waitFor("the sheet to close", `return !e2e.first(".turn-sheet");`);

    // ── Composer pickers ────────────────────────────────────────────
    log(`${theme}: the composer's pickers`);
    await bridge.clickWhenReady(`
      const item = e2e.all(".session-item").find((el) => !el.innerText.includes(${JSON.stringify(SHELL_LABEL)}));
      return e2e.click(e2e.must(item, "the Agent view session"));
    `);
    await bridge.waitFor("the model chip", `return !!e2e.first(".composer-chip-model");`, { timeoutMs: 10_000 });
    await ringOf(`${theme} composer chips`, `return [e2e.first(".composer-chip-model"), e2e.first(".composer-chip-effort"), e2e.first(".composer-chip-perms")];`);

    // Model: ↓ opens on the first row, End / Home jump, type-ahead, Esc.
    await keyOn(".composer-chip-model", "ArrowDown");
    const opened = await waitMenu("the model menu to open with ↓", `(s) => s.open && s.active === "Default"`);
    check(!!opened, `↓ on the model chip opens the model menu on its first row (${JSON.stringify(opened)})`);
    if (opened) {
      const st = await menuState();
      check(st.label === "Select model" && st.focusInMenu, "the open menu is named and holds the focus");
      check(await footerSays("Claude restarts with the new --model"), "the model menu says that a switch restarts Claude");
      await keyMenu("End");
      check(!!(await waitMenu("End", `(s) => s.active === "Open Claude's picker…"`)), "End jumps to the last row");
      await keyMenu("Home");
      check(!!(await waitMenu("Home", `(s) => s.active === "Default"`)), "Home jumps to the first row");
      await keyMenu("ArrowDown");
      check(!!(await waitMenu("↓", `(s) => s.active === "Sonnet"`)), "↓ moves to the next row");
      await sleep(600);
      await keyMenu("o");
      check(!!(await waitMenu("type-ahead", `(s) => s.active === "Opus"`)), "typing o jumps to Opus");
      await shot(`${theme}-08-model-menu.png`);
      await measureAll(`${theme} model menu`, '[role="menu"]:not([hidden])', { sized: false });
      const rows = await bridge.eval(`return e2e.all('[role="menu"]:not([hidden]) [role^="menuitem"]').map((r) => +r.offsetHeight);`);
      check(rows.length >= 6 && rows.every((h) => h >= 28), `menu rows are at least 28 px (${[...new Set(rows)].join(", ")})`);
      await keyMenu("Escape");
      const closed = await bridge.waitFor("Esc to close the menu", `
        return !document.querySelector('[role="menu"]:not([hidden])') ? { chipFocused: document.activeElement === e2e.first(".composer-chip-model"), expanded: e2e.first(".composer-chip-model").getAttribute("aria-expanded") } : null;
      `, { timeoutMs: 3_000 }).catch(() => null);
      check(!!closed && closed.chipFocused && closed.expanded === "false", "Esc closes the menu and gives focus back to the chip");
    }
    if (dark) {
      await keyOn(".composer-chip-model", "Enter");
      const reopened = await waitMenu("Enter to open the model menu", `(s) => s.open`);
      if (reopened) {
        await sleep(600);
        await keyMenu("h");
        await waitMenu("Haiku", `(s) => s.active === "Haiku"`);
        await keyMenu("Enter");
      }
      const picked = await bridge.waitFor("the chip to show the picked model", `
        return !document.querySelector('[role="menu"]:not([hidden])') && /haiku/i.test(e2e.first(".composer-chip-model .composer-chip-value")?.innerText ?? "") ? e2e.first(".composer-chip-model .composer-chip-value").innerText : null;
      `, { timeoutMs: 5_000 }).catch(() => null);
      check(!!picked, `Enter, type-ahead h and Enter picked Haiku (the chip shows "${picked}")`);
    }

    // Effort: ↓ opens; type-ahead; Enter picks.
    await keyOn(".composer-chip-effort", "ArrowDown");
    const effortOpen = await waitMenu("the effort menu", `(s) => s.open`);
    check(!!effortOpen, "↓ on the effort chip opens the effort menu");
    if (effortOpen) {
      check(await footerSays("Claude restarts with the new --effort"), "the effort menu says that a change restarts Claude");
      await sleep(600);
      await keyMenu("x");
      check(!!(await waitMenu("xhigh", `(s) => s.active === "xhigh"`)), "typing x jumps to xhigh");
      await shot(`${theme}-09-effort-menu.png`);
      await measureAll(`${theme} effort menu`, '[role="menu"]:not([hidden])', { sized: false });
      if (dark) {
        await keyMenu("Enter");
        const eff = await bridge.waitFor("the effort chip to show xhigh", `return /xhigh/.test(e2e.first(".composer-chip-effort .composer-chip-value")?.innerText ?? "") ? true : null;`, { timeoutMs: 5_000 }).catch(() => null);
        check(!!eff, "Enter picked xhigh and the chip shows it");
      } else {
        await keyMenu("Escape");
      }
    }

    // Permission: ↑ opens on the last row (Bypass, destructive); Home; type-ahead; Esc.
    await keyOn(".composer-chip-perms", "ArrowUp");
    const permOpen = await waitMenu("the permission menu", `(s) => s.open && s.active === "Bypass"`);
    check(!!permOpen, "↑ on the permission chip opens the menu on its last row (Bypass)");
    if (permOpen) {
      const danger = await bridge.eval(`return e2e.all('[role="menu"]:not([hidden]) .h-menu-item--danger').map((r) => e2e.norm(r.querySelector(".h-option-label").innerText));`);
      check(JSON.stringify(danger) === JSON.stringify(["Bypass"]), `Bypass is the one destructive row (${danger})`);
      check(await footerSays("Claude restarts with the new --permission-mode"), "the permission menu says that a change restarts Claude");
      await keyMenu("Home");
      await sleep(600);
      await keyMenu("p");
      check(!!(await waitMenu("Plan", `(s) => s.active === "Plan"`)), "Home then typing p reaches Plan");
      await shot(`${theme}-10-permission-menu.png`);
      await measureAll(`${theme} permission menu`, '[role="menu"]:not([hidden])', { sized: false });
      await keyMenu("Escape");
      await bridge.waitFor("the permission menu to close", `return !document.querySelector('[role="menu"]:not([hidden])');`);
      check((await bridge.eval(`return e2e.norm(e2e.first(".composer-chip-perms .composer-chip-value")?.innerText ?? "");`)) === "Default", "Esc left the permission mode as it was");
    }
  }

  assert(problems.length === 0, `every check passed (${problems.length} failed${problems.length ? `: ${problems.join(" | ")}` : ""})`);
});
