// ─── Collision Radar: live state (F37) ────────────────────────────────
//
// Keeps, per session, the files its latest turns touched (read from the
// turn ledger through the C0 seam, `listTurns` / `getTurnDiff`) and the
// overlaps between sessions that follow from them. useFleetControls asks
// for a refresh whenever a session ends a turn.
//
// The ledger is F20's. A turn may carry the paths it changed (`paths`,
// an optional field added for this); otherwise they are read from its diff.
// An ended turn never changes, so its files are cached.

import { useSyncExternalStore } from "react";
import { getTurnDiff, listTurns, type Turn, type TurnDiff } from "../agent/contract/turns";
import { computeOverlaps, filesInPatch, RADAR_TURN_WINDOW, type SessionOverlap } from "./radar";

export interface TurnSource {
  listTurns(sessionId: string): Promise<readonly Turn[]>;
  getTurnDiff(sessionId: string, n: number): Promise<TurnDiff | null>;
}

const LEDGER: TurnSource = { listTurns, getTurnDiff };
let source: TurnSource = LEDGER;

/** Test builds only: answer from a fake ledger (null goes back to the real one). */
export function setTurnSourceForTest(next: TurnSource | null): void {
  source = next ?? LEDGER;
  diffCache.clear();
}

type Listener = () => void;

const filesBySession = new Map<string, ReadonlySet<string>>();
const diffCache = new Map<string, readonly string[]>();
const generation = new Map<string, number>();
let liveSessions: ReadonlySet<string> = new Set();
let repoKeysOf: (sessionId: string) => readonly string[] = () => [];
let overlaps: ReadonlyMap<string, SessionOverlap> = new Map();
const listeners = new Set<Listener>();

function recompute(): void {
  const entries = [...filesBySession]
    .filter(([id, files]) => liveSessions.has(id) && files.size > 0)
    .map(([sessionId, files]) => ({ sessionId, files, repoKeys: repoKeysOf(sessionId) }));
  overlaps = computeOverlaps(entries);
  for (const l of [...listeners]) l();
}

/** The sessions that exist and where each one works; stale entries drop out. */
export function setRadarSessions(ids: readonly string[], repoKeys: (sessionId: string) => readonly string[]): void {
  liveSessions = new Set(ids);
  repoKeysOf = repoKeys;
  for (const id of [...filesBySession.keys()]) if (!liveSessions.has(id)) filesBySession.delete(id);
  recompute();
}

async function filesOfTurn(sessionId: string, turn: Turn): Promise<readonly string[]> {
  const paths = turn.paths;
  if (Array.isArray(paths)) return paths.filter((p): p is string => typeof p === "string");
  const key = `${sessionId}#${turn.n}`;
  const cached = diffCache.get(key);
  if (cached) return cached;
  const diff = await source.getTurnDiff(sessionId, turn.n);
  const files = diff ? filesInPatch(diff.patch) : [];
  if (turn.endedAt !== null) diffCache.set(key, files);
  return files;
}

/** Re-read a session's latest turns from the ledger. Never rejects. */
export async function refreshSessionTurnFiles(sessionId: string): Promise<void> {
  const gen = (generation.get(sessionId) ?? 0) + 1;
  generation.set(sessionId, gen);
  try {
    const turns = await source.listTurns(sessionId);
    const latest = (Array.isArray(turns) ? [...turns] : []).sort((a, b) => b.n - a.n).slice(0, RADAR_TURN_WINDOW);
    const files = new Set<string>();
    for (const turn of latest) for (const f of await filesOfTurn(sessionId, turn)) files.add(f);
    if (generation.get(sessionId) !== gen) return; // a newer refresh won
    filesBySession.set(sessionId, files);
    recompute();
  } catch (err) {
    console.warn("[radar] could not read the turns of", sessionId, err);
  }
}

export function getSessionOverlap(sessionId: string): SessionOverlap | null {
  return overlaps.get(sessionId) ?? null;
}

export function getAllOverlaps(): ReadonlyMap<string, SessionOverlap> {
  return overlaps;
}

export function subscribeRadar(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Who else touched this session's latest files, or null. */
export function useSessionOverlap(sessionId: string): SessionOverlap | null {
  return useSyncExternalStore(
    subscribeRadar,
    () => getSessionOverlap(sessionId),
    () => getSessionOverlap(sessionId),
  );
}

export function _resetRadarForTest(): void {
  source = LEDGER;
  filesBySession.clear();
  diffCache.clear();
  generation.clear();
  liveSessions = new Set();
  repoKeysOf = () => [];
  overlaps = new Map();
  listeners.clear();
}
