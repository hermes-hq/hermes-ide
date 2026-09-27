#!/usr/bin/env node
// Generates the Shortcuts panel data (src/generated/shortcuts.ts) and the
// shortcuts reference (docs/shortcuts.md) from the two places keyboard
// shortcuts are actually defined:
//   - the native menu bar (src-tauri/src/menu/mod.rs), and
//   - src/shortcuts/app-shortcuts.json, the declared list of bindings the app
//     handles itself (App.tsx's keydown handler matches keys only through it).
// Nothing here is hand-maintained, so the panel and the docs can never list a
// shortcut that isn't real, or miss one that is — removing an
// `.accelerator(...)` from the menu, or an entry from the JSON, removes it here.
//
//   node scripts/generate-shortcuts.mjs          # write both output files
//   node scripts/generate-shortcuts.mjs --check  # fail if they're stale (CI)
//
// --menu, --app, --ts-out and --md-out point it at other files (used by the
// N23-docs-gates scenario to prove a menu change makes the docs stale).
//
// Only items built with `MenuItemBuilder::with_id` / `CheckMenuItemBuilder::with_id`
// AND an explicit `.accelerator("...")` are shortcuts; everything else in the
// menu (predefined items, unbound entries) is not a keyboard shortcut.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const MENU_SOURCE = join(REPO_ROOT, "src-tauri", "src", "menu", "mod.rs");
export const APP_SOURCE = join(REPO_ROOT, "src", "shortcuts", "app-shortcuts.json");
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

/**
 * @returns {{ group: string, id: string, label: string, accelerator: string, platform?: string }[]}
 *   in the order they appear in the source, one entry per menu item that has
 *   both an id/label and an explicit accelerator.
 */
export function extractShortcuts(source) {
  const lines = source.split(/\r?\n/);
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
    const accel = /\.accelerator\(\s*"([^"]+)"\s*\)/.exec(body);
    if (!accel) continue;
    const lineIndex = lineIndexAt(m.index);
    items.push({
      group: groupAt(m.index),
      id,
      label,
      accelerator: accel[1],
      platform: platformOf(lines, lineIndex),
      source: "menu",
    });
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
    if (seen.has(raw.id)) throw new Error(`${where}: duplicate id "${raw.id}"`);
    seen.add(raw.id);
    return {
      group: raw.group,
      id: raw.id,
      label: raw.label,
      accelerator: raw.accelerators[0],
      accelerators: [...raw.accelerators],
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
  const combos = new Map();
  for (const item of all) {
    if (ids.has(item.id)) throw new Error(`shortcut id "${item.id}" is defined twice`);
    ids.add(item.id);
    for (const acc of item.accelerators ?? [item.accelerator]) {
      const canonical = toCanonicalKeys(acc);
      const other = combos.get(canonical);
      // A macOS-only and a Windows/Linux-only item never exist at the same time.
      if (other && !(other.platform && item.platform && other.platform !== item.platform)) {
        throw new Error(`${acc} is bound twice: "${other.id}" and "${item.id}"`);
      }
      combos.set(canonical, item);
    }
  }
  return all;
}

/** Read both sources and return the grouped list the outputs are rendered from. */
export function loadShortcutGroups(menuSource = readFileSync(MENU_SOURCE, "utf8"), appJson = readFileSync(APP_SOURCE, "utf8")) {
  return groupShortcuts(combineShortcuts(extractShortcuts(menuSource), parseAppShortcuts(JSON.parse(appJson))));
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

// ─── Render the generated files ─────────────────────────────────────────

const HEADER =
  "// GENERATED FILE — do not edit by hand.\n" +
  "// Run `node scripts/generate-shortcuts.mjs` to regenerate from\n" +
  "// src-tauri/src/menu/mod.rs and src/shortcuts/app-shortcuts.json.\n";

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
      const platform = s.platform ? `, platform: ${JSON.stringify(s.platform)}` : "";
      lines.push(
        `      { id: ${JSON.stringify(s.id)}, label: ${JSON.stringify(s.label)}, labelKey: ${JSON.stringify(labelKeyFor(s.id))}, keys: ${JSON.stringify(toCanonicalKeys(s.accelerator))}${platform} },`,
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
  const alternates = (s.accelerators ?? []).slice(1);
  if (alternates.length) notes.push(`also ${alternates.map((a) => `${macKeys(a)} / ${pcKeys(a)}`).join(", ")}`);
  return notes.join("; ");
}

export function renderMarkdown(groups) {
  const lines = [
    "# Keyboard shortcuts",
    "",
    "<!-- GENERATED FILE — do not edit by hand. Run `node scripts/generate-shortcuts.mjs`",
    "     to regenerate from src-tauri/src/menu/mod.rs and src/shortcuts/app-shortcuts.json. -->",
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
      const mac = s.platform === "not-macos" ? "—" : macKeys(s.accelerator);
      const pc = s.platform === "macos" ? "—" : pcKeys(s.accelerator);
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
  const groups = loadShortcutGroups(readFileSync(opt("--menu", MENU_SOURCE), "utf8"), readFileSync(opt("--app", APP_SOURCE), "utf8"));
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
      if (actual !== expected) {
        console.error(`STALE: ${path} does not match what src-tauri/src/menu/mod.rs and src/shortcuts/app-shortcuts.json generate.`);
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
