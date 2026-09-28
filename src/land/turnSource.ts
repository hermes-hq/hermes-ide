// ─── Turns for the Land sheet ─────────────────────────────────────────
//
// The turn ledger (contract C0, filled by F20) says what each agent turn
// changed. The Land sheet counts the turns and lists them in the drafted
// commit message and pull request body.
//
// Real-app scenarios put a session into any state without a real agent
// (docs/adr/004): `setFakeLandTurnsForTest` is called only by the e2e hooks
// (src/e2e/hooks.ts, test builds) and stands in for the ledger's answer.

import { getTurnDiff, listTurns, type Turn } from "../agent/contract/turns";

export interface LandTurn {
  readonly turn: Turn;
  /** Files the turn changed, from its diff. */
  readonly files: readonly string[];
}

interface FakeTurn {
  readonly turn: Turn;
  readonly patch: string;
}

const fakeTurns = new Map<string, readonly FakeTurn[]>();

export function setFakeLandTurnsForTest(sessionId: string, turns: readonly FakeTurn[]): void {
  fakeTurns.set(sessionId, turns);
}

/** Paths a unified diff touches, in order, once each. */
export function filesInPatch(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!m) continue;
    const path = m[2];
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** The session's turns, oldest first; [] when the ledger has none. */
export async function loadLandTurns(sessionId: string): Promise<LandTurn[]> {
  const fake = fakeTurns.get(sessionId);
  if (fake) return fake.map((f) => ({ turn: f.turn, files: filesInPatch(f.patch) }));
  let turns: Turn[] = [];
  try {
    turns = await listTurns(sessionId);
  } catch {
    return [];
  }
  const sorted = [...turns].sort((a, b) => a.n - b.n);
  return Promise.all(
    sorted.map(async (turn) => {
      const diff = await getTurnDiff(sessionId, turn.n).catch(() => null);
      return { turn, files: filesInPatch(diff?.patch ?? "") };
    }),
  );
}
