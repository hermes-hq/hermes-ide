#!/usr/bin/env node
// Contrast audit for the theme tokens.
//
// Reads src/styles/tokens.css and src/styles/themes.css, resolves every
// theme's colour tokens (var() chains, rgba(), color-mix() in srgb) and
// computes the WCAG contrast of the pairs the control set relies on:
//
//   text      >= 4.5:1  labels, values, placeholders, links, badge text,
//                       on every fill they are drawn on (hover and selected
//                       fills included)
//   non-text  >= 3:1    field edges and the focus ring against what is next
//                       to them, a checked box / toggle track / brass rail
//                       against the surface, the toggle knob on its track
//
// Disabled controls (opacity .45) are exempt, as WCAG allows.
//
//   node scripts/contrast-audit.mjs            # table of failures, exit 1 on any
//   node scripts/contrast-audit.mjs --all      # every pair with its ratio
//
// scripts/contrast-audit.test.mjs runs the same audit in `npx vitest run`.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DARK_THEMES = ["frosted-dark", "atelier", "observatory", "phosphor"];
export const LIGHT_THEMES = ["frosted-light", "linen", "newsprint", "atrium"];
export const THEMES = [...DARK_THEMES, ...LIGHT_THEMES];

export const TEXT_MIN = 4.5;
export const UI_MIN = 3;

// ─── CSS parsing ──────────────────────────────────────────────────────

/** Top-level rules of a stylesheet as { selectors, body }; at-rules are skipped. */
export function topLevelRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open === -1) break;
    const prelude = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (!prelude.startsWith("@")) {
      rules.push({ selectors: prelude.split(",").map((s) => s.trim()), body });
    }
    i = j;
  }
  return rules;
}

/** Custom-property declarations of a rule body, in order. */
export function customProperties(body) {
  const out = [];
  // Split on semicolons that are not inside parentheses.
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  for (const part of parts) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(part);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

const THEME_SELECTOR = /^html\[data-theme="([\w-]+)"\]$/;

/**
 * Every theme's custom properties, in cascade order: tokens.css :root, then
 * themes.css :root, then the theme's own top-level blocks. Descendant
 * selectors (`html[data-theme=x] .topbar`) do not set page tokens and are
 * ignored.
 */
export function themeTokens(cssFiles, themes = THEMES) {
  const base = {};
  const perTheme = Object.fromEntries(themes.map((t) => [t, {}]));
  for (const css of cssFiles) {
    for (const { selectors, body } of topLevelRules(css)) {
      const props = customProperties(body);
      if (props.length === 0) continue;
      for (const sel of selectors) {
        if (sel === ":root") {
          for (const [k, v] of props) base[k] = v;
          continue;
        }
        const m = THEME_SELECTOR.exec(sel);
        if (m && perTheme[m[1]]) for (const [k, v] of props) perTheme[m[1]][k] = v;
      }
    }
  }
  return Object.fromEntries(themes.map((t) => [t, { ...base, ...perTheme[t] }]));
}

export function loadThemeTokens(root = ROOT) {
  const files = ["src/styles/tokens.css", "src/styles/themes.css"].map((f) => readFileSync(join(root, f), "utf8"));
  return themeTokens(files);
}

// ─── Colour evaluation ────────────────────────────────────────────────

/** { r, g, b, a } with r/g/b in 0..255 and a in 0..1. */
function rgba(r, g, b, a = 1) {
  return { r, g, b, a };
}

function parseHex(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) throw new Error(`bad hex colour ${hex}`);
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return rgba(n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1);
}

/** Split a function's arguments on top-level commas. */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

/** Replace var(--x[, fallback]) with its value, recursively. */
export function substitute(value, vars, seen = new Set()) {
  let out = value;
  for (let guard = 0; guard < 50; guard++) {
    const at = out.lastIndexOf("var(");
    if (at === -1) return out.trim();
    let depth = 0;
    let end = at + 3;
    for (; end < out.length; end++) {
      if (out[end] === "(") depth++;
      else if (out[end] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const [name, ...rest] = splitArgs(out.slice(at + 4, end));
    let replacement;
    if (vars[name] !== undefined) {
      if (seen.has(name)) throw new Error(`cyclic var ${name}`);
      replacement = substitute(vars[name], vars, new Set([...seen, name]));
    } else if (rest.length > 0) {
      replacement = rest.join(",");
    } else {
      throw new Error(`undefined token ${name}`);
    }
    out = out.slice(0, at) + replacement + out.slice(end + 1);
  }
  throw new Error(`could not resolve ${value}`);
}

/** Evaluate a resolved CSS colour. Supports hex, rgb[a](), transparent and color-mix(in srgb, …). */
export function parseColour(raw) {
  const v = raw.trim();
  if (v === "transparent") return rgba(0, 0, 0, 0);
  if (v === "white") return rgba(255, 255, 255);
  if (v === "black") return rgba(0, 0, 0);
  if (v.startsWith("#")) return parseHex(v);
  let m = /^rgba?\((.*)\)$/i.exec(v);
  if (m) {
    const parts = m[1].includes(",") ? splitArgs(m[1]) : m[1].replace("/", " ").split(/\s+/).filter(Boolean);
    const [r, g, b] = parts.slice(0, 3).map(Number);
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : Number(parts[3]);
    return rgba(r, g, b, a);
  }
  m = /^color-mix\(\s*in srgb\s*,(.*)\)$/i.exec(v);
  if (m) {
    const [a, b] = splitArgs(m[1]).map((part) => {
      const pm = /^(.*?)\s+([\d.]+)%$/.exec(part);
      return pm ? { colour: parseColour(pm[1]), pct: Number(pm[2]) / 100 } : { colour: parseColour(part), pct: null };
    });
    let pa = a.pct;
    let pb = b.pct;
    if (pa === null && pb === null) pa = pb = 0.5;
    else if (pa === null) pa = 1 - pb;
    else if (pb === null) pb = 1 - pa;
    const sum = pa + pb;
    pa /= sum;
    pb /= sum;
    // CSS Color 5: premultiplied interpolation in sRGB.
    const alpha = a.colour.a * pa + b.colour.a * pb;
    const ch = (k) => (alpha === 0 ? 0 : (a.colour[k] * a.colour.a * pa + b.colour[k] * b.colour.a * pb) / alpha);
    return rgba(ch("r"), ch("g"), ch("b"), alpha);
  }
  throw new Error(`unsupported colour "${v}"`);
}

export function tokenColour(tokens, name) {
  return parseColour(substitute(`var(${name})`, tokens));
}

/** Paint `top` over an opaque `bottom`. */
function over(top, bottom) {
  const a = top.a;
  return rgba(top.r * a + bottom.r * (1 - a), top.g * a + bottom.g * (1 - a), top.b * a + bottom.b * (1 - a), 1);
}

/** A stack of layers, bottom first; the bottom one must end up opaque. */
export function flatten(layers) {
  let acc = layers[0];
  if (acc.a < 1) acc = over(acc, rgba(0, 0, 0, 1)); // never happens for real surfaces
  for (const layer of layers.slice(1)) acc = over(layer, acc);
  return acc;
}

function luminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function hex({ r, g, b }) {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

// ─── The pairs ────────────────────────────────────────────────────────

// Where controls sit: the app backdrop, panels and dialogs, and popovers
// (listbox, menu). --bg-2 is a hover fill; --bg-elevated is checked for
// text only (two popovers still use it).
const SURFACES = ["--bg-0", "--bg-1", "--popover-bg"];

/**
 * The contrast pairs of the control set. `bg` is a stack of tokens, bottom
 * first (a hover tint over the surface it sits on). Kept as data so the
 * unit test and the CLI check the same list.
 */
export function contrastPairs() {
  const pairs = [];
  const text = (fg, bg, why) => pairs.push({ fg, bg: [].concat(bg), min: TEXT_MIN, kind: "text", why });
  const ui = (fg, bg, why) => pairs.push({ fg, bg: [].concat(bg), min: UI_MIN, kind: "non-text", why });

  // Ink ladder: every text token on every surface it is drawn on.
  for (const ink of ["--text-0", "--text-1", "--text-2", "--text-3"]) {
    for (const s of [...SURFACES, "--bg-2", "--bg-elevated"]) text(ink, s, "body and secondary text");
  }
  // Buttons.
  for (const s of ["--primary-bg", "--primary-bg-hover", "--primary-bg-active"]) text("--primary-fg", s, "primary button label");
  for (const s of ["--control-bg", "--control-bg-hover", "--control-bg-active"]) text("--control-fg", s, "secondary button label");
  for (const s of SURFACES) {
    // A highlighted option lifts its detail from --text-2 to --text-1.
    text("--text-1", [s, "--quiet-hover-bg"], "quiet button, highlighted option or menu item");
    text("--text-0", [s, "--quiet-active-bg"], "quiet button pressed");
    text("--text-2", s, "option detail, menu shortcut");
    text("--danger-fg", s, "danger button / destructive menu item");
    text("--link-fg", s, "link button");
  }
  // A highlighted destructive menu item turns its row red and its label --text-0.
  text("--text-0", ["--popover-bg", "--danger-dim"], "destructive menu item highlighted");
  // Danger buttons and danger badges sit on panels, not in popovers.
  for (const s of ["--bg-0", "--bg-1"]) text("--danger-fg", [s, "--danger-dim"], "danger button on hover, danger badge");
  text("--danger-fg", "--control-bg", "danger button label");
  text("--danger-solid-fg", "--danger-solid-bg", "confirm-dialog danger button");
  text("--danger-solid-fg", "--danger-solid-bg-hover", "confirm-dialog danger button on hover");
  text("--accent-fg", "--accent", "text on an accent fill");
  // Fields.
  text("--text-0", "--field-bg", "field value");
  text("--text-3", "--field-bg", "placeholder");
  text("--text-2", "--field-bg", "unselected segment");
  for (const s of [...SURFACES, "--field-bg"]) ui("--field-border", s, "field, checkbox and radio edge");
  // Selection.
  text("--text-0", "--selected-bg", "selected segment");
  text("--text-1", "--row-active-bg", "current row");
  text("--text-2", "--row-active-bg", "current row metadata");
  // The current row of a list (sidebar session, inbox, palette): its brass
  // rail, and its Close drawn in --text-2 (ListRow, src/styles/ui/row.css).
  ui("--primary-bg", "--row-active-bg", "selection rail on the current row");
  ui("--text-2", "--row-active-bg", "close button on the current row");
  for (const s of SURFACES) text("--chip-selected-fg", [s, "--chip-selected-bg"], "selected chip");
  // Badges.
  for (const s of ["--bg-1", "--popover-bg"]) {
    text("--success-ink", [s, "--success-dim"], "success badge");
    text("--warning-ink", [s, "--warning-dim"], "warning badge");
    text("--info-ink", [s, "--info-dim"], "info badge");
    text("--success-ink", s, "success text");
    text("--warning-ink", s, "warning text");
    text("--info-ink", s, "info text");
  }
  // Focus ring and brass marks (checked box, toggle on, tab rail, radio dot).
  for (const s of [...SURFACES, "--bg-2"]) {
    ui("--focus-ring", s, "focus ring");
    ui("--primary-bg", s, "checked box, toggle on, selection rail");
  }
  // Toggle off: the track against the surface, the knob on the track.
  for (const s of SURFACES) ui("--toggle-off-bg", s, "toggle track (off)");
  ui("--toggle-knob-bg", "--toggle-off-bg", "toggle knob (off)");
  ui("--primary-fg", "--primary-bg", "toggle knob (on), check mark");
  return pairs;
}

/** Every pair for every theme, with its ratio and whether it passes. */
export function auditThemes(tokensByTheme, pairs = contrastPairs()) {
  const results = [];
  for (const [theme, tokens] of Object.entries(tokensByTheme)) {
    for (const pair of pairs) {
      let ratio;
      let error;
      try {
        const bg = flatten(pair.bg.map((t) => tokenColour(tokens, t)));
        const fg = over(tokenColour(tokens, pair.fg), bg);
        ratio = contrast(fg, bg);
      } catch (e) {
        error = e.message;
      }
      results.push({
        theme,
        ...pair,
        ratio,
        error,
        pass: error === undefined && ratio >= pair.min,
      });
    }
  }
  return results;
}

function describe(r) {
  const ratio = r.error ? `ERROR ${r.error}` : `${r.ratio.toFixed(2)}:1`;
  return `${r.theme.padEnd(14)} ${r.fg} on ${r.bg.join(" + ")}  ${ratio} (min ${r.min}, ${r.why})`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = auditThemes(loadThemeTokens());
  const failures = results.filter((r) => !r.pass);
  if (process.argv.includes("--all")) for (const r of results) console.log(`${r.pass ? "ok  " : "FAIL"} ${describe(r)}`);
  for (const r of failures) console.error(`FAIL ${describe(r)}`);
  console.log(`${results.length - failures.length}/${results.length} contrast pairs pass across ${THEMES.length} themes`);
  process.exit(failures.length ? 1 : 0);
}
