// ─── The Prompts palette: what it shows and in what order ────────────
//
// Pure functions behind src/components/library/PromptPicker.tsx, so the
// grouping, the reading view of a prompt, the virtual list and the paste
// rules are the same everywhere and easy to test.

import type { EntryArg, EntryKind, LibraryHit } from "./types";
import type { MyPrompt } from "./myPrompts";

/** Where the palette was opened: a session (insert there) or the task launcher (use as the task). */
export type PickerContext = "session" | "launcher";

export type PickerFilter = "all" | "mine" | "pinned" | "recent" | "task" | "persona" | "style";

/** The filter chips, in order; a null is the divider between "where from" and "what kind". */
export const FILTERS: readonly (PickerFilter | null)[] = ["all", "mine", "pinned", "recent", null, "task", "persona", "style"];

/** Rules are installed into a project, not inserted: they stay in the Library view. */
const KINDS_SESSION: EntryKind[] = ["prompt", "workflow", "persona", "style"];
/** A launch takes a task and a persona. */
const KINDS_LAUNCHER: EntryKind[] = ["prompt", "workflow", "persona"];

/** The library kinds a search asks for. */
export function kindsFor(filter: PickerFilter, context: PickerContext): EntryKind[] {
  const all = context === "launcher" ? KINDS_LAUNCHER : KINDS_SESSION;
  if (filter === "task") return ["prompt", "workflow"];
  if (filter === "persona") return ["persona"];
  if (filter === "style") return context === "launcher" ? [] : ["style"];
  return all;
}

/** The filters a context offers (the launcher has no answer styles). */
export function filtersFor(context: PickerContext): (PickerFilter | null)[] {
  return FILTERS.filter((f) => !(context === "launcher" && f === "style"));
}

/** A row's kind as people read it: everything that is not a persona or a style is a task. */
export function kindGroup(kind: EntryKind | MyPrompt["kind"]): "task" | "persona" | "style" {
  return kind === "persona" ? "persona" : kind === "style" ? "style" : "task";
}

export type GroupId = "pinned" | "recent" | "forYou" | "mine" | "library" | "task" | "persona" | "style";

export type PickerItem =
  | { type: "group"; key: string; group: GroupId; count?: number }
  | { type: "hit"; key: string; hit: LibraryHit; personal: boolean }
  | { type: "mine"; key: string; item: MyPrompt };

export type Pickable = Exclude<PickerItem, { type: "group" }>;

export const hitKey = (id: string) => `lib:${id}`;
export const mineKey = (id: string) => `mine:${id}`;

/** Every word of the query is in the item's title, description or folder. */
export function mineMatches(item: MyPrompt, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${item.title} ${item.description} ${item.folder ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

function mineFits(item: MyPrompt, filter: PickerFilter, context: PickerContext): boolean {
  if (context === "launcher" && item.kind === "style") return false;
  if (filter === "task" || filter === "persona" || filter === "style") return kindGroup(item.kind) === filter;
  return true;
}

function hitFits(hit: LibraryHit, filter: PickerFilter, context: PickerContext): boolean {
  return kindsFor(filter === "mine" || filter === "pinned" || filter === "recent" ? "all" : filter, context).includes(hit.kind);
}

export type RecentEntry = { hit: LibraryHit; at: number } | { mine: MyPrompt; at: number };

export interface BuildInput {
  query: string;
  filter: PickerFilter;
  context: PickerContext;
  mine: readonly MyPrompt[];
  /** Pinned library rows, in pin order. */
  pinnedHits: readonly LibraryHit[];
  /** Recently used rows of both kinds. */
  recent: readonly RecentEntry[];
  /** The search page(s): ranked For you with no query, by relevance with one. */
  hits: readonly LibraryHit[];
  /** Whether the hits are personalised (each row says why). */
  personal: boolean;
  /** How many recent rows to show above the rest. */
  recentLimit?: number;
}

/**
 * The list: with no query, Pinned, Recent, then For you (nothing twice);
 * with a query, Mine's matches, then the Library's. A filter narrows every
 * group; Mine, Pinned and Recent show only themselves.
 */
export function buildItems(input: BuildInput): PickerItem[] {
  const { filter, context, personal } = input;
  const q = input.query.trim();
  const out: PickerItem[] = [];
  const seen = new Set<string>();
  const group = (g: GroupId, rows: Pickable[], count?: number) => {
    const fresh = rows.filter((r) => !seen.has(r.key));
    if (fresh.length === 0) return;
    out.push({ type: "group", key: `group:${g}`, group: g, ...(count !== undefined ? { count } : {}) });
    for (const r of fresh) {
      seen.add(r.key);
      out.push(r);
    }
  };
  const asHit = (hit: LibraryHit, why = personal): Pickable => ({ type: "hit", key: hitKey(hit.id), hit, personal: why });
  const asMine = (item: MyPrompt): Pickable => ({ type: "mine", key: mineKey(item.id), item });
  const mineRows = input.mine.filter((m) => mineFits(m, filter, context) && mineMatches(m, q));
  const pinned: Pickable[] = [
    ...input.mine.filter((m) => m.pinned && mineFits(m, filter, context) && mineMatches(m, q)).map(asMine),
    ...input.pinnedHits.filter((h) => hitFits(h, filter, context) && hitMatches(h, q)).map((h) => asHit(h, false)),
  ];
  const recent: Pickable[] = [...input.recent]
    .sort((a, b) => b.at - a.at)
    .filter((r) => ("mine" in r ? mineFits(r.mine, filter, context) && mineMatches(r.mine, q) : hitFits(r.hit, filter, context) && hitMatches(r.hit, q)))
    .map((r) => ("mine" in r ? asMine(r.mine) : asHit(r.hit, false)));

  if (filter === "mine") {
    group("mine", mineRows.map(asMine), mineRows.length);
    return out;
  }
  if (filter === "pinned") {
    group("pinned", pinned);
    return out;
  }
  if (filter === "recent") {
    group("recent", recent);
    return out;
  }
  const lib = input.hits.filter((h) => hitFits(h, filter, context)).map((h) => asHit(h));
  if (!q) {
    group("pinned", pinned);
    group("recent", recent.slice(0, input.recentLimit ?? 5));
    group(filter === "all" ? "forYou" : filter, lib);
  } else {
    group("mine", mineRows.map(asMine));
    group("library", lib);
  }
  return out;
}

/** Pinned and recent rows come from the store, not the search: they are matched here. */
function hitMatches(hit: LibraryHit, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${hit.title} ${hit.description} ${hit.categoryLabel} ${hit.id}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const pickables = (items: readonly PickerItem[]): Pickable[] => items.filter((i): i is Pickable => i.type !== "group");

/** The next pickable key `step` rows away (stops at the ends; from nothing, the first). */
export function moveSelection(items: readonly PickerItem[], current: string | null, step: number): string | null {
  const rows = pickables(items);
  if (rows.length === 0) return null;
  const at = rows.findIndex((r) => r.key === current);
  if (at < 0) return rows[step < 0 ? rows.length - 1 : 0].key;
  return rows[Math.max(0, Math.min(rows.length - 1, at + step))].key;
}

// ── The virtual list (rows and group headers have different heights) ──

export interface Layout {
  offsets: number[];
  heights: number[];
  total: number;
}

export function layoutItems(items: readonly PickerItem[], rowHeight: number, groupHeight: number): Layout {
  const offsets: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (const it of items) {
    const h = it.type === "group" ? groupHeight : rowHeight;
    offsets.push(y);
    heights.push(h);
    y += h;
  }
  return { offsets, heights, total: y };
}

/** The items to put in the DOM for a viewport (start inclusive, end exclusive). */
export function visibleRange(layout: Layout, scrollTop: number, viewport: number, overscan = 6): { start: number; end: number } {
  const n = layout.offsets.length;
  if (n === 0) return { start: 0, end: 0 };
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.offsets[mid] <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  while (end < n && layout.offsets[end] < scrollTop + viewport) end++;
  return { start: Math.max(0, lo - overscan), end: Math.min(n, end + overscan) };
}

// ── Reading a prompt (never raw template tags) ─────────────────────────

/** Your filled-in words, and blanks still to fill, travel through the renderer wrapped in these (private-use characters no prompt contains). */
export const FILL_OPEN = "\uE000";
export const FILL_CLOSE = "\uE001";
export const BLANK_OPEN = "\uE002";
export const BLANK_CLOSE = "\uE003";

export type Inline = { t: "text" | "code" | "bold" | "filled"; v: string } | { t: "blank"; v: string };
export type Block = { kind: "p" | "h"; parts: Inline[] } | { kind: "ol" | "ul"; items: Inline[][] };
export interface Section {
  /** The tag the section came from ("context", "task", "output_format"…), or null for plain text. */
  tag: string | null;
  blocks: Block[];
}

/** Values to render a preview with: filled ones marked, required blanks as named slots. */
export function markedValues(values: Readonly<Record<string, string>>, blanks: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v.trim()) out[k] = `${FILL_OPEN}${v}${FILL_CLOSE}`;
  for (const k of blanks) if (!out[k]) out[k] = `${BLANK_OPEN}${k}${BLANK_CLOSE}`;
  return out;
}

/** Removes the markers (the text that is actually sent). */
export function unmark(text: string): string {
  return text.replace(/[\uE000\uE001]/g, "").replace(/\uE002(\w+)\uE003/g, "[$1]");
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\uE000([\s\S]*?)\uE001|\uE002(\w+)\uE003|`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "filled", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "blank", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "code", v: m[3] });
    else out.push({ t: "bold", v: m[4] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  let list: { kind: "ol" | "ul"; items: Inline[][] } | null = null;
  const close = () => {
    if (list) out.push(list);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (!line.trim()) {
      close();
    } else if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
      close();
      out.push({ kind: "h", parts: parseInline(m[1]) });
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (!list || list.kind !== "ol") {
        close();
        list = { kind: "ol", items: [] };
      }
      list.items.push(parseInline(m[1]));
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (!list || list.kind !== "ul") {
        close();
        list = { kind: "ul", items: [] };
      }
      list.items.push(parseInline(m[1]));
    } else {
      close();
      out.push({ kind: "p", parts: parseInline(line) });
    }
  }
  close();
  return out;
}

/** The text cut at its `<tag>…</tag>` blocks; anything outside a tag is a plain section. */
export function splitTags(text: string): { tag: string | null; body: string }[] {
  const out: { tag: string | null; body: string }[] = [];
  const re = /<([a-z][a-z0-9_-]*)>\s*([\s\S]*?)\s*<\/\1>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ tag: null, body: before });
    out.push({ tag: m[1].toLowerCase(), body: m[2] });
    last = re.lastIndex;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ tag: null, body: rest });
  // A stray tag that never closes is not shown as markup either.
  return out.map((s) => ({ ...s, body: s.body.replace(/<\/?[a-z][a-z0-9_-]*>/gi, "").trim() })).filter((s) => s.body);
}

export function readableSections(text: string): Section[] {
  return splitTags(text).map((s) => ({ tag: s.tag, blocks: parseBlocks(s.body) }));
}

/** "output_format" → "Output format". */
export function humanize(name: string): string {
  const s = name.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The text as a person edits it: each tag becomes a plain heading line. */
export function editableText(text: string, label: (tag: string) => string): string {
  return splitTags(text)
    .map((s) => (s.tag ? `${label(s.tag)}:\n${s.body}` : s.body))
    .join("\n\n");
}

// ── Putting it together ─────────────────────────────────────────────────

/** Persona, task and answer style as one text; persona and style in their own tags. */
export function composeText(parts: { persona?: string | null; body: string; style?: string | null }): string {
  const out: string[] = [];
  if (parts.persona?.trim()) out.push(`<role>\n${parts.persona.trim()}\n</role>`);
  if (parts.body.trim()) out.push(parts.body.trim());
  if (parts.style?.trim()) out.push(`<answer_style>\n${parts.style.trim()}\n</answer_style>`);
  return out.join("\n\n");
}

export interface PasteFold {
  chars: number;
  lines: number;
}

/** Whether `text` is long enough for the agent to fold it into a placeholder. */
export function foldsAsPaste(text: string, fold: PasteFold): boolean {
  return text.length > fold.chars || text.split("\n").length > fold.lines;
}

/**
 * Whether the text goes in with a typed lead line: an agent whose catalog
 * entry has `paste_fold` (Claude Code) follows the instructions inside a
 * folded paste only where the typed message asks it to
 * (code.claude.com/docs/en/terminal-config#paste-large-content). A shell or
 * any other agent gets the text alone.
 */
export function needsLeadLine(text: string, fold: PasteFold | null | undefined): boolean {
  return !!fold && foldsAsPaste(text, fold);
}

/** The first blank a selection or the launcher's text goes into: a required text field. */
export function prefillTarget(args: readonly EntryArg[], values: Readonly<Record<string, string>>): string | null {
  const a = args.find((x) => x.required && x.default === undefined && (!x.type || x.type === "text" || x.type === "string") && !(values[x.name] ?? "").trim());
  return a ? a.name : null;
}

/** The blanks a saved copy keeps: every `{{name}}` left in its text, described as the source described it. */
export function savedArgs(text: string, source: readonly EntryArg[]): EntryArg[] {
  const names = [...new Set([...text.matchAll(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g)].map((m) => m[1]))];
  return names.map((n) => source.find((a) => a.name === n) ?? { name: n, description: "", type: "text", required: true });
}
