/**
 * The backend refuses `set_setting` for any key missing from
 * VALID_SETTING_KEYS (src-tauri/src/db/mod.rs), and most callers swallow
 * that error.  A key the frontend writes but the allowlist lacks is a
 * setting that silently never saves (the Library's carried-pins marker
 * did this, so unpinned entries came back pinned on every open).
 *
 * Checks every `setSetting("key", …)` and every `setSetting(KEY, …)`
 * whose `const KEY = "key"` sits in the same file.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");
const DB_RS = path.resolve(__dirname, "../../src-tauri/src/db/mod.rs");

function allowlist(): Set<string> {
  const rs = fs.readFileSync(DB_RS, "utf-8");
  const body = rs.match(/const VALID_SETTING_KEYS: &\[&str\] = &\[([\s\S]*?)\n\];/)?.[1] ?? "";
  const keys = body.replace(/\/\/[^\n]*/g, "").match(/"[^"]+"/g) ?? [];
  return new Set(keys.map((k) => k.slice(1, -1)));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function writtenKeys(): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, "utf-8");
    for (const m of text.matchAll(/setSetting\(\s*"([^"]+)"/g)) out.push({ key: m[1], file });
    for (const m of text.matchAll(/setSetting\(\s*([A-Z_][A-Z0-9_]*)\s*,/g)) {
      const decl = text.match(new RegExp(`const ${m[1]}\\s*(?::\\s*\\w+\\s*)?=\\s*"([^"]+)"`));
      if (decl) out.push({ key: decl[1], file });
    }
  }
  return out;
}

describe("setting keys the frontend writes", () => {
  it("are all accepted by the backend allowlist", () => {
    const allowed = allowlist();
    expect(allowed.size).toBeGreaterThan(20);
    const written = writtenKeys();
    expect(written.some((w) => w.key === "pinned_templates_library")).toBe(true);
    const refused = written
      .filter((w) => !allowed.has(w.key))
      .map((w) => `${w.key} (${path.relative(SRC, w.file)})`);
    expect(refused).toEqual([]);
  });
});
