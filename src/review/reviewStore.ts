// ─── Per-repository review state ──────────────────────────────────────
//
// What the person did in the desk for one repository: which files are
// viewed, the comments, the review counter, which review each comment went
// out in, and each send's outcome. Viewed marks, comments, the counter and
// the sent marks are kept per repository path in localStorage so they
// survive closing the desk and restarting; delivery states are per run.

import { useSyncExternalStore } from "react";
import type { ReviewComment } from "./reviewModel";
import type { DeliveryState } from "./sendBack";

export interface ReviewState {
  readonly viewed: readonly string[];
  readonly comments: readonly ReviewComment[];
  /** The last review number handed out; the next send uses `nextN + 1`. */
  readonly lastN: number;
  /** The review number each sent comment went out in, by comment id. */
  readonly sent: Readonly<Record<string, number>>;
  /** Delivery per review number. */
  readonly deliveries: Readonly<Record<number, DeliveryState & { readonly sessionId: string; readonly filePath: string | null }>>;
  readonly version: number;
}

const EMPTY: ReviewState = Object.freeze({ viewed: [], comments: [], lastN: 0, sent: {}, deliveries: {}, version: 0 });

const states = new Map<string, ReviewState>();
const listeners = new Map<string, Set<() => void>>();

const storageKey = (repoPath: string) => `hermes.review.${repoPath}`;

function load(repoPath: string): ReviewState {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(repoPath));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<ReviewState>;
    return Object.freeze({
      viewed: Array.isArray(parsed.viewed) ? parsed.viewed.filter((v): v is string => typeof v === "string") : [],
      comments: Array.isArray(parsed.comments) ? (parsed.comments as ReviewComment[]) : [],
      lastN: typeof parsed.lastN === "number" && Number.isInteger(parsed.lastN) && parsed.lastN >= 0 ? parsed.lastN : 0,
      sent: sentMarks(parsed.sent),
      deliveries: {},
      version: 0,
    });
  } catch {
    return EMPTY;
  }
}

function sentMarks(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [id, n] of Object.entries(value as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isInteger(n) && n > 0) out[id] = n;
  }
  return out;
}

function persist(repoPath: string, state: ReviewState): void {
  try {
    globalThis.localStorage?.setItem(
      storageKey(repoPath),
      JSON.stringify({ viewed: state.viewed, comments: state.comments, lastN: state.lastN, sent: state.sent }),
    );
  } catch {
    // Storage may be unavailable; the desk still works for this run.
  }
}

export function getReviewState(repoPath: string): ReviewState {
  let s = states.get(repoPath);
  if (!s) {
    s = load(repoPath);
    states.set(repoPath, s);
  }
  return s;
}

function update(repoPath: string, next: Omit<ReviewState, "version">): ReviewState {
  const prev = getReviewState(repoPath);
  const frozen = Object.freeze({ ...next, version: prev.version + 1 });
  states.set(repoPath, frozen);
  persist(repoPath, frozen);
  const set = listeners.get(repoPath);
  if (set) for (const l of [...set]) l();
  return frozen;
}

export function subscribeReviewState(repoPath: string, listener: () => void): () => void {
  let set = listeners.get(repoPath);
  if (!set) {
    set = new Set();
    listeners.set(repoPath, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(repoPath);
  };
}

export function useReviewState(repoPath: string): ReviewState {
  return useSyncExternalStore(
    (l) => subscribeReviewState(repoPath, l),
    () => getReviewState(repoPath),
    () => getReviewState(repoPath),
  );
}

export function setViewed(repoPath: string, path: string, viewed: boolean): void {
  const s = getReviewState(repoPath);
  const has = s.viewed.includes(path);
  if (has === viewed) return;
  update(repoPath, { ...s, viewed: viewed ? [...s.viewed, path] : s.viewed.filter((p) => p !== path) });
}

let idCounter = 0;
export function addComment(repoPath: string, comment: Omit<ReviewComment, "id" | "createdAt">): ReviewComment {
  const s = getReviewState(repoPath);
  const full: ReviewComment = { ...comment, id: `c-${Date.now().toString(36)}-${(idCounter++).toString(36)}`, createdAt: Date.now() };
  update(repoPath, { ...s, comments: [...s.comments, full] });
  return full;
}

export function removeComment(repoPath: string, id: string): void {
  const s = getReviewState(repoPath);
  if (!s.comments.some((c) => c.id === id)) return;
  update(repoPath, { ...s, comments: s.comments.filter((c) => c.id !== id) });
}

/** Hands out the next review number and records it. */
export function nextReviewNumber(repoPath: string): number {
  const s = getReviewState(repoPath);
  const n = s.lastN + 1;
  update(repoPath, { ...s, lastN: n });
  return n;
}

export function setDelivery(repoPath: string, n: number, sessionId: string, state: DeliveryState, filePath: string | null): void {
  const s = getReviewState(repoPath);
  update(repoPath, { ...s, deliveries: { ...s.deliveries, [n]: { ...state, sessionId, filePath } } });
}

/** Comments that were sent are marked by the review number they went in; the mark persists. */
export function markSent(repoPath: string, commentIds: readonly string[], n: number): void {
  const s = getReviewState(repoPath);
  const sent = { ...s.sent };
  for (const id of commentIds) sent[id] = n;
  update(repoPath, { ...s, sent });
}
export function sentReviewOf(repoPath: string, commentId: string): number | null {
  return getReviewState(repoPath).sent[commentId] ?? null;
}

export function _resetReviewStoreForTest(): void {
  states.clear();
  listeners.clear();
}
