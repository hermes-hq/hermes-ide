// ─── Session actions: the Commands list ───────────────────────────────
//
// Pure: which commands the list shows, in which section. Each command
// appears once, in the first section it belongs to:
//
//   Pinned         the pinned actions this agent has (the bar's chips)
//   Recent         commands the person sent (newest first), at most 5
//   Your commands  the person's own command and skill files
//   Built-in       the agent's other commands
//   Session        destructive ones, last, in the danger ink: they ask first
//
// A filter keeps the commands whose words match (text, label, description,
// aliases), in the same sections.

import { ACTION_IDS, type SessionActionId, type SessionCommand } from "./catalog";

export type SectionId = "pinned" | "recent" | "yours" | "builtin" | "session";

export interface Section {
  id: SectionId;
  items: SessionCommand[];
}

export const RECENT_SHOWN = 5;

export interface SectionInputs {
  builtin: readonly SessionCommand[];
  /** The person's own (discovered) commands. */
  yours: readonly SessionCommand[];
  /** More of the agent's commands it reported itself (the Agent view's live list). */
  live?: readonly SessionCommand[];
  pinned: readonly SessionActionId[];
  /** Command texts the person sent, newest first. */
  recent: readonly string[];
  filter: string;
  /** The label and description people read (translated), for the filter. */
  words: (cmd: SessionCommand) => string;
}

function matches(cmd: SessionCommand, q: string, words: (c: SessionCommand) => string): boolean {
  if (!q) return true;
  const hay = `${cmd.text} ${cmd.aliases.join(" ")} ${words(cmd)}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

export function buildSections(i: SectionInputs): Section[] {
  const shown = new Set<string>();
  const take = (cmd: SessionCommand): boolean => {
    if (shown.has(cmd.text)) return false;
    shown.add(cmd.text);
    return true;
  };
  // The agent's commands first, then the live list's extra ones; the
  // person's own files never replace a built-in of the same name.
  const builtinTexts = new Set(i.builtin.map((c) => c.text));
  const live = (i.live ?? []).filter((c) => !builtinTexts.has(c.text));
  const yours = i.yours.filter((c) => !builtinTexts.has(c.text));
  const all = [...i.builtin, ...live, ...yours];
  const byText = new Map(all.map((c) => [c.text, c]));
  const q = i.filter.trim();
  const keep = (c: SessionCommand) => matches(c, q, i.words);

  const pinnedSet = new Set(i.pinned);
  const pinned = ACTION_IDS.filter((a) => pinnedSet.has(a))
    .map((a) => i.builtin.find((c) => c.action === a && !c.destructive))
    .filter((c): c is SessionCommand => !!c && keep(c) && take(c));

  const recent = i.recent
    .map((t) => byText.get(t))
    .filter((c): c is SessionCommand => !!c && !c.destructive && keep(c) && !shown.has(c.text))
    .slice(0, RECENT_SHOWN)
    .filter(take);

  const yoursShown = yours.filter((c) => !c.destructive && keep(c) && take(c));
  const builtin = [...i.builtin, ...live].filter((c) => !c.destructive && keep(c) && take(c));
  const session = i.builtin.filter((c) => c.destructive && keep(c) && take(c));

  const sections: Section[] = [
    { id: "pinned", items: pinned },
    { id: "recent", items: recent },
    { id: "yours", items: yoursShown },
    { id: "builtin", items: builtin },
    { id: "session", items: session },
  ];
  return sections.filter((s) => s.items.length > 0);
}

/** Every command the list can show (for the "/ N" count). */
export function commandCount(builtin: readonly SessionCommand[], yours: readonly SessionCommand[], live: readonly SessionCommand[] = []): number {
  const texts = new Set([...builtin, ...live, ...yours].map((c) => c.text));
  return texts.size;
}
