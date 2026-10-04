// ─── Hermes 2.0 prompts inside the Library ───────────────────────────
//
// The person's 2.0 templates, groups, pins, custom roles and styles are
// migrated into Mine (myPrompts.ts) and their settings keys are left as
// they were. The Library and the Prompts palette show them as "Mine". The 2.0
// built-ins are library entries now (by id or reviewed alias); one the
// catalog has no entry for stays as a read-only "Hermes classic". An old id
// resolves in this order:
//
//   1. the person's own item (user-…, custom-role-…, custom-style-…);
//   2. a library entry that carries it as its id or a reviewed alias;
//   3. the classic copy (the 2.0 arrays, unchanged);
//   4. kept as it is and shown as missing — never dropped.

import type { PromptTemplate } from "../lib/templates";
import type { RoleDefinition } from "../lib/roles";
import type { StyleDefinition } from "../lib/styles";

export interface LegacyItem {
  /** "classic:template:<id>", "mine:<id>" … unique in the Library. */
  key: string;
  id: string;
  group: "classic" | "mine";
  source: "template" | "role" | "style";
  title: string;
  description: string;
  category: string;
  /** What "Use in session" sends. */
  text: string;
}

type Compile = typeof import("../lib/compilePrompt");

let compileModule: Promise<Compile> | null = null;
const loadCompile = () => (compileModule ??= import("../lib/compilePrompt"));

function templateText(c: Compile, tpl: PromptTemplate, roles: RoleDefinition[], styles: StyleDefinition[]): string {
  const fields = (tpl.fields ?? {}) as Record<string, unknown>;
  // A 1.x template keeps one free-text role.
  if (typeof fields.role === "string") {
    return c.compilePromptLegacy({
      role: String(fields.role ?? ""),
      task: String(fields.task ?? ""),
      scope: String(fields.scope ?? ""),
      constraints: String(fields.constraints ?? ""),
      style: String(fields.style ?? ""),
    });
  }
  const f = tpl.fields ?? {};
  return c.compilePrompt(
    {
      ...c.EMPTY_FIELDS,
      ...f,
      roleIds: f.roleIds?.length ? f.roleIds : (tpl.recommendedRoles ?? []),
      styleSelections: f.styleSelections?.length ? f.styleSelections : (tpl.recommendedStyles ?? []),
    },
    roles,
    styles,
  );
}

/** The 2.0 built-in templates, roles and styles, read-only. */
export async function loadClassics(): Promise<LegacyItem[]> {
  const c = await loadCompile();
  const roles = c.BUILT_IN_ROLES;
  const styles = c.BUILT_IN_STYLES;
  const out: LegacyItem[] = [];
  for (const t of c.BUILT_IN_TEMPLATES) {
    out.push({
      key: `classic:template:${t.id}`,
      id: t.id,
      group: "classic",
      source: "template",
      title: t.name,
      description: t.description ?? "",
      category: t.category,
      text: templateText(c, t, roles, styles),
    });
  }
  for (const r of roles) {
    out.push({ key: `classic:role:${r.id}`, id: r.id, group: "classic", source: "role", title: r.label, description: r.description ?? "", category: "role", text: r.systemInstruction });
  }
  for (const s of styles) {
    out.push({ key: `classic:style:${s.id}`, id: s.id, group: "classic", source: "style", title: s.label, description: s.description ?? "", category: "style", text: s.levels[2] });
  }
  return out;
}

/**
 * What each 2.0 template sends, keyed by its id: compiled exactly as the
 * 2.0 composer did, its built-in role and style ids resolved to their
 * library entries (the 2.0 text only when the catalog has none), its own
 * roles and styles from `roles` / `styles`.
 */
export async function legacyTemplateText(
  saved: readonly PromptTemplate[],
  ownRoles: readonly RoleDefinition[],
  ownStyles: readonly StyleDefinition[],
): Promise<Map<string, string>> {
  const c = await loadCompile();
  const list = saved.filter((t) => t && typeof t.id === "string");
  const roleIds = list.flatMap((t) => [...(t.fields?.roleIds ?? []), ...(t.recommendedRoles ?? [])]);
  const styleIds = list.flatMap((t) => [...(t.fields?.styleSelections ?? []), ...(t.recommendedStyles ?? [])].map((s) => s?.id));
  const { definitionsFor } = await import("./parts");
  const lib = await definitionsFor(roleIds.filter((id): id is string => typeof id === "string"), styleIds.filter((id): id is string => typeof id === "string"));
  const roles = [...lib.roles, ...ownRoles];
  const styles = [...lib.styles, ...ownStyles];
  return new Map(list.map((t) => [t.id, templateText(c, t, roles, styles)]));
}

/** The person's own prompts (Mine), as Library rows. */
export async function loadMine(): Promise<LegacyItem[]> {
  const { loadMyPrompts } = await import("./myPrompts");
  const mine = await loadMyPrompts();
  return mine.map((m) => ({
    key: `mine:${m.id}`,
    id: m.id,
    group: "mine" as const,
    source: m.kind === "persona" ? ("role" as const) : m.kind === "style" ? ("style" as const) : ("template" as const),
    title: m.title || m.id,
    description: m.description,
    category: m.folder ?? "",
    text: m.text,
  }));
}

/** Items whose title, description, id or text holds every word of the query. */
export function filterLegacy(items: readonly LegacyItem[], query: string): LegacyItem[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !/^[a-z]+:/.test(w));
  if (words.length === 0) return [...items];
  return items.filter((i) => {
    const hay = `${i.title} ${i.description} ${i.id} ${i.category}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const warned = new Set<string>();

/** Logs, once per id, that a 2.0 built-in has no library entry and its old text is used. */
export function warnMissingAlias(id: string, what: LegacyItem["source"]): void {
  const key = `${what}:${id}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[library] the 2.0 built-in ${what} "${id}" has no library entry; using its 2.0 text`);
}

/** Test hook: forget which ids were already logged. */
export function resetMissingAliasLog(): void {
  warned.clear();
}

export type Resolution =
  | { kind: "user"; id: string }
  | { kind: "library"; id: string }
  | { kind: "classic"; id: string; source: LegacyItem["source"] }
  | { kind: "missing"; id: string };

export function isUserId(id: string): boolean {
  return id.startsWith("user-") || id.startsWith("custom-role-") || id.startsWith("custom-style-") || id.startsWith("custom-");
}

/**
 * Where each old id leads now. `libraryIds` is the backend's alias answer
 * (library_resolve); `classics` the 2.0 arrays; `mine` the person's items.
 */
export function resolveIds(
  ids: readonly string[],
  libraryIds: Readonly<Record<string, string>>,
  classics: readonly LegacyItem[],
  mine: readonly LegacyItem[],
): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const id of ids) {
    if (isUserId(id) || mine.some((m) => m.id === id)) out[id] = { kind: "user", id };
    else if (libraryIds[id]) out[id] = { kind: "library", id: libraryIds[id] };
    else {
      const classic = classics.find((c) => c.id === id);
      out[id] = classic ? { kind: "classic", id, source: classic.source } : { kind: "missing", id };
    }
  }
  return out;
}

/** Classics that a library entry replaces (by id or reviewed alias) are not listed twice. */
export function visibleClassics(classics: readonly LegacyItem[], libraryIds: Readonly<Record<string, string>>): LegacyItem[] {
  return classics.filter((c) => !libraryIds[c.id]);
}
