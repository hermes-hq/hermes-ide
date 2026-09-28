// ─── Feature Tracks: the per-worktree store ───────────────────────────
//
// F28. Keeps what the watcher reports about each worktree's
// `.hermes/features/` folders, parsed with the contract reader, and derives
// from it:
//
//   - the ◆ inbox items: a phase waiting for review, a blocking open
//     question, an unreadable feature.md (raised through the contract's
//     inbox store, resolved when the file no longer says so);
//   - the guard on gates: `gate: approved` that Hermes did not write and
//     that landed during an agent's turn (the session's turn history,
//     contract C0) is reverted and reported as an error item;
//   - the baseline of a phase file: its text when the agent handed it over
//     (`gate: waiting`), so `r` can send the person's edits back as a diff.
//
// React reads it through `useTrack(worktreePath)` (useSyncExternalStore).
// The store never types into a terminal; TrackPanel does, on `r`.

import { useSyncExternalStore } from "react";
import { parseFeatureFrontMatter, type FeatureMeta } from "../agent/contract/featureFrontMatter";
import { getSessionEventSnapshot } from "../agent/contract/sessionEventStore";
import { listInboxItems, raiseInboxItem, resolveInboxItem } from "../agent/contract/inbox";
import type { TrackFeatureSnapshot, TrackFileInfo, TrackWorktreeSnapshot } from "./api";
import { attachedSessions, changeMadeDuringTurn, parseQuestions, PHASE_FILE, previousPhase, type AttachedSession, type Question } from "./rules";

export const TRACK_SOURCE = "track";
/** How long an approval Hermes wrote itself is expected to show up. */
export const OWN_WRITE_WINDOW_MS = 15_000;

export interface TrackFeatureState {
  readonly slug: string;
  readonly meta: FeatureMeta | null;
  /** feature.md can't be read (line n). */
  readonly error: { readonly message: string; readonly line: number } | null;
  readonly body: string;
  readonly featureText: string;
  readonly featureModifiedAt: number;
  readonly questions: readonly Question[];
  readonly files: readonly TrackFileInfo[];
  /** Phase file texts as the agent handed them over, by file name. */
  readonly baseline: Readonly<Record<string, string>>;
}

export interface TrackWorktreeState {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly features: readonly TrackFeatureState[];
  /** The feature this worktree is about: the branch's slug, or the only one. */
  readonly slug: string | null;
  readonly at: number;
  readonly version: number;
}

/** What the store needs from the app: the sessions and the backend. */
export interface TrackStoreDeps {
  sessions: () => readonly AttachedSession[];
  revertGate: (worktreePath: string, slug: string, phase: string) => Promise<void>;
  readFile: (worktreePath: string, slug: string, name: string) => Promise<string>;
  /** Every alert the guard raised, for people and for the tests. */
  onAlert?: (message: string) => void;
}

type Listener = () => void;

const states = new Map<string, TrackWorktreeState>();
const listeners = new Map<string, Set<Listener>>();
const emptyCache = new Map<string, TrackWorktreeState>();
/** inbox item id per (worktree, key), so items resolve when the cause goes. */
const raised = new Map<string, Map<string, string>>();
/** Approvals Hermes wrote itself, awaiting their echo from the watcher. */
const ownApprovals = new Map<string, number>();
/** Reverts in flight: the echo of our own revert must not re-trigger. */
const reverting = new Set<string>();
let deps: TrackStoreDeps = {
  sessions: () => [],
  revertGate: () => Promise.resolve(),
  readFile: () => Promise.resolve(""),
};
let clock: () => number = () => Date.now();

export function configureTrackStore(next: Partial<TrackStoreDeps>): void {
  deps = { ...deps, ...next };
}

function emptyState(worktreePath: string): TrackWorktreeState {
  return Object.freeze({ worktreePath, branch: null, features: Object.freeze([]), slug: null, at: 0, version: 0 });
}

export function getTrackState(worktreePath: string): TrackWorktreeState {
  const known = states.get(worktreePath);
  if (known) return known;
  let empty = emptyCache.get(worktreePath);
  if (!empty) {
    empty = emptyState(worktreePath);
    emptyCache.set(worktreePath, empty);
  }
  return empty;
}

export function subscribeTrack(worktreePath: string, listener: Listener): () => void {
  let set = listeners.get(worktreePath);
  if (!set) {
    set = new Set();
    listeners.set(worktreePath, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(worktreePath);
  };
}

function publish(next: TrackWorktreeState): void {
  states.set(next.worktreePath, next);
  emptyCache.delete(next.worktreePath);
  const set = listeners.get(next.worktreePath);
  if (set) for (const l of [...set]) l();
}

export function useTrack(worktreePath: string): TrackWorktreeState {
  return useSyncExternalStore(
    (listener) => subscribeTrack(worktreePath, listener),
    () => getTrackState(worktreePath),
    () => getTrackState(worktreePath),
  );
}

/** Pure: a feature snapshot parsed, keeping the previous baseline. */
export function parseFeatureSnapshot(snap: TrackFeatureSnapshot, prev: TrackFeatureState | undefined): TrackFeatureState {
  const parsed = parseFeatureFrontMatter(snap.featureText);
  return Object.freeze({
    slug: snap.slug,
    meta: parsed.ok ? parsed.meta : null,
    error: parsed.ok ? null : { message: parsed.error, line: parsed.line },
    body: parsed.ok ? parsed.body : "",
    featureText: snap.featureText,
    featureModifiedAt: snap.featureModifiedAt,
    questions: Object.freeze(snap.questionsText === null ? [] : parseQuestions(snap.questionsText)),
    files: snap.files,
    baseline: prev?.baseline ?? Object.freeze({}),
  });
}

/** The slug a worktree is about (branch first, then the only folder). */
export function slugFor(branch: string | null, features: readonly { slug: string }[]): string | null {
  const fromBranch = branch?.startsWith("hermes/") ? branch.slice("hermes/".length) : null;
  if (fromBranch && features.some((f) => f.slug === fromBranch)) return fromBranch;
  return features.length === 1 ? features[0].slug : null;
}

/** The current phase's file name, when the phase has one. */
export function phaseFileOf(meta: FeatureMeta | null): string | null {
  return meta ? (PHASE_FILE[meta.phase] ?? null) : null;
}

// ─── Inbox items ──────────────────────────────────────────────────────

/** Pure: the ◆ items a worktree's state asks for, keyed so they can be diffed. */
export function inboxItemsFor(state: TrackWorktreeState, writerSessionId: string | null): Map<string, { kind: "gate" | "error"; detail: string }> {
  const out = new Map<string, { kind: "gate" | "error"; detail: string }>();
  for (const f of state.features) {
    if (f.error) {
      out.set(`${f.slug}/error`, { kind: "error", detail: `${f.slug}: feature.md can't be read (line ${f.error.line})` });
      continue;
    }
    if (!f.meta) continue;
    if (f.meta.gate === "waiting") {
      out.set(`${f.slug}/gate/${f.meta.phase}`, { kind: "gate", detail: `${f.slug}: ${f.meta.phase} is ready for review` });
    }
    if (f.meta.phase !== "done") {
      for (const q of f.questions) {
        if (q.open && q.blocking) out.set(`${f.slug}/question/${q.line}`, { kind: "gate", detail: `${f.slug}: question — ${q.text}` });
      }
    }
  }
  void writerSessionId;
  return out;
}

function syncInbox(state: TrackWorktreeState, writerSessionId: string | null): void {
  const wanted = inboxItemsFor(state, writerSessionId);
  let mine = raised.get(state.worktreePath);
  if (!mine) {
    mine = new Map();
    raised.set(state.worktreePath, mine);
  }
  const open = new Set(listInboxItems().map((i) => i.id));
  for (const [key, id] of [...mine]) {
    if (!wanted.has(key) || !open.has(id)) {
      if (open.has(id)) resolveInboxItem(id);
      mine.delete(key);
    }
  }
  for (const [key, want] of wanted) {
    if (mine.has(key)) continue;
    const item = raiseInboxItem({ kind: want.kind, sessionId: writerSessionId, detail: want.detail, source: TRACK_SOURCE });
    mine.set(key, item.id);
  }
}

// ─── The gate guard ───────────────────────────────────────────────────

/** ⌘⏎ / the palette: Hermes is about to write this approval itself. */
export function noteOwnApproval(worktreePath: string, slug: string): void {
  ownApprovals.set(`${worktreePath}\u0000${slug}`, clock());
}

function consumeOwnApproval(worktreePath: string, slug: string): boolean {
  const key = `${worktreePath}\u0000${slug}`;
  const at = ownApprovals.get(key);
  if (at === undefined) return false;
  ownApprovals.delete(key);
  return clock() - at <= OWN_WRITE_WINDOW_MS;
}

/**
 * Pure: whether a feature just became `approved` without Hermes writing it
 * and while one of the attached sessions was in a turn. Returns that
 * session and the phase to go back to.
 */
export function detectAgentApproval(
  prev: TrackFeatureState | undefined,
  next: TrackFeatureState,
  attached: readonly string[],
  eventsOf: (sessionId: string) => { events: readonly import("../agent/contract/events").SessionEvent[]; turn: import("../agent/contract/sessionEventStore").SessionTurnState },
): { sessionId: string; phase: string } | null {
  if (!next.meta || next.meta.gate !== "approved") return null;
  if (prev?.meta && prev.meta.gate === "approved" && prev.meta.phase === next.meta.phase) return null;
  const back = prev?.meta && prev.meta.gate !== "approved" ? prev.meta.phase : previousPhase(next.meta.track, next.meta.phase);
  if (!back) return null;
  for (const sessionId of attached) {
    const snap = eventsOf(sessionId);
    if (changeMadeDuringTurn(snap.events, snap.turn, next.featureModifiedAt)) return { sessionId, phase: back };
  }
  return null;
}

function guardGates(prevState: TrackWorktreeState | undefined, next: TrackWorktreeState, attached: readonly string[]): void {
  for (const f of next.features) {
    const key = `${next.worktreePath}\u0000${f.slug}`;
    if (!f.meta || f.meta.gate !== "approved") {
      reverting.delete(key);
      continue;
    }
    if (reverting.has(key)) continue;
    const prev = prevState?.features.find((p) => p.slug === f.slug);
    if (prev?.meta?.gate === "approved" && prev.meta.phase === f.meta.phase) continue;
    if (consumeOwnApproval(next.worktreePath, f.slug)) continue;
    const hit = detectAgentApproval(prev, f, attached, (id) => getSessionEventSnapshot(id));
    if (!hit) continue;
    reverting.add(key);
    const message = `${f.slug}: the agent approved its own gate during its turn; reverted to waiting`;
    raiseInboxItem({ kind: "error", sessionId: hit.sessionId, detail: message, source: TRACK_SOURCE });
    deps.onAlert?.(message);
    void deps.revertGate(next.worktreePath, f.slug, hit.phase).catch((e) => {
      reverting.delete(key);
      console.error("[track] revert failed:", e);
    });
  }
}

// ─── Baselines ────────────────────────────────────────────────────────

function captureBaselines(prevState: TrackWorktreeState | undefined, next: TrackWorktreeState): void {
  for (const f of next.features) {
    if (!f.meta || f.meta.gate !== "waiting") continue;
    const name = phaseFileOf(f.meta);
    if (!name || !f.files.some((x) => x.name === name)) continue;
    const prev = prevState?.features.find((p) => p.slug === f.slug);
    const wasWaiting = prev?.meta?.gate === "waiting" && prev.meta.phase === f.meta.phase;
    if (wasWaiting && f.baseline[name] !== undefined) continue;
    const slug = f.slug;
    const version = next.version;
    void deps
      .readFile(next.worktreePath, slug, name)
      .then((text) => setBaseline(next.worktreePath, slug, name, text, version))
      .catch(() => {});
  }
}

function setBaseline(worktreePath: string, slug: string, name: string, text: string, sinceVersion: number): void {
  const cur = states.get(worktreePath);
  if (!cur) return;
  // A later hand-over of the same file replaces it; a stale read never does.
  const f = cur.features.find((x) => x.slug === slug);
  if (!f || (cur.version !== sinceVersion && f.baseline[name] !== undefined)) return;
  publish(
    Object.freeze({
      ...cur,
      features: Object.freeze(
        cur.features.map((x) => (x.slug === slug ? Object.freeze({ ...x, baseline: Object.freeze({ ...x.baseline, [name]: text }) }) : x)),
      ),
    }),
  );
}

// ─── Applying a snapshot ──────────────────────────────────────────────

/** Fold one watcher report into the store and run the derivations. */
export function applyTrackSnapshot(snap: TrackWorktreeSnapshot): TrackWorktreeState {
  const prev = states.get(snap.worktreePath);
  const features = snap.features.map((f) => parseFeatureSnapshot(f, prev?.features.find((p) => p.slug === f.slug)));
  const next: TrackWorktreeState = Object.freeze({
    worktreePath: snap.worktreePath,
    branch: snap.branch,
    features: Object.freeze(features),
    slug: slugFor(snap.branch, features),
    at: snap.at,
    version: (prev?.version ?? 0) + 1,
  });
  publish(next);
  const attached = attachedSessions(deps.sessions(), snap.worktreePath).map((s) => s.id);
  guardGates(prev, next, attached);
  syncInbox(next, attached[0] ?? null);
  captureBaselines(prev, next);
  return next;
}

/** A worktree nobody watches any more: its items go too. */
export function forgetTrack(worktreePath: string): void {
  const mine = raised.get(worktreePath);
  if (mine) for (const id of mine.values()) resolveInboxItem(id);
  raised.delete(worktreePath);
  states.delete(worktreePath);
  emptyCache.delete(worktreePath);
  const set = listeners.get(worktreePath);
  if (set) for (const l of [...set]) l();
}

export function trackWorktreePaths(): string[] {
  return [...states.keys()];
}

export function _resetTrackStoreForTest(now?: () => number): void {
  states.clear();
  listeners.clear();
  emptyCache.clear();
  raised.clear();
  ownApprovals.clear();
  reverting.clear();
  clock = now ?? (() => Date.now());
  deps = { sessions: () => [], revertGate: () => Promise.resolve(), readFile: () => Promise.resolve("") };
}
