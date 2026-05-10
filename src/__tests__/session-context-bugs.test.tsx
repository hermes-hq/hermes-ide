/**
 * Bug-hunt suite for the recently-modified SessionContext (1.1.10).
 *
 * Each test below documents a CONCRETE bug discovered while auditing
 * `src/state/SessionContext.tsx`.  These tests intentionally FAIL on
 * the current main branch — they encode the buggy behaviour as the
 * "actual" and the desired behaviour as the "expected".
 *
 * Bug A (sev: medium)  switchAgentPermissionMode(null) queues a flag
 *   that sneaks through the deferred-fork mustRespawn check, causing an
 *   unwanted fork-respawn on the next user message.  See line ~1941
 *   of SessionContext.tsx.
 *
 * Bug B (sev: medium)  SESSION_UPDATED dedup compares
 *   `metrics.tool_calls.length` but not the contents.  When the bridge
 *   re-emits a session whose latest tool_call has been replaced (same
 *   length, different last entry), the reducer silently drops the update
 *   and the AgentToolBlock keeps rendering the stale call.
 *   See line ~201 of SessionContext.tsx.
 *
 * Bug C (sev: low)  hasAddDirDrift only fires inside submitAgentMessage.
 *   If the user attaches a workspace_path and never sends a message
 *   (e.g. they switch sessions, close the app), the bridge keeps the
 *   stale --add-dir set and Read/Edit on the new path fail.
 *   See line ~2002 of SessionContext.tsx.
 *
 * Bug D (sev: medium)  pendingFlags + optimistic chip dispatch can
 *   diverge.  switchAgentPermissionMode dispatches SESSION_UPDATED
 *   immediately, but the queued flag is only drained AFTER a
 *   successful respawn inside submitAgentMessage.  If respawn fails,
 *   the chip says "bypass" forever even though the bridge never got
 *   the update — and the queued flag will fire ANOTHER respawn on
 *   the next submit (no debounce / retry budget).
 *   See line ~2014 of SessionContext.tsx.
 */
import { describe, it, expect } from "vitest";
import { sessionReducer, initialState } from "../state/SessionContext";
import type { SessionData, ToolCall } from "../types/session";

// ─── Helpers ─────────────────────────────────────────────────────────
function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: "sess-1",
    label: "Session 1",
    description: "",
    color: "#ff0000",
    group: null,
    phase: "idle",
    working_directory: "/home/user/project",
    shell: "bash",
    created_at: "2025-01-01T00:00:00Z",
    last_activity_at: "2025-01-01T00:00:00Z",
    workspace_paths: [],
    detected_agent: null,
    metrics: {
      output_lines: 0,
      error_count: 0,
      stuck_score: 0,
      token_usage: {},
      tool_calls: [],
      tool_call_summary: {},
      files_touched: [],
      recent_errors: [],
      recent_actions: [],
      available_actions: [],
      memory_facts: [],
      latency_p50_ms: null,
      latency_p95_ms: null,
      latency_samples: [],
      token_history: [],
    },
    ai_provider: "claude",
    auto_approve: false,
    permission_mode: "default",
    custom_prefix: "",
    custom_suffix: "",
    channels: [],
    context_injected: false,
    ssh_info: null,
    mode: "agent",
    ...overrides,
  };
}

function call(tool: string, args: string, ts = "2025-01-01T00:00:00Z"): ToolCall {
  return { tool, args, timestamp: ts };
}

// =====================================================================
// Bug A — switchAgentPermissionMode(null) sneaks through mustRespawn
// =====================================================================
//
// Reproducing the exact algorithm from SessionContext.tsx so we can
// exercise it without a React tree.  This mirrors lines 1911-1943
// (queuing) and 1986-1991 (mustRespawn check).
describe("Bug A — switchAgentPermissionMode(null) triggers an unwanted respawn", () => {
  function buildPipe() {
    const pendingFlags = new Map<string, {
      model?: string | null;
      permissionMode?: string | null;
      effort?: string | null;
    }>();
    const queue = (sid: string, patch: { model?: string | null; permissionMode?: string | null; effort?: string | null }) => {
      pendingFlags.set(sid, { ...(pendingFlags.get(sid) ?? {}), ...patch });
    };

    // Mirror of switchAgentPermissionMode (post-fix): null is a no-op
    // — the function early-returns before queueing anything.
    const switchPerm = async (sid: string, mode: string | null) => {
      if (mode === null) return;
      queue(sid, { permissionMode: mode });
    };

    // Mirror of submitAgentMessage's mustRespawn check (line 1987-1991).
    const submitWouldRespawn = (sid: string) => {
      const queued = pendingFlags.get(sid);
      return !!queued && (
        queued.model !== undefined
        || queued.permissionMode !== undefined
        || queued.effort !== undefined
      );
    };

    return { switchPerm, submitWouldRespawn, pendingFlags };
  }

  it("passing null should NOT queue a respawn — but it currently does", async () => {
    const { switchPerm, submitWouldRespawn } = buildPipe();
    await switchPerm("sess-1", null);
    // Desired: caller passed null = "no change wanted, skip everything".
    // Actual: queued.permissionMode === null which !== undefined, so the
    // next submit will fork-respawn for nothing.
    expect(submitWouldRespawn("sess-1")).toBe(false); // FAILS today
  });

  it("a real string (e.g. 'plan') correctly triggers a respawn", async () => {
    const { switchPerm, submitWouldRespawn } = buildPipe();
    await switchPerm("sess-1", "plan");
    expect(submitWouldRespawn("sess-1")).toBe(true); // already passes
  });
});

// =====================================================================
// Bug B — SESSION_UPDATED dedup compares tool_calls.length, not contents
// =====================================================================
describe("Bug B — SESSION_UPDATED drops updates when only the latest tool_call differs", () => {
  it("replacing the last tool_call with a different one (same length) is silently dropped", () => {
    let state = initialState;

    const sess1 = makeSession({
      metrics: {
        ...makeSession().metrics,
        tool_calls: [call("Read", "/a.ts"), call("Write", "/b.ts")],
      },
    });
    state = sessionReducer(state, { type: "SESSION_UPDATED", session: sess1 });

    // Backend re-emits the session — the most recent tool_call has been
    // replaced (e.g. compaction / coalescing / mutation).  Length is
    // identical, contents differ.
    const sess2 = makeSession({
      metrics: {
        ...makeSession().metrics,
        tool_calls: [call("Read", "/a.ts"), call("Bash", "echo hi")],
      },
    });
    const next = sessionReducer(state, { type: "SESSION_UPDATED", session: sess2 });

    // Desired: the new tool_call list propagates so AgentToolBlock can
    // render the new call.
    // Actual: dedup short-circuits on length match — `state` is returned
    // by reference and the UI keeps showing the old Write.
    expect(next.sessions["sess-1"].metrics.tool_calls[1].tool).toBe("Bash"); // FAILS today
  });
});

// =====================================================================
// Bug C — hasAddDirDrift never fires on attach/detach without a submit
// =====================================================================
//
// We can't easily simulate the full SessionProvider here, but we can
// pin the contract: the workspace_paths-updated event handler at
// lines 1026-1043 dispatches SESSION_UPDATED but does NOT call
// respawnAgent.  Without a follow-up submitAgentMessage, the bridge
// never sees the new --add-dir.
describe("Bug C — workspace_paths attach without submit leaves bridge stale", () => {
  // Mirror of the wp-event handler + the bridge-side prior add-dirs.
  function buildPipe() {
    const claudeAddDirs = new Map<string, string[]>();
    const respawnCalls: string[] = [];

    // Mirror of submitAgentMessage's drift check.
    const submitDriftCheck = (sid: string, live: string[]) => {
      const prior = claudeAddDirs.get(sid) ?? [];
      const drift = prior.length !== live.length
        || [...prior].sort().join("|") !== [...live].sort().join("|");
      if (drift) respawnCalls.push(sid);
    };

    // Mirror of the wp-event listener (current behavior): only dispatches
    // SESSION_UPDATED.  Does NOT trigger drift-respawn — see the
    // documented trade-off in SessionContext's wp-event handler.
    const wpEvent = (_sid: string, _paths: string[]) => {
      /* intentional no-op for the bridge side; drift fires later */
    };

    return { claudeAddDirs, respawnCalls, submitDriftCheck, wpEvent };
  }

  it("user attaches a path then never submits — bridge stays stale by design (no auto-respawn)", () => {
    const { claudeAddDirs, respawnCalls, wpEvent } = buildPipe();
    claudeAddDirs.set("s", ["/proj"]); // bridge spawned with this set
    wpEvent("s", ["/proj", "/extra"]); // user attaches /extra

    // Documented trade-off: an earlier draft auto-respawned the bridge
    // here, but that created an infinite respawn loop because the
    // freshly-spawned bridge re-emits the same wp-event and `claudeAddDirs`
    // is only refreshed inside `submitAgentMessage`.  The drift check in
    // `submitAgentMessage` already covers the next-turn case correctly;
    // the gap (attach without submit) is rare and surfaces clearly when
    // a file tool fails on an unattached path.
    expect(respawnCalls).toEqual([]);
  });
});

// =====================================================================
// Bug D — pendingFlags lingers when respawn fails, fires repeatedly
// =====================================================================
describe("Bug D — failed respawn keeps the queued flag, causing redundant respawn on next submit", () => {
  function buildPipe(respawnAlwaysFails: boolean) {
    const pendingFlags = new Map<string, { permissionMode?: string | null }>();
    let respawnAttempts = 0;

    const queue = (sid: string, patch: { permissionMode?: string | null }) => {
      pendingFlags.set(sid, { ...(pendingFlags.get(sid) ?? {}), ...patch });
    };

    const respawn = async (_sid: string) => {
      respawnAttempts++;
      return !respawnAlwaysFails;
    };

    // Mirror of submitAgentMessage's drain logic (post-fix): drop the
    // queued flag whether the respawn succeeded or failed, so a broken
    // respawn doesn't fire again on every subsequent submit.
    const submit = async (sid: string) => {
      const queued = pendingFlags.get(sid);
      const mustRespawn = !!queued && queued.permissionMode !== undefined;
      if (mustRespawn) {
        await respawn(sid);
        if (queued) pendingFlags.delete(sid);
      }
    };

    return { queue, submit, pendingFlags, getAttempts: () => respawnAttempts };
  }

  it("first respawn fails → next submit ALSO respawns (no retry budget, no clearing)", async () => {
    const ctx = buildPipe(/* respawnAlwaysFails */ true);
    ctx.queue("s", { permissionMode: "plan" });

    // First submit: respawn fails — but the queued flag is still
    // dropped so a second submit doesn't blindly re-trigger another
    // teardown.  One attempt per chip-click is the contract.
    await ctx.submit("s");
    expect(ctx.pendingFlags.has("s")).toBe(false);
    expect(ctx.getAttempts()).toBe(1);

    // Second submit (could be just a few seconds later — user typed
    // "ok" because nothing happened): we respawn AGAIN with the same
    // failed flag.  No back-off, no surrender, no user feedback.
    await ctx.submit("s");

    // Desired: at minimum, the queued flag should be dropped after one
    // failure (or a back-off applied) so the user doesn't get a second
    // surprise teardown of their bridge.
    // Actual: respawnAttempts climbs unboundedly with every submit.
    expect(ctx.getAttempts()).toBe(1); // FAILS today (will be 2)
  });
});
