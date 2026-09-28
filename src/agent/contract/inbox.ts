// ─── Attention inbox seam ────────────────────────────────────────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). One list of things waiting
// on a person, whatever raised them: a blocked agent (F12), a gate in a
// feature track (F28), a failed worktree setup (F26), a spend cap (F31), a
// plugin (F36). No UI here: F12 renders it and owns the keyboard.
//
// Items are kept oldest first, which is the order ⌘I visits them. Raising
// the same (kind, sessionId, detail) again while it is open returns the
// open item instead of a duplicate. Resolving is by id.

import { useSyncExternalStore } from "react";

export const INBOX_KINDS = ["blocked", "ready", "gate", "error", "limit"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxItem {
  readonly id: string;
  readonly kind: InboxKind;
  /** The session to jump to; null for items about the workspace. */
  readonly sessionId: string | null;
  /** One line for people: the command awaiting approval, the gate name. */
  readonly detail: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Who raised it: "status", "track", "worktree", "cap", "plugin:<id>", "e2e". */
  readonly source: string;
}

/** What a caller passes to raise(); id and createdAt are assigned here. */
export interface InboxRaise {
  readonly kind: InboxKind;
  readonly sessionId?: string | null;
  readonly detail: string;
  readonly source: string;
}

/** The shape a plugin passes to `inbox.raise()` (F36); the source is the
 *  plugin's id, set by the host, never by the plugin. */
export interface PluginInboxRaise {
  readonly kind: InboxKind;
  readonly sessionId?: string | null;
  readonly detail: string;
}

export function isInboxKind(value: unknown): value is InboxKind {
  return typeof value === "string" && (INBOX_KINDS as readonly string[]).includes(value);
}

type Listener = () => void;

let items: readonly InboxItem[] = Object.freeze([]);
const listeners = new Set<Listener>();
let nextId = 1;
let clock: () => number = () => Date.now();

function publish(next: readonly InboxItem[]): void {
  items = Object.freeze(next);
  for (const l of [...listeners]) l();
}

/** Add an item, or return the open item that says the same thing. */
export function raiseInboxItem(input: InboxRaise): InboxItem {
  if (!isInboxKind(input.kind)) throw new Error(`unknown inbox kind: ${String(input.kind)}`);
  const sessionId = input.sessionId ?? null;
  const open = items.find((i) => i.kind === input.kind && i.sessionId === sessionId && i.detail === input.detail);
  if (open) return open;
  const item: InboxItem = Object.freeze({
    id: `inbox-${nextId++}`,
    kind: input.kind,
    sessionId,
    detail: input.detail,
    createdAt: clock(),
    source: input.source,
  });
  publish([...items, item]);
  return item;
}

/** raise() as a plugin sees it: the host stamps the source. */
export function raiseInboxItemFromPlugin(pluginId: string, input: PluginInboxRaise): InboxItem {
  return raiseInboxItem({ ...input, source: `plugin:${pluginId}` });
}

/** Remove an item. False when it was not open (already resolved). */
export function resolveInboxItem(id: string): boolean {
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return false;
  publish(next);
  return true;
}

/** Remove every item about a session (it closed). Returns how many. */
export function resolveInboxItemsForSession(sessionId: string): number {
  const next = items.filter((i) => i.sessionId !== sessionId);
  const n = items.length - next.length;
  if (n > 0) publish(next);
  return n;
}

/** Open items, oldest first. The array is frozen and stable between changes. */
export function listInboxItems(): readonly InboxItem[] {
  return items;
}

export function subscribeInbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInboxItems(): readonly InboxItem[] {
  return useSyncExternalStore(subscribeInbox, listInboxItems, listInboxItems);
}

export function _resetInboxForTest(now?: () => number): void {
  items = Object.freeze([]);
  listeners.clear();
  nextId = 1;
  clock = now ?? (() => Date.now());
}
