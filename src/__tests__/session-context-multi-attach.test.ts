/**
 * Multi-folder attach/detach end-to-end shape, exercised at the
 * SessionContext reducer + drift-detection seam.
 *
 * The original "Claude doesn't see my attached folders" bug surfaced as
 * a chain of three failures:
 *   1. Auto-attach wrote `session_realms` only — workspace_paths stayed []
 *      (covered by T1 / autoAttach helper).
 *   2. The drift check between `session.workspace_paths` and the
 *      `claudeAddDirs` snapshot was index-sensitive — order tweaks
 *      caused spurious respawns and corrupt `priorUuid` state
 *      (covered by T4 / hasAddDirDrift).
 *   3. The reducer's SESSION_UPDATED dedup didn't compare workspace_paths
 *      at all, so workspace_paths updates were silently dropped if every
 *      other field happened to match — re-attach toggles vanished.
 *      (now also pinned set-wise; this test covers it.)
 *
 * This test simulates the realistic event sequence: a session is created,
 * a `session-workspace-paths-updated` lands with [A], then [A,B], then
 * back to [B], then []. The React state mirrors the union; the drift
 * detector flips at each step that actually changes the SET, not at
 * every dispatch.
 */
import { describe, it, expect } from "vitest";
import { hasAddDirDrift } from "../utils/agentDrift";

type Session = {
  id: string;
  mode: "agent" | "terminal";
  workspace_paths: string[];
  // (Other fields irrelevant to this test — the reducer dedup at the
  // call site checks ~12 fields, but the tests below only exercise
  // workspace_paths-driven dedup.)
};

/**
 * Replica of the SESSION_UPDATED dedup branch in
 * `SessionContext.tsx::sessionReducer`.  The post-fix shape uses
 * set-equality on workspace_paths so an upstream reorder doesn't fool
 * the dedup into pretending nothing changed.  Every other field is
 * compared by reference equality for brevity in this test; the real
 * reducer compares ~12 specific fields.
 */
function sessionUpdatedDedup(prev: Session, next: Session): Session {
  if (
    prev.id === next.id
    && prev.mode === next.mode
    && !hasAddDirDrift(prev.workspace_paths, next.workspace_paths)
  ) {
    return prev;
  }
  return { ...prev, ...next, workspace_paths: [...next.workspace_paths] };
}

/**
 * Replica of `submitAgentMessage`'s drift trigger.  Returns the new
 * snapshot the caller should write back AFTER respawning, plus a flag
 * indicating whether a respawn is needed.
 */
function shouldRespawn(
  session: Session,
  priorAddDirs: string[],
): { respawn: boolean; nextSnapshot: string[] } {
  if (session.mode !== "agent") {
    return { respawn: false, nextSnapshot: priorAddDirs };
  }
  const respawn = hasAddDirDrift(priorAddDirs, session.workspace_paths);
  return { respawn, nextSnapshot: respawn ? [...session.workspace_paths] : priorAddDirs };
}

describe("SessionContext multi-folder attach/detach progression", () => {
  it("attach progression [] → [A] → [A,B] → [A,B,C] respawns once per real change", () => {
    let session: Session = { id: "sess", mode: "agent", workspace_paths: [] };
    let snapshot: string[] = [];
    const respawnLog: string[][] = [];

    const advance = (workspace_paths: string[]) => {
      session = sessionUpdatedDedup(session, { ...session, workspace_paths });
      const r = shouldRespawn(session, snapshot);
      if (r.respawn) {
        respawnLog.push([...session.workspace_paths]);
        snapshot = r.nextSnapshot;
      }
    };

    advance(["/A"]);
    advance(["/A", "/B"]);
    advance(["/A", "/B", "/C"]);

    expect(respawnLog).toEqual([
      ["/A"],
      ["/A", "/B"],
      ["/A", "/B", "/C"],
    ]);
    expect(snapshot).toEqual(["/A", "/B", "/C"]);
  });

  it("detach progression [A,B] → [A] → [] respawns once per real change", () => {
    let session: Session = { id: "sess", mode: "agent", workspace_paths: ["/A", "/B"] };
    let snapshot: string[] = ["/A", "/B"];
    const respawnLog: string[][] = [];

    const advance = (workspace_paths: string[]) => {
      session = sessionUpdatedDedup(session, { ...session, workspace_paths });
      const r = shouldRespawn(session, snapshot);
      if (r.respawn) {
        respawnLog.push([...session.workspace_paths]);
        snapshot = r.nextSnapshot;
      }
    };

    advance(["/A"]);
    advance([]);

    expect(respawnLog).toEqual([["/A"], []]);
  });

  it("re-attach in different order is dedup'd in the reducer AND skipped by drift", () => {
    let session: Session = { id: "sess", mode: "agent", workspace_paths: ["/A", "/B"] };
    let snapshot: string[] = ["/A", "/B"];
    const respawnLog: string[][] = [];

    // Pretend the backend re-emits with the same set in different order
    // (could happen if the user toggles attach off+on, or a future DB
    // dedup pass re-sorts paths).  The reducer should keep the prior
    // reference (no React re-render churn) and the drift check should
    // not fire a respawn.
    const beforeRef = session;
    session = sessionUpdatedDedup(session, { ...session, workspace_paths: ["/B", "/A"] });
    expect(session).toBe(beforeRef);

    const r = shouldRespawn(session, snapshot);
    if (r.respawn) {
      respawnLog.push([...session.workspace_paths]);
      snapshot = r.nextSnapshot;
    }
    expect(respawnLog).toEqual([]);
  });

  it("attach toggle that mutates the workspace_paths reference but keeps the SET is a no-op", () => {
    // Defensive against an upstream optimization that produces a new
    // array reference for an unchanged set: the reducer must NOT update
    // state, and the drift check must NOT respawn.
    const initial: Session = { id: "sess", mode: "agent", workspace_paths: ["/A", "/B"] };
    const reordered: Session = { ...initial, workspace_paths: ["/B", "/A"] };

    const result = sessionUpdatedDedup(initial, reordered);
    expect(result).toBe(initial);
    expect(hasAddDirDrift(initial.workspace_paths, reordered.workspace_paths)).toBe(false);
  });

  it("mode=terminal: drift never triggers an agent respawn (regression guard)", () => {
    const session: Session = { id: "term", mode: "terminal", workspace_paths: ["/A", "/B"] };
    const r = shouldRespawn(session, []);
    expect(r.respawn).toBe(false);
  });

  it("rapid attach storm — N changes produce N respawns, no churn beyond that", () => {
    let session: Session = { id: "sess", mode: "agent", workspace_paths: [] };
    let snapshot: string[] = [];
    let respawns = 0;

    const advance = (workspace_paths: string[]) => {
      session = sessionUpdatedDedup(session, { ...session, workspace_paths });
      const r = shouldRespawn(session, snapshot);
      if (r.respawn) {
        respawns++;
        snapshot = r.nextSnapshot;
      }
    };

    // 5 real changes interleaved with 3 reorder-only emits.
    advance(["/A"]);
    advance(["/A", "/B"]);
    advance(["/B", "/A"]);          // reorder only — should not respawn
    advance(["/A", "/B", "/C"]);
    advance(["/C", "/B", "/A"]);    // reorder only — should not respawn
    advance(["/A", "/C"]);          // /B removed — real change
    advance(["/C", "/A"]);          // reorder only — should not respawn
    advance([]);

    expect(respawns).toBe(5);
    expect(snapshot).toEqual([]);
  });
});
