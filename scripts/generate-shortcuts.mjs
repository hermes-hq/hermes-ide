#!/usr/bin/env node
// Generates the Shortcuts panel data (src/generated/shortcuts.ts) and the
// shortcuts reference (docs/shortcuts.md) from the ONE place the keyboard
// accelerators are actually defined: the native menu bar
// (src-tauri/src/menu/mod.rs). Nothing here is hand-maintained, so the panel
// and the docs can never list a shortcut that isn't real, or miss one that
// is — removing an `.accelerator(...)` from the menu removes it here too.
//
//   node scripts/generate-shortcuts.mjs          # write both output files
//   node scripts/generate-shortcuts.mjs --check  # fail if they're stale (CI)
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
    });
  }
  return items;
}

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

/** "CmdOrCtrl+Shift+D" → "{mod}{shift}D" */
export function toCanonicalKeys(accelerator) {
  const tokens = accelerator.split("+");
  const key = tokens.pop();
  return tokens.map((t) => TOKEN_MAP[t] ?? `{${t.toLowerCase()}}`).join("") + key;
}

const MAC_SYMBOLS = { "{mod}": "⌘", "{shift}": "⇧", "{alt}": "⌥", "{ctrl}": "⌃" };
const PC_SYMBOLS = { "{mod}": "Ctrl+", "{shift}": "Shift+", "{alt}": "Alt+", "{ctrl}": "Ctrl+" };

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
  "// src-tauri/src/menu/mod.rs (the menu bar is the source of truth).\n";

export function renderTsModule(groups) {
  const lines = [HEADER, ""];
  lines.push("export interface GeneratedShortcut {");
  lines.push("  id: string;");
  lines.push("  label: string;");
  lines.push("  /** Canonical key string for `fmt()` in ../utils/platform, e.g. \"{mod}N\". */");
  lines.push("  keys: string;");
  lines.push("  /** Set only when the menu only registers this accelerator on one platform family. */");
  lines.push('  platform?: "macos" | "not-macos";');
  lines.push("}");
  lines.push("");
  lines.push("export interface GeneratedShortcutGroup {");
  lines.push("  group: string;");
  lines.push("  shortcuts: GeneratedShortcut[];");
  lines.push("}");
  lines.push("");
  lines.push("export const GENERATED_SHORTCUT_GROUPS: GeneratedShortcutGroup[] = [");
  for (const { group, shortcuts } of groups) {
    lines.push(`  {`);
    lines.push(`    group: ${JSON.stringify(group)},`);
    lines.push(`    shortcuts: [`);
    for (const s of shortcuts) {
      const platform = s.platform ? `, platform: ${JSON.stringify(s.platform)}` : "";
      lines.push(
        `      { id: ${JSON.stringify(s.id)}, label: ${JSON.stringify(s.label)}, keys: ${JSON.stringify(toCanonicalKeys(s.accelerator))}${platform} },`,
      );
    }
    lines.push(`    ],`);
    lines.push(`  },`);
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

function platformNote(platform) {
  if (platform === "macos") return "macOS only";
  if (platform === "not-macos") return "Windows / Linux only";
  return "";
}

export function renderMarkdown(groups) {
  const lines = [
    "# Keyboard shortcuts",
    "",
    "<!-- GENERATED FILE — do not edit by hand. Run `node scripts/generate-shortcuts.mjs`",
    "     to regenerate from src-tauri/src/menu/mod.rs, the app's native menu bar. -->",
    "",
    "This is every keyboard accelerator the Hermes menu bar registers, generated",
    "directly from the menu definition so it can never drift from what the app",
    "actually does. It does not include shortcuts handled purely in the",
    "frontend with no native menu entry.",
    "",
  ];
  for (const { group, shortcuts } of groups) {
    lines.push(`## ${group}`, "");
    lines.push("| Action | macOS | Windows / Linux | Notes |");
    lines.push("|---|---|---|---|");
    for (const s of shortcuts) {
      const mac = s.platform === "not-macos" ? "—" : macKeys(s.accelerator);
      const pc = s.platform === "macos" ? "—" : pcKeys(s.accelerator);
      lines.push(`| ${s.label} | ${mac} | ${pc} | ${platformNote(s.platform)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function main() {
  const check = process.argv.includes("--check");
  const source = readFileSync(MENU_SOURCE, "utf8");
  const groups = groupShortcuts(extractShortcuts(source));
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
        console.error(`STALE: ${path} does not match what src-tauri/src/menu/mod.rs generates.`);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
