// ─── Mine: the person's own prompts ──────────────────────────────────
//
// One list in one setting (`my_prompts`): prompts the person wrote or saved
// from the Library, plus their own personas and styles. The first read with
// no list migrates the 2.0 data into it, and nothing is lost:
//
//   - every saved template becomes a prompt whose text is exactly what the
//     2.0 composer sent (roles, task, scope, constraints and styles compiled
//     together), its group becomes its folder, its pin carries over;
//   - custom roles become personas, custom styles become styles (all five
//     levels).
//
// The 2.0 keys (prompt_templates, template_groups, pinned_templates,
// custom_roles, custom_styles) are read and never written or removed, so an
// older build still finds everything where it left it.

import { getSetting, setSetting } from "../api/settings";
import type { PromptTemplate } from "../lib/templates";
import type { RoleDefinition } from "../lib/roles";
import type { StyleDefinition } from "../lib/styles";
import type { PromptBundle } from "../lib/promptBundle";
import type { EntryArg } from "./types";
import { savedArgs } from "./promptPicker";

export const MY_PROMPTS_KEY = "my_prompts";

export type MyKind = "prompt" | "persona" | "style";

export interface MyPrompt {
  /** A migrated 2.0 item keeps its id (user-…, custom-…); new ones are mine-<time>. */
  id: string;
  kind: MyKind;
  title: string;
  description: string;
  /** What the agent receives (a style: its middle level). */
  text: string;
  /** A style's five level instructions. */
  levels?: string[];
  /** Blanks asked for each time (`{{name}}` in the text), kept from the library prompt it was saved from. */
  args?: EntryArg[];
  folder?: string;
  pinned?: boolean;
  /** The library entry this is a copy of. */
  from?: { id: string; version: string } | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
  useCount?: number;
}

function parseList<T>(raw: unknown): T[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Keeps only well-formed items (a hand-edited setting cannot break the picker). */
export function cleanList(list: unknown[]): MyPrompt[] {
  const out: MyPrompt[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Partial<MyPrompt>;
    if (typeof m.id !== "string" || typeof m.title !== "string" || typeof m.text !== "string") continue;
    const kind: MyKind = m.kind === "persona" || m.kind === "style" ? m.kind : "prompt";
    out.push({
      id: m.id,
      kind,
      title: m.title,
      description: typeof m.description === "string" ? m.description : "",
      text: m.text,
      ...(Array.isArray(m.levels) ? { levels: m.levels.map(String) } : {}),
      ...(Array.isArray(m.args) ? { args: m.args.filter((a) => a && typeof a.name === "string").map((a) => ({ ...a, description: String(a.description ?? "") })) } : {}),
      ...(typeof m.folder === "string" && m.folder ? { folder: m.folder } : {}),
      ...(m.pinned ? { pinned: true } : {}),
      ...(m.from && typeof m.from.id === "string" ? { from: { id: m.from.id, version: String(m.from.version ?? "") } } : {}),
      createdAt: Number(m.createdAt) || 0,
      updatedAt: Number(m.updatedAt) || 0,
      lastUsedAt: typeof m.lastUsedAt === "number" ? m.lastUsedAt : null,
      useCount: Number(m.useCount) || 0,
    });
  }
  return out;
}

/** The 2.0 data as read from its settings keys. */
export interface LegacyData {
  templates: PromptTemplate[];
  roles: RoleDefinition[];
  styles: StyleDefinition[];
  pinned: string[];
}

/** The library entry a 2.0 "Duplicate" copied (stored as `source`). */
function sourceOf(tpl: PromptTemplate): { id: string; version: string } | null {
  const s = (tpl as PromptTemplate & { source?: { id?: unknown; version?: unknown } }).source;
  return s && typeof s.id === "string" ? { id: s.id, version: typeof s.version === "string" ? s.version : "" } : null;
}

/**
 * The 2.0 data as Mine items. `templateText` compiles a template exactly as
 * the 2.0 composer did (see legacy.ts); it is passed in so this stays pure.
 */
export function migrateLegacy(data: LegacyData, templateText: (tpl: PromptTemplate) => string, now = Date.now()): MyPrompt[] {
  const pinned = new Set(data.pinned);
  const out: MyPrompt[] = [];
  for (const tpl of data.templates) {
    if (!tpl || typeof tpl.id !== "string") continue;
    const text = templateText(tpl);
    // A {{name}} in a 2.0 template becomes a blank asked for each time.
    const args = savedArgs(text, []);
    out.push({
      id: tpl.id,
      kind: "prompt",
      title: tpl.name || tpl.id,
      description: tpl.description ?? "",
      text,
      ...(args.length ? { args } : {}),
      ...(tpl.group ? { folder: tpl.group } : {}),
      ...(pinned.has(tpl.id) ? { pinned: true } : {}),
      ...(sourceOf(tpl) ? { from: sourceOf(tpl) } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const r of data.roles) {
    if (!r || typeof r.id !== "string") continue;
    out.push({ id: r.id, kind: "persona", title: r.label || r.id, description: r.description ?? "", text: r.systemInstruction ?? "", createdAt: now, updatedAt: now });
  }
  for (const s of data.styles) {
    if (!s || typeof s.id !== "string") continue;
    const levels = Array.isArray(s.levels) ? s.levels.map(String) : [];
    out.push({ id: s.id, kind: "style", title: s.label || s.id, description: s.description ?? "", text: levels[2] ?? levels[0] ?? "", levels, createdAt: now, updatedAt: now });
  }
  return out;
}

let cache: Promise<MyPrompt[]> | null = null;
const listeners = new Set<(list: MyPrompt[]) => void>();

async function readLegacy(): Promise<{ data: LegacyData }> {
  const [t, r, s, p] = await Promise.all([
    getSetting("prompt_templates").catch(() => ""),
    getSetting("custom_roles").catch(() => ""),
    getSetting("custom_styles").catch(() => ""),
    getSetting("pinned_templates").catch(() => ""),
  ]);
  const data: LegacyData = {
    templates: parseList<PromptTemplate>(t),
    roles: parseList<RoleDefinition>(r),
    styles: parseList<StyleDefinition>(s),
    pinned: parseList<string>(p).filter((x) => typeof x === "string"),
  };
  return { data };
}

/** The 2.0 ids already moved into Mine (so a later old-build save still arrives, and a deleted one stays gone). */
export const MIGRATED_KEY = "my_prompts_migrated";

let notice: { prompts: number; personas: number; styles: number } | null = null;

/** How many 2.0 items this run moved into Mine, once (the palette says so the first time). */
export function takeMigrationNotice(): { prompts: number; personas: number; styles: number } | null {
  const n = notice;
  notice = null;
  return n;
}

/** The 2.0 items whose ids are not in `done`. */
export function pendingLegacy(data: LegacyData, done: ReadonlySet<string>): LegacyData {
  return {
    templates: data.templates.filter((x) => x && typeof x.id === "string" && !done.has(x.id)),
    roles: data.roles.filter((x) => x && typeof x.id === "string" && !done.has(x.id)),
    styles: data.styles.filter((x) => x && typeof x.id === "string" && !done.has(x.id)),
    pinned: data.pinned,
  };
}

async function load(): Promise<MyPrompt[]> {
  const [raw, rawDone] = await Promise.all([getSetting(MY_PROMPTS_KEY).catch(() => ""), getSetting(MIGRATED_KEY).catch(() => "")]);
  const had = typeof raw === "string" && raw !== "";
  const list = had ? cleanList(parseList(raw)) : [];
  // Before this key existed, every item in Mine that keeps a 2.0 id was migrated.
  const done = new Set<string>(rawDone ? parseList<string>(rawDone) : list.map((m) => m.id));
  const { data } = await readLegacy();
  const todo = pendingLegacy(data, done);
  if (todo.templates.length + todo.roles.length + todo.styles.length === 0) return list;
  const { legacyTemplateText } = await import("./legacy");
  // Built-in role and style ids resolve to library text, else their bundled 2.0 text.
  const text = await legacyTemplateText(todo.templates, data.roles, data.styles);
  const moved = migrateLegacy(todo, (tpl) => text.get(tpl.id) ?? "");
  const next = [...list, ...moved.filter((m) => !list.some((x) => x.id === m.id))];
  for (const m of moved) done.add(m.id);
  await setSetting(MY_PROMPTS_KEY, JSON.stringify(next));
  await setSetting(MIGRATED_KEY, JSON.stringify([...done]));
  notice = {
    prompts: moved.filter((m) => m.kind === "prompt").length,
    personas: moved.filter((m) => m.kind === "persona").length,
    styles: moved.filter((m) => m.kind === "style").length,
  };
  return next;
}

/** Every Mine item (migrating the 2.0 data on the first read). */
export function loadMyPrompts(): Promise<MyPrompt[]> {
  cache ??= load().catch((e) => {
    cache = null;
    throw e;
  });
  return cache;
}

/** Calls `fn` with the new list after every change; returns how to stop. */
export function onMyPromptsChange(fn: (list: MyPrompt[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function write(next: MyPrompt[]): Promise<MyPrompt[]> {
  await setSetting(MY_PROMPTS_KEY, JSON.stringify(next));
  cache = Promise.resolve(next);
  for (const fn of listeners) fn(next);
  return next;
}

export async function saveMyPrompt(item: Omit<MyPrompt, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<MyPrompt> {
  const list = await loadMyPrompts();
  const now = Date.now();
  const existing = item.id ? list.find((m) => m.id === item.id) : undefined;
  const saved: MyPrompt = existing
    ? { ...existing, ...item, id: existing.id, updatedAt: now }
    : { ...item, id: item.id ?? `mine-${now}`, createdAt: now, updatedAt: now };
  await write(existing ? list.map((m) => (m.id === saved.id ? saved : m)) : [saved, ...list]);
  return saved;
}

export async function deleteMyPrompt(id: string): Promise<void> {
  const list = await loadMyPrompts();
  await write(list.filter((m) => m.id !== id));
}

export async function setMyPinned(id: string, pinned: boolean): Promise<void> {
  const list = await loadMyPrompts();
  await write(list.map((m) => (m.id === id ? { ...m, pinned: pinned || undefined } : m)));
}

export async function recordMyUse(id: string, now = Date.now()): Promise<void> {
  const list = await loadMyPrompts();
  await write(list.map((m) => (m.id === id ? { ...m, lastUsedAt: now, useCount: (m.useCount ?? 0) + 1 } : m)));
}

/** Test hook: forget the cached list. */
export function resetMyPromptsCache(): void {
  cache = null;
  notice = null;
  listeners.clear();
}

// ── Files (.hermes-prompts, the 2.0 bundle format) ───────────────────

/** Mine as a 2.0 bundle, so an older Hermes can import it too. */
export function toBundle(list: readonly MyPrompt[], appVersion: string, name?: string): PromptBundle {
  const templates: PromptTemplate[] = [];
  const roles: RoleDefinition[] = [];
  const styles: StyleDefinition[] = [];
  for (const m of list) {
    if (m.kind === "persona") roles.push({ id: m.id, label: m.title, description: m.description || undefined, systemInstruction: m.text, builtIn: false });
    else if (m.kind === "style") {
      const l = m.levels && m.levels.length > 0 ? m.levels : [m.text];
      const five = [0, 1, 2, 3, 4].map((i) => l[Math.min(i, l.length - 1)]) as StyleDefinition["levels"];
      styles.push({ id: m.id, label: m.title, description: m.description || undefined, levels: five, builtIn: false });
    } else {
      templates.push({
        id: m.id,
        name: m.title,
        ...(m.description ? { description: m.description } : {}),
        category: "documentation",
        recommendedRoles: [],
        recommendedStyles: [],
        builtIn: false,
        ...(m.folder ? { group: m.folder } : {}),
        fields: { roleIds: [], task: m.text, scope: "", constraints: "", styleSelections: [], style: "" },
      } as PromptTemplate);
    }
  }
  return {
    _hermes_bundle_version: 1,
    _hermes_app_version: appVersion,
    _hermes_exported_at: new Date().toISOString(),
    ...(name ? { _hermes_bundle_name: name } : {}),
    templates,
    roles,
    styles,
  };
}

/**
 * The items of a bundle not already in Mine (same kind and title, ignoring
 * case). Templates are compiled with `templateText` (roles and styles of the
 * bundle included), so they read the same as where they came from.
 */
export function fromBundle(
  bundle: PromptBundle,
  existing: readonly MyPrompt[],
  templateText: (tpl: PromptTemplate) => string,
  folder?: string,
  now = Date.now(),
): { added: MyPrompt[]; skipped: number } {
  const taken = new Set(existing.map((m) => `${m.kind}:${m.title.toLowerCase()}`));
  const migrated = migrateLegacy({ templates: bundle.templates ?? [], roles: bundle.roles ?? [], styles: bundle.styles ?? [], pinned: [] }, templateText, now);
  const added: MyPrompt[] = [];
  let skipped = 0;
  migrated.forEach((m, i) => {
    const k = `${m.kind}:${m.title.toLowerCase()}`;
    if (taken.has(k)) {
      skipped++;
      return;
    }
    taken.add(k);
    added.push({ ...m, id: `mine-${now}-${i}`, ...(m.kind === "prompt" && !m.folder && folder ? { folder } : {}) });
  });
  return { added, skipped };
}

export async function addMyPrompts(items: readonly MyPrompt[]): Promise<void> {
  if (items.length === 0) return;
  const list = await loadMyPrompts();
  await write([...items, ...list]);
}
