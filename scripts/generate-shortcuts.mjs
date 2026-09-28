#!/usr/bin/env node
// Generates the Shortcuts panel data (src/generated/shortcuts.ts) and the
// shortcuts reference (docs/shortcuts.md) from the places keyboard shortcuts
// are actually defined:
//   - the native menu bar (src-tauri/src/menu/mod.rs),
//   - src/utils/keymap.json, when it exists: a per-platform chord table the
//     menu reads through `.accelerator(app_accel("<id>")?)`, and
//   - src/shortcuts/app-shortcuts.json, the declared list of bindings the app
//     handles itself (App.tsx's keydown handler matches keys only through it).
// Nothing here is hand-maintained, so the panel and the docs can never list a
// shortcut that isn't real, or miss one that is — removing an
// `.accelerator(...)` from the menu, or an entry from the JSON, removes it here.
//
//   node scripts/generate-shortcuts.mjs          # write both output files
//   node scripts/generate-shortcuts.mjs --check  # fail if they're stale (CI)
//
// --menu, --keymap, --app, --ts-out and --md-out point it at other files (used
// by the N23-docs-gates scenario to prove a menu change makes the docs stale).
//
// Only items built with `MenuItemBuilder::with_id` / `CheckMenuItemBuilder::with_id`
// AND an `.accelerator(...)` are shortcuts; everything else in the menu
// (predefined items, unbound entries) is not a keyboard shortcut. An
// accelerator the generator cannot read is an error, never a silently dropped
// row.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const MENU_SOURCE = join(REPO_ROOT, "src-tauri", "src", "menu", "mod.rs");
export const APP_SOURCE = join(REPO_ROOT, "src", "shortcuts", "app-shortcuts.json");
export const KEYMAP_SOURCE = join(REPO_ROOT, "src", "utils", "keymap.json");
export const TS_OUT = join(REPO_ROOT, "src", "generated", "shortcuts.ts");
export const MD_OUT = join(REPO_ROOT, "docs", "shortcuts.md");

// ─── Parse src-tauri/src/menu/mod.rs ───────────────────────────────────

/**
 * Menu sections are marked with a two-dash comment header, e.g.
 * `// ── File menu ──`. The file's other section comments (data models,
 * function banners) use a three-dash header and are ignored, so this can't
 * be confused by them.
 */
function groupHeader(line) {
  const m = /^\/\/\s*(─+)\s+(.+?)\s+─+\s*$/.exec(line.trim());
  if (!m || m[1].length !== 2) return null;
  return m[2].replace(/\s*menu\b.*$/i, "").trim();
}

/**
 * Walking backwards from a `let` line, skipping blank lines and bare braces,
 * the nearest cfg attribute (if any) tells us whether the item only exists
 * on macOS or only off it. Anything else in the way means the item is
 * unconditional.
 */
function platformOf(lines, letLineIndex) {
  for (let i = letLineIndex - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === "" || t === "{" || t === "}") continue;
    if (t === '#[cfg(target_os = "macos")]') return "macos";
    if (t === '#[cfg(not(target_os = "macos"))]') return "not-macos";
    return undefined;
  }
  return undefined;
}

// ─── Parse src/utils/keymap.json (optional) ─────────────────────────────

const CHORD_RE = /^(\{(mod|ctrl|shift|alt)\})*[^{}\s]+$/;

/**
 * The per-platform chord table, keyed by menu action id. `mac` and `pc` are
 * canonical key strings ("{mod}N", "{ctrl}{shift}N"); `pcOutsideTerminal` is an
 * extra Windows/Linux chord that only works while no terminal has focus.
 */
export function parseKeymap(doc) {
  const list = doc?.chords;
  if (!Array.isArray(list)) throw new Error('keymap.json: expected a "chords" array');
  const map = new Map();
  list.forEach((raw, i) => {
    const where = `keymap.json: chords[${i}]`;
    if (typeof raw?.action !== "string" || !raw.action) throw new Error(`${where}: "action" must be a non-empty string`);
    for (const field of ["mac", "pc"]) {
      if (typeof raw[field] !== "string" || !CHORD_RE.test(raw[field])) throw new Error(`${where} (${raw.action}): "${field}" must be a chord like "{mod}N"`);
    }
    if (raw.pcOutsideTerminal !== undefined && (typeof raw.pcOutsideTerminal !== "string" || !CHORD_RE.test(raw.pcOutsideTerminal))) {
      throw new Error(`${where} (${raw.action}): "pcOutsideTerminal" must be a chord like "{ctrl}N"`);
    }
    if (map.has(raw.action)) throw new Error(`${where}: duplicate action "${raw.action}"`);
    map.set(raw.action, { mac: raw.mac, pc: raw.pc, pcOutsideTerminal: raw.pcOutsideTerminal });
  });
  return map;
}

/** The text inside `.accelerator( ... )` in a builder chain, or null. */
function acceleratorArgument(body) {
  const start = body.indexOf(".accelerator(");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + ".accelerator".length; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return body.slice(start + ".accelerator(".length, i).trim();
  }
  return body.slice(start + ".accelerator(".length).trim();
}

/**
 * @returns {{ group: string, id: string, label: string, keys: string, pcKeys?: string,
 *   pcOutsideTerminal?: string, platform?: string }[]}
 *   in the order they appear in the source, one entry per menu item that has
 *   both an id/label and an accelerator. `keys` is the macOS chord (and the
 *   Windows/Linux one too unless `pcKeys` is set), as a canonical key string.
 * @param keymap the parsed keymap.json (see parseKeymap), needed when the menu
 *   reads chords through `app_accel("<id>")`.
 */
export function extractShortcuts(crlfOrLfSource, keymap = null) {
  // A Windows checkout can have CRLF endings; offsets below assume "\n".
  const source = crlfOrLfSource.replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineIndexAt = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const headers = [];
  lines.forEach((line, i) => {
    const name = groupHeader(line);
    if (name) headers.push({ pos: lineStarts[i], name });
  });
  const groupAt = (pos) => {
    let name = "(ungrouped)";
    for (const h of headers) {
      if (h.pos <= pos) name = h.name;
      else break;
    }
    return name;
  };

  const items = [];
  const itemRe = /(?:MenuItemBuilder|CheckMenuItemBuilder)::with_id\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)([\s\S]*?)\.build\(/g;
  let m;
  while ((m = itemRe.exec(source))) {
    const [, id, label, body] = m;
    const arg = acceleratorArgument(body);
    if (arg === null) continue;
    const item = { group: groupAt(m.index), id, label, platform: platformOf(lines, lineIndexAt(m.index)), source: "menu" };
    const literal = /^"([^"]+)"$/.exec(arg);
    const fromKeymap = /^app_accel\(\s*"([^"]+)"\s*\)\??$/.exec(arg);
    if (literal) {
      item.keys = toCanonicalKeys(literal[1]);
    } else if (fromKeymap) {
      const chord = keymap?.get(fromKeymap[1]);
      if (!chord) {
        throw new Error(`menu item "${id}" reads its chord from keymap.json as "${fromKeymap[1]}", but keymap.json has no such chord`);
      }
      item.keys = chord.mac;
      if (chord.pc !== chord.mac) item.pcKeys = chord.pc;
      if (chord.pcOutsideTerminal) item.pcOutsideTerminal = chord.pcOutsideTerminal;
    } else {
      throw new Error(`menu item "${id}" has an accelerator the shortcuts generator cannot read: .accelerator(${arg}); use a string literal or app_accel("<id>")?`);
    }
    items.push(item);
  }
  if (keymap) {
    const used = new Set(items.map((i) => i.id));
    for (const action of keymap.keys()) {
      if (!used.has(action)) throw new Error(`keymap.json has a chord for "${action}", but no menu item uses it (app_accel("${action}"))`);
    }
  }
  return items;
}

// ─── Parse src/shortcuts/app-shortcuts.json ─────────────────────────────

/**
 * The app-handled shortcuts, validated. Each keeps all its accelerators (the
 * keydown handler matches any of them); the first is the one displayed.
 */
export function parseAppShortcuts(doc) {
  const list = doc?.shortcuts;
  if (!Array.isArray(list)) throw new Error('app-shortcuts.json: expected a "shortcuts" array');
  const seen = new Set();
  return list.map((raw, i) => {
    const where = `app-shortcuts.json: shortcuts[${i}]`;
    for (const field of ["id", "group", "label"]) {
      if (typeof raw?.[field] !== "string" || raw[field].trim() === "") throw new Error(`${where}: "${field}" must be a non-empty string`);
    }
    if (!Array.isArray(raw.accelerators) || raw.accelerators.length === 0 || raw.accelerators.some((a) => typeof a !== "string" || !a)) {
      throw new Error(`${where} (${raw.id}): "accelerators" must be a non-empty list of strings`);
    }
    const pc = raw.pcAccelerators;
    if (pc !== undefined && (!Array.isArray(pc) || pc.length === 0 || pc.some((a) => typeof a !== "string" || !a))) {
      throw new Error(`${where} (${raw.id}): "pcAccelerators" must be a non-empty list of strings when present`);
    }
    if (seen.has(raw.id)) throw new Error(`${where}: duplicate id "${raw.id}"`);
    seen.add(raw.id);
    return {
      group: raw.group,
      id: raw.id,
      label: raw.label,
      keys: toCanonicalKeys(raw.accelerators[0]),
      alsoKeys: raw.accelerators.slice(1).map(toCanonicalKeys),
      // Windows/Linux keys when they differ (a terminal owns Ctrl+letter there).
      ...(pc ? { pcKeys: toCanonicalKeys(pc[0]), pcAlsoKeys: pc.slice(1).map(toCanonicalKeys) } : {}),
      note: typeof raw.note === "string" && raw.note ? raw.note : undefined,
      source: "app",
    };
  });
}

/**
 * Menu shortcuts first, then the app-handled ones (appended to the menu group
 * of the same name, or to a new group after the menu's). Throws when an id or
 * a key combo is used twice, since one of the two bindings could never fire.
 */
export function combineShortcuts(menuItems, appItems) {
  const all = [...menuItems, ...appItems];
  const ids = new Set();
  for (const item of all) {
    if (ids.has(item.id)) throw new Error(`shortcut id "${item.id}" is defined twice`);
    ids.add(item.id);
  }
  // Checked per platform: ⌘N and Ctrl+N are different keys on macOS but the
  // same key on Windows/Linux, and a macOS-only item never meets a
  // Windows/Linux-only one.
  for (const [mac, name, symbols] of [
    [true, "macOS", MAC_SYMBOLS],
    [false, "Windows / Linux", PC_SYMBOLS],
  ]) {
    const combos = new Map();
    for (const item of all) {
      if (item.platform === (mac ? "not-macos" : "macos")) continue;
      for (const keys of platformKeys(item, mac)) {
        const combo = comboId(keys, mac);
        const other = combos.get(combo);
        if (other) throw new Error(`${renderKeys(keys, symbols)} (${name}) is bound twice: "${other.id}" and "${item.id}"`);
        combos.set(combo, item);
      }
    }
  }
  return all;
}

/** Every canonical key string that triggers the item on one platform family. */
function platformKeys(item, mac) {
  if (mac) return [item.keys, ...(item.alsoKeys ?? [])];
  if (item.pcAlsoKeys) return [item.pcKeys, ...item.pcAlsoKeys];
  return [item.pcKeys ?? item.keys, ...(item.pcOutsideTerminal ? [item.pcOutsideTerminal] : []), ...(item.alsoKeys ?? [])];
}

/** A comparable id for the physical key combo a canonical key string means. */
function comboId(keys, mac) {
  const mods = [];
  const key = keys.replace(/\{(\w+)\}/g, (_m, t) => {
    mods.push(t === "mod" ? (mac ? "cmd" : "ctrl") : t);
    return "";
  });
  return [...new Set(mods)].sort().join("+") + "+" + key.toUpperCase();
}

/** Read every source and return the grouped list the outputs are rendered from. */
export function loadShortcutGroups(
  menuSource = readFileSync(MENU_SOURCE, "utf8"),
  appJson = readFileSync(APP_SOURCE, "utf8"),
  keymapJson = existsSync(KEYMAP_SOURCE) ? readFileSync(KEYMAP_SOURCE, "utf8") : null,
) {
  const keymap = keymapJson === null ? null : parseKeymap(JSON.parse(keymapJson));
  return groupShortcuts(combineShortcuts(extractShortcuts(menuSource, keymap), parseAppShortcuts(JSON.parse(appJson))));
}

// ─── i18n keys ──────────────────────────────────────────────────────────
// Every row and group label is rendered through t(); these are its keys. The
// English text lives in src/i18n/registry.ts (a unit test checks it equals the
// label defined here) and every language pack translates it.

const camel = (s) => s.replace(/[^A-Za-z0-9.]+(.)?/g, (_m, c) => (c ? c.toUpperCase() : ""));

/** "file.new-session" → "shortcuts.item.file.newSession" */
export const labelKeyFor = (id) => `shortcuts.item.${camel(id)}`;
/** "File" → "shortcuts.group.file" */
export const groupKeyFor = (group) => `shortcuts.group.${camel(group.toLowerCase())}`;

/** Groups, in first-seen order, dropping any group with no shortcuts. */
export function groupShortcuts(items) {
  const order = [];
  const byGroup = new Map();
  for (const item of items) {
    if (!byGroup.has(item.group)) {
      byGroup.set(item.group, []);
      order.push(item.group);
    }
    byGroup.get(item.group).push(item);
  }
  return order.map((group) => ({ group, shortcuts: byGroup.get(group) }));
}

// ─── Accelerator → display ──────────────────────────────────────────────
// Mirrors the canonical tokens and symbol tables in src/utils/platform.ts
// (`fmt`), so the panel (which calls that function at runtime) and this
// generator's own markdown output (rendered ahead of time, for both
// platforms at once) always agree on what each token means.

const TOKEN_MAP = { CmdOrCtrl: "{mod}", Cmd: "{mod}", Shift: "{shift}", Alt: "{alt}", Ctrl: "{ctrl}" };
const KEY_MAP = { Left: "←", Right: "→", Up: "↑", Down: "↓" };

/** "CmdOrCtrl+Shift+D" → "{mod}{shift}D", "CmdOrCtrl+Alt+Right" → "{mod}{alt}→" */
export function toCanonicalKeys(accelerator) {
  const tokens = accelerator.split("+");
  const key = tokens.pop();
  return tokens.map((t) => TOKEN_MAP[t] ?? `{${t.toLowerCase()}}`).join("") + (KEY_MAP[key] ?? key);
}

// Must equal MAC_SYMBOLS / PC_SYMBOLS in src/utils/platform.ts (a unit test
// imports both and compares them).
export const MAC_SYMBOLS = { "{mod}": "⌘", "{shift}": "⇧", "{alt}": "⌥", "{ctrl}": "⌃" };
export const PC_SYMBOLS = { "{mod}": "Ctrl+", "{shift}": "Shift+", "{alt}": "Alt+", "{ctrl}": "Ctrl+" };

/** Render a canonical key string (see `toCanonicalKeys`) for one platform. */
export function renderKeys(canonical, symbols) {
  let out = canonical;
  for (const [token, replacement] of Object.entries(symbols)) out = out.split(token).join(replacement);
  return out;
}

export const macKeys = (accelerator) => renderKeys(toCanonicalKeys(accelerator), MAC_SYMBOLS);
export const pcKeys = (accelerator) => renderKeys(toCanonicalKeys(accelerator), PC_SYMBOLS);

/** Normalise line endings, so a checkout with CRLF endings is not "stale". */
export const sameText = (a, b) => a !== null && b !== null && a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

// ─── Render the generated files ─────────────────────────────────────────

const HEADER =
  "// GENERATED FILE — do not edit by hand.\n" +
  "// Run `node scripts/generate-shortcuts.mjs` to regenerate from\n" +
  "// src-tauri/src/menu/mod.rs (with src/utils/keymap.json, if present) and\n" +
  "// src/shortcuts/app-shortcuts.json.\n";

export function renderTsModule(groups) {
  const lines = [HEADER];
  lines.push("export interface GeneratedShortcut {");
  lines.push("  id: string;");
  lines.push("  /** English label, as defined in the menu or app-shortcuts.json. */");
  lines.push("  label: string;");
  lines.push("  /** i18n key the UI renders; its English text equals `label`. */");
  lines.push("  labelKey: string;");
  lines.push("  /** Canonical key string for `fmt()` in ../utils/platform, e.g. \"{mod}N\". */");
  lines.push("  keys: string;");
  lines.push("  /** Windows/Linux key string, set only when it differs from `keys`. */");
  lines.push("  pcKeys?: string;");
  lines.push("  /** Set only when the menu only registers this accelerator on one platform family. */");
  lines.push('  platform?: "macos" | "not-macos";');
  lines.push("}");
  lines.push("");
  lines.push("export interface GeneratedShortcutGroup {");
  lines.push("  group: string;");
  lines.push("  groupKey: string;");
  lines.push("  shortcuts: GeneratedShortcut[];");
  lines.push("}");
  lines.push("");
  lines.push("export const GENERATED_SHORTCUT_GROUPS: GeneratedShortcutGroup[] = [");
  for (const { group, shortcuts } of groups) {
    lines.push(`  {`);
    lines.push(`    group: ${JSON.stringify(group)},`);
    lines.push(`    groupKey: ${JSON.stringify(groupKeyFor(group))},`);
    lines.push(`    shortcuts: [`);
    for (const s of shortcuts) {
      const pc = s.pcKeys ? `, pcKeys: ${JSON.stringify(s.pcKeys)}` : "";
      const platform = s.platform ? `, platform: ${JSON.stringify(s.platform)}` : "";
      lines.push(
        `      { id: ${JSON.stringify(s.id)}, label: ${JSON.stringify(s.label)}, labelKey: ${JSON.stringify(labelKeyFor(s.id))}, keys: ${JSON.stringify(s.keys)}${pc}${platform} },`,
      );
    }
    lines.push(`    ],`);
    lines.push(`  },`);
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

function notesFor(s) {
  const notes = [];
  if (s.platform === "macos") notes.push("macOS only");
  if (s.platform === "not-macos") notes.push("Windows / Linux only");
  if (s.note) notes.push(s.note);
  const alternates = s.alsoKeys ?? [];
  if (alternates.length) notes.push(`also ${alternates.map((k) => `${renderKeys(k, MAC_SYMBOLS)} / ${renderKeys(k, PC_SYMBOLS)}`).join(", ")}`);
  if (s.pcOutsideTerminal) notes.push(`Windows / Linux: also ${renderKeys(s.pcOutsideTerminal, PC_SYMBOLS)} when no terminal has focus`);
  return notes.join("; ");
}

export function renderMarkdown(groups) {
  const lines = [
    "# Keyboard shortcuts",
    "",
    "<!-- GENERATED FILE — do not edit by hand. Run `node scripts/generate-shortcuts.mjs`",
    "     to regenerate from src-tauri/src/menu/mod.rs (with src/utils/keymap.json, if present)",
    "     and src/shortcuts/app-shortcuts.json. -->",
    "",
    "This is every keyboard shortcut Hermes has: the accelerators its menu bar",
    "registers plus the ones the app handles itself, generated directly from",
    "their definitions so it can never drift from what the app actually does.",
    "",
  ];
  for (const { group, shortcuts } of groups) {
    lines.push(`## ${group}`, "");
    lines.push("| Action | macOS | Windows / Linux | Notes |");
    lines.push("|---|---|---|---|");
    for (const s of shortcuts) {
      const mac = s.platform === "not-macos" ? "—" : renderKeys(s.keys, MAC_SYMBOLS);
      const pc = s.platform === "macos" ? "—" : renderKeys(s.pcKeys ?? s.keys, PC_SYMBOLS);
      lines.push(`| ${s.label} | ${mac} | ${pc} | ${notesFor(s)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    if (i + 1 >= args.length) throw new Error(`${name} needs a value`);
    return resolve(args[i + 1]);
  };
  const check = args.includes("--check");
  const TS_OUT = opt("--ts-out", TS_OUT_DEFAULT);
  const MD_OUT = opt("--md-out", MD_OUT_DEFAULT);
  const keymapPath = opt("--keymap", KEYMAP_SOURCE);
  const groups = loadShortcutGroups(
    readFileSync(opt("--menu", MENU_SOURCE), "utf8"),
    readFileSync(opt("--app", APP_SOURCE), "utf8"),
    existsSync(keymapPath) ? readFileSync(keymapPath, "utf8") : null,
  );
  const ts = renderTsModule(groups);
  const md = renderMarkdown(groups);

  if (check) {
    let stale = false;
    for (const [path, expected] of [
      [TS_OUT, ts],
      [MD_OUT, md],
    ]) {
      let actual;
      try {
        actual = readFileSync(path, "utf8");
      } catch {
        actual = null;
      }
      if (!sameText(actual, expected)) {
        console.error(`STALE: ${path} does not match what the menu, keymap.json and app-shortcuts.json generate.`);
        console.error("Run `node scripts/generate-shortcuts.mjs` and commit the result.");
        stale = true;
      }
    }
    if (stale) process.exit(1);
    console.log(`shortcuts docs are up to date (${groups.reduce((n, g) => n + g.shortcuts.length, 0)} shortcuts).`);
    return;
  }

  mkdirSync(dirname(TS_OUT), { recursive: true });
  mkdirSync(dirname(MD_OUT), { recursive: true });
  writeFileSync(TS_OUT, ts);
  writeFileSync(MD_OUT, md);
  console.log(`wrote ${TS_OUT}`);
  console.log(`wrote ${MD_OUT}`);
}

const TS_OUT_DEFAULT = TS_OUT;
const MD_OUT_DEFAULT = MD_OUT;

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
