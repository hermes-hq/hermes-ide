// ─── Everyday prompts: the pure rules behind the Library's first screen ──
//
// The front doors' answers taken from a search ("Lisbon", "5-day"), the
// advice label of a row, the domain groups of "Browse everything", the
// depth sections of results, "Used yesterday" and the launcher's task as a
// query. Kept free of React so they are the same in the Library and in
// Prompts (⌘J) and easy to test.

import type { DomainCount, EntryArg, ItemState, LibraryHit, VocabLevel } from "./types";

// ── Advice ───────────────────────────────────────────────────────────

/** The kind of professional-advice label a row carries, if any. */
export type CareKind = "health" | "money" | "legal";

export function careKind(adv: readonly string[] | undefined | null): CareKind | null {
  if (!adv || adv.length === 0) return null;
  if (adv.includes("medical") || adv.includes("mental-health")) return "health";
  if (adv.includes("financial")) return "money";
  if (adv.includes("legal")) return "legal";
  return null;
}

/** The advice values the health filter keeps. */
export const HEALTH_ADVICE = ["medical", "mental-health"];

// ── A front door's answers from the words of a search ────────────────

const DURATION = /^(\d{1,3})[-\s]?(day|days|night|nights|week|weeks|month|months)$/i;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const DURATION_ARG = /\b(days?|duration|length|how long|nights?|weeks?)\b/i;
const PLACE_ARG = /\b(destination|where|place|city|country|location|region)\b/i;
const PEOPLE_ARG = /\b(who|people|travell?ers|group|guests|party)\b/i;
const WHEN_ARG = /\b(when|month|dates?|season)\b/i;
const MONTH = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|spring|summer|autumn|fall|winter)$/i;
const isNumber = (w: string) => /^\d{1,2}$/.test(w) || NUMBER_WORDS[w.toLowerCase()] !== undefined;
const PEOPLE_WORD = /^(people|persons|adults|friends|guests|kids|children|travell?ers)$/i;

type Slot = "place" | "duration" | "when" | "people";
const SLOT_ORDER: Slot[] = ["place", "duration", "when", "people"];
const SLOT_ARG: Record<Slot, RegExp> = { place: PLACE_ARG, duration: DURATION_ARG, when: WHEN_ARG, people: PEOPLE_ARG };

/** The question whose name (best) or description matches. */
function bestArg(open: readonly EntryArg[], re: RegExp): EntryArg | undefined {
  return open.find((a) => re.test(a.name.replace(/[-_]/g, " "))) ?? open.find((a) => re.test(a.description ?? ""));
}

function plural(n: number, unit: string): string {
  const one = unit.replace(/s$/, "");
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

function titleCase(w: string): string {
  return w.length > 1 && w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

/**
 * The values a front door's questions take from what was left of a search:
 * "5-day" answers a how-long question ("5 days"), "2 people" or a lone
 * "two" a who-is-going one, "May" a when one, and the remaining words the
 * where one, or else the first open question. Answers that fit the same
 * question share it. Only non-boolean, non-choice questions are filled;
 * nothing is invented.
 */
export function fillFromLeftover(args: readonly EntryArg[], leftover: readonly string[]): Record<string, string> {
  const open = args.filter((a) => a.type !== "boolean" && !Array.isArray(a.enum));
  if (open.length === 0 || leftover.length === 0) return {};
  const words = [...leftover];
  const slots: Partial<Record<Slot, string>> = {};

  // "5-day", "5 days", "two weeks".
  for (let i = 0; i < words.length; i++) {
    const one = DURATION.exec(words[i]);
    const two = i + 1 < words.length ? DURATION.exec(`${words[i]} ${words[i + 1]}`) : null;
    const word = i + 1 < words.length && NUMBER_WORDS[words[i].toLowerCase()] ? DURATION.exec(`${NUMBER_WORDS[words[i].toLowerCase()]} ${words[i + 1]}`) : null;
    const m = one ?? two ?? word;
    if (!m) continue;
    slots.duration = plural(Number(m[1]), m[2].toLowerCase());
    words.splice(i, one ? 1 : 2);
    break;
  }
  // "2 people", "4 adults", or a number left alone ("for two").
  for (let i = 0; i < words.length; i++) {
    if (!isNumber(words[i])) continue;
    const n = /^\d+$/.test(words[i]) ? Number(words[i]) : NUMBER_WORDS[words[i].toLowerCase()];
    const unit = i + 1 < words.length && PEOPLE_WORD.test(words[i + 1]) ? words[i + 1].toLowerCase() : null;
    slots.people = `${n} ${unit ?? "people"}`;
    words.splice(i, unit ? 2 : 1);
    break;
  }
  // "May", "summer".
  const months = words.filter((w) => MONTH.test(w));
  if (months.length > 0) slots.when = months.map(titleCase).join(" ");
  const rest = words.filter((w) => !MONTH.test(w) && !isNumber(w));
  if (rest.length > 0) slots.place = rest.join(" ");

  // Each answer goes to the question that names it best (its name, then its
  // description); answers that land on the same question share it
  // ("Lisbon, 5 days, May" for "Where and when").
  const out: Record<string, string[]> = {};
  for (const slot of SLOT_ORDER) {
    const value = slots[slot];
    if (!value) continue;
    let arg = bestArg(open, SLOT_ARG[slot]);
    let text = value;
    if (slot === "place") {
      if (arg) text = rest.map(titleCase).join(" ");
      else arg = open.find((a) => !(a.name in out)) ?? open[0];
    }
    if (!arg) continue;
    (out[arg.name] ??= []).push(text);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join(", ")]));
}

/**
 * The entries an entry hands off to (hodios `pairs_with`): a list of ids,
 * or `{ prompts, workflows, personas, ... }` — tasks first, personas last.
 */
export function pairsWith(raw: unknown): string[] {
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "id" in x ? String((x as { id: unknown }).id) : "")).filter(Boolean) : [];
  if (Array.isArray(raw)) return ids(raw);
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const order = ["prompts", "workflows", ...Object.keys(o).filter((k) => !["prompts", "workflows", "personas"].includes(k)), "personas"];
  return [...new Set(order.flatMap((k) => ids(o[k])))];
}

/** The launcher's task as a search: its first line, at most 120 characters. */
export function taskQuery(task: string | null | undefined): string {
  const line = (task ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const q = line.trim().replace(/\s+/g, " ");
  if (q.length <= 120) return q;
  const cut = q.slice(0, 120);
  const space = cut.lastIndexOf(" ");
  return space > 60 ? cut.slice(0, space) : cut;
}

// ── Essentials ───────────────────────────────────────────────────────

/** The Essentials narrowed to an intent and a topic (either may be unset). */
export function filterEssentials(hits: readonly LibraryHit[], intent: string | null, topic: string | null): LibraryHit[] {
  return hits.filter((h) => (!intent || (h.intents ?? []).includes(intent)) && (!topic || h.topic === topic));
}

// ── Browse everything ────────────────────────────────────────────────

export type DomainGroupId = "everyday" | "work" | "making" | "more";

/** Which group a domain is browsed under; a domain this build does not know goes to "more". */
const DOMAIN_GROUP: Record<string, DomainGroupId> = {
  travel: "everyday",
  "home-cooking": "everyday",
  "health-wellbeing": "everyday",
  finance: "everyday",
  "parenting-family": "everyday",
  languages: "everyday",
  education: "everyday",
  "gaming-fun": "everyday",
  productivity: "everyday",
  "writing-communication": "work",
  "career-hr": "work",
  business: "work",
  "marketing-sales": "work",
  "legal-admin": "work",
  "research-science": "work",
  "product-management": "work",
  "software-engineering": "making",
  "data-analysis": "making",
  design: "making",
  "content-creation": "making",
  "creative-arts": "making",
  prompting: "making",
};
const GROUP_ORDER: DomainGroupId[] = ["everyday", "work", "making", "more"];

/** Domains grouped Everyday life / Work / Making & building, each in a fixed order; "other" left out. */
export function domainGroups(domains: readonly DomainCount[]): { id: DomainGroupId; domains: DomainCount[] }[] {
  const order = Object.keys(DOMAIN_GROUP);
  const pos = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return GROUP_ORDER.map((id) => ({
    id,
    domains: domains
      .filter((d) => d.id !== "other" && (DOMAIN_GROUP[d.id] ?? "more") === id)
      .sort((a, b) => pos(a.id) - pos(b.id) || b.count - a.count || a.label.localeCompare(b.label)),
  })).filter((g) => g.domains.length > 0);
}

// ── Depth sections ───────────────────────────────────────────────────

/**
 * Hits grouped by depth level in the vocab's order; hits of a level the
 * vocab does not list (or with none) go to the middle level. Without
 * levels, one unnamed section with everything.
 */
export function depthSections(hits: readonly LibraryHit[], depths: readonly VocabLevel[]): { level: VocabLevel | null; hits: LibraryHit[] }[] {
  if (depths.length === 0) return [{ level: null, hits: [...hits] }];
  const middle = depths[Math.floor(depths.length / 2)].id;
  const known = new Set(depths.map((d) => d.id));
  return depths
    .map((level) => ({
      level,
      hits: hits.filter((h) => {
        const d = h.depth && known.has(h.depth) ? h.depth : middle;
        return d === level.id;
      }),
    }))
    .filter((s) => s.hits.length > 0);
}

// ── Recent ───────────────────────────────────────────────────────────

export type UsedWhen =
  | { kind: "today"; uses: number }
  | { kind: "yesterday"; uses: number }
  | { kind: "days"; days: number; uses: number }
  | { kind: "pinned" }
  | null;

/** When an entry was last used or opened, for "Used yesterday" (local days). */
export function usedWhen(state: ItemState | undefined, now: Date = new Date()): UsedWhen {
  if (!state) return null;
  if (!state.lastUsedAt) return state.pinned ? { kind: "pinned" } : null;
  const at = new Date(state.lastUsedAt * 1000);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return { kind: "today", uses: state.useCount };
  if (days === 1) return { kind: "yesterday", uses: state.useCount };
  return { kind: "days", days, uses: state.useCount };
}

/** Recently used or opened ids, newest first. */
export function recentIds(states: readonly ItemState[], limit = 50): string[] {
  return states
    .filter((s) => s.lastUsedAt && !s.hidden)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, limit)
    .map((s) => s.itemId);
}

// ── The search box's facet hint ──────────────────────────────────────

/** A role that writes software: the "cat:testing works:codex" hint is for them. */
export function isDeveloperRole(role: string): boolean {
  return /(^|-)(engineer|developer)$/.test(role) || role === "tech-lead";
}

// The keys the backend's query language takes (search.rs key_spec).
const FACET_TOKEN = /(^|\s)(kind|cat|category|domain|sub|stage|role|stack|subject|works|in|out|risk|tag|tier|status|level|lang|depth|intent|topic|ess|adv):\S/;

/** A search that filters with the query language ("cat:testing"). */
export function usesFacets(query: string): boolean {
  return FACET_TOKEN.test(query);
}
