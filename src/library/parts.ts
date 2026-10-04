// ─── Library personas and styles in the prompt Builder ───────────────
//
// The Builder's roles are library personas and its styles are library
// styles, next to the person's own. A saved 2.0 id ("backend-eng",
// "concise", a pinned "debug-root-cause") resolves through the catalog's
// aliases to its library entry. Only when the catalog has no entry for an
// old id does its 2.0 text stand in, and that is logged once per id.

import { libraryGet, libraryResolve, librarySearch, librarySetItem } from "./api";
import { isUserId, warnMissingAlias } from "./legacy";
import { render } from "./render";
import { getSetting, setSetting } from "../api/settings";
import { BUILT_IN_ROLES, type RoleDefinition } from "../lib/roles";
import { BUILT_IN_STYLES, type StyleDefinition } from "../lib/styles";
import { BUILT_IN_TEMPLATES } from "../lib/templates";

const OLD_ROLES = new Map(BUILT_IN_ROLES.map((r) => [r.id, r]));
const OLD_STYLES = new Map(BUILT_IN_STYLES.map((s) => [s.id, s]));
const OLD_TEMPLATE_IDS = new Set(BUILT_IN_TEMPLATES.map((t) => t.id));

export const oldRole = (id: string): RoleDefinition | undefined => OLD_ROLES.get(id);
export const oldStyle = (id: string): StyleDefinition | undefined => OLD_STYLES.get(id);

export interface PartItem {
  id: string;
  title: string;
  description: string;
}

/** Every library persona or style (title and description only), sorted by title. */
export async function listParts(kind: "persona" | "style"): Promise<PartItem[]> {
  const out: PartItem[] = [];
  let cursor: string | null = null;
  // At most 50 rows a page; 40 pages is far above today's catalog.
  for (let page = 0; page < 40; page++) {
    const res = await librarySearch({ query: "", filters: { kind: [kind] }, limit: 50, cursor, sort: "best", personalise: false });
    for (const h of res.hits) out.push({ id: h.id, title: h.title, description: h.description });
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export interface LoadedPart {
  id: string;
  kind: string;
  title: string;
  description: string;
  /** A persona, rendered as a role. */
  text: string;
  /** A style's five level instructions. */
  levels: string[] | null;
}

const loaded = new Map<string, Promise<LoadedPart | null>>();

/** One persona or style with its text (cached; null when it cannot be read). */
export function loadPart(id: string): Promise<LoadedPart | null> {
  let p = loaded.get(id);
  if (!p) {
    p = (async () => {
      const d = await libraryGet(id);
      if (!d.body) return null;
      const levels = Array.isArray(d.body.fm.levels) ? d.body.fm.levels.map((l) => l.instruction) : null;
      const text = d.row.kind === "persona" ? await render(d.body, {}) : "";
      return { id: d.id, kind: d.row.kind, title: d.row.title, description: d.row.desc, text, levels };
    })().catch((e) => {
      loaded.delete(id);
      console.warn(`[library] could not read ${id}:`, e);
      return null;
    });
    loaded.set(id, p);
  }
  return p;
}

function five(levels: string[]): [string, string, string, string, string] {
  const l = levels.length > 0 ? levels : [""];
  return [0, 1, 2, 3, 4].map((i) => l[Math.min(i, l.length - 1)]) as [string, string, string, string, string];
}

export function asRole(p: { title: string; description: string; text: string }, id: string): RoleDefinition {
  return { id, label: p.title, description: p.description || undefined, systemInstruction: p.text, builtIn: true };
}

export function asStyle(p: { title: string; description: string; levels: string[] | null }, id: string): StyleDefinition {
  return { id, label: p.title, description: p.description || undefined, levels: five(p.levels ?? []), builtIn: true };
}

/** Library ids for saved ids that are not the person's own (an id or an alias the catalog carries). */
export async function resolvePartIds(ids: readonly string[]): Promise<Record<string, string>> {
  const ask = [...new Set(ids)].filter((id) => id && !isUserId(id));
  if (ask.length === 0) return {};
  try {
    return await libraryResolve(ask);
  } catch (e) {
    console.warn("[library] resolving saved ids failed:", e);
    return {};
  }
}

/**
 * Role and style definitions for saved ids, keyed by the id as saved: the
 * library entry it resolves to, else (an old built-in with no entry) its
 * 2.0 text, logged. The person's own ids are left to their own lists.
 */
export async function definitionsFor(
  roleIds: readonly string[],
  styleIds: readonly string[],
): Promise<{ roles: RoleDefinition[]; styles: StyleDefinition[] }> {
  const map = await resolvePartIds([...roleIds, ...styleIds]);
  const roles: RoleDefinition[] = [];
  const styles: StyleDefinition[] = [];
  await Promise.all([
    ...[...new Set(roleIds)].filter((id) => !isUserId(id)).map(async (id) => {
      const part = map[id] ? await loadPart(map[id]) : null;
      if (part && part.text) return void roles.push(asRole(part, id));
      const old = OLD_ROLES.get(id);
      if (old) {
        warnMissingAlias(id, "role");
        roles.push(old);
      }
    }),
    ...[...new Set(styleIds)].filter((id) => !isUserId(id)).map(async (id) => {
      const part = map[id] ? await loadPart(map[id]) : null;
      if (part && part.levels?.length) return void styles.push(asStyle(part, id));
      const old = OLD_STYLES.get(id);
      if (old) {
        warnMissingAlias(id, "style");
        styles.push(old);
      }
    }),
  ]);
  return { roles, styles };
}

const MOVED_PINS = "pinned_templates_library";

function parseIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A 2.0 pin on a built-in template becomes a pin on its library entry, once
 * (recorded in its own setting; `pinned_templates` is never rewritten).
 * Returns the pinned built-in ids the catalog has no entry for.
 */
export async function carryLegacyPins(): Promise<string[]> {
  const [pinsRaw, movedRaw] = await Promise.all([
    getSetting("pinned_templates").catch(() => ""),
    getSetting(MOVED_PINS).catch(() => ""),
  ]);
  const moved = new Set(parseIds(movedRaw));
  const todo = parseIds(pinsRaw).filter((id) => OLD_TEMPLATE_IDS.has(id) && !moved.has(id));
  if (todo.length === 0) return [];
  const map = await resolvePartIds(todo);
  const missing: string[] = [];
  for (const id of todo) {
    if (!map[id]) {
      warnMissingAlias(id, "template");
      missing.push(id);
      continue;
    }
    try {
      await librarySetItem(map[id], { pinned: true });
      moved.add(id);
    } catch (e) {
      console.warn(`[library] could not carry the pin on ${id}:`, e);
    }
  }
  await setSetting(MOVED_PINS, JSON.stringify([...moved])).catch(() => {});
  return missing;
}
