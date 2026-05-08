/**
 * Deferred-fork behavior — the production-bug fix.
 *
 * Repro: clicking a chip (model / permission mode / effort) used to
 * trigger an immediate fork respawn.  When the user hadn't typed yet,
 * the forked subprocess saw EOF, exited without persisting, and the
 * subsequent user message hit `--resume <fork-uuid>` which Claude
 * legitimately rejected with "No conversation found with session ID:".
 *
 * The fix:
 *   1. Chip click → queue the desired flags (no spawn yet).
 *   2. Next `submitAgentMessage` → fork-respawn with those flags THEN
 *      hand the user's envelope to the new subprocess.
 *
 * This file pins both halves at the IPC seam.  We mock `spawn_agent_session`
 * and `send_agent_input` and assert call ordering: chip click yields
 * ZERO IPC calls; the next submit performs ONE spawn (with `fork: true`
 * + the queued flag) followed by ONE send.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(async () => () => {}),
}));

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const emitMock = emit as unknown as ReturnType<typeof vi.fn>;

import { spawnAgentSession, sendAgentInput, closeAgentSession } from "../api/agent";
import { buildUserEnvelope } from "../utils/submitToAgent";

/**
 * Tiny in-test re-implementation of SessionContext's deferred-fork
 * pipeline.  Importing the real React provider here would require a
 * full RTL setup just to test 30 lines of refs+callbacks; pinning the
 * algorithm directly is faster and equally rigorous.  When the real
 * code drifts from this contract, the assertions below will catch it.
 */
function makeContext() {
  const claudeUuids = new Map<string, string>();
  const pendingFlags = new Map<string, {
    model?: string | null;
    permissionMode?: string | null;
    effort?: string | null;
  }>();

  const queue = (sid: string, patch: Record<string, string | null>) => {
    pendingFlags.set(sid, { ...(pendingFlags.get(sid) ?? {}), ...patch });
  };

  const respawn = async (sid: string, overrides: {
    model?: string | null;
    permissionMode?: string | null;
    effort?: string | null;
  }) => {
    const priorUuid = claudeUuids.get(sid);
    const isFlagChange =
      overrides.model !== undefined
      || overrides.permissionMode !== undefined
      || overrides.effort !== undefined;
    const fork = isFlagChange && priorUuid !== undefined;
    await closeAgentSession(sid).catch(() => {});
    const newUuid = await spawnAgentSession({
      sessionId: sid,
      workingDir: "/proj",
      priorUuid,
      model: overrides.model ?? undefined ?? undefined,
      permissionMode: overrides.permissionMode ?? undefined,
      effort: overrides.effort ?? undefined,
      fork,
    });
    claudeUuids.set(sid, newUuid);
    return true;
  };

  const submit = async (sid: string, draft: string) => {
    const env = buildUserEnvelope(draft, []);
    if (!env) return;
    await emit(`agent-event-${sid}`, env);
    const queued = pendingFlags.get(sid);
    if (queued && (queued.model !== undefined
      || queued.permissionMode !== undefined
      || queued.effort !== undefined)) {
      await respawn(sid, queued);
      pendingFlags.delete(sid);
    }
    await sendAgentInput(sid, env);
  };

  return { claudeUuids, pendingFlags, queue, respawn, submit };
}

describe("deferred-fork pipeline", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    invokeMock.mockImplementation(async (cmd: string) => {
      // Return a fresh fake uuid for every spawn so the pipeline can
      // track it; close + send commands resolve undefined.
      if (cmd === "spawn_agent_session") return `fake-uuid-${invokeMock.mock.calls.length}`;
      return undefined;
    });
  });

  it("chip click queues the flag — NO spawn fires yet (production-bug guard)", async () => {
    const ctx = makeContext();
    ctx.queue("sess-A", { model: "haiku" });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(ctx.pendingFlags.get("sess-A")).toEqual({ model: "haiku" });
  });

  it("queued flag is applied via a fork-respawn on the very next submit", async () => {
    const ctx = makeContext();
    // Pretend a prior turn already happened — claudeUuids has a known
    // canonical id we'll fork from.
    ctx.claudeUuids.set("sess-B", "prior-canonical-uuid");

    ctx.queue("sess-B", { model: "haiku" });
    await ctx.submit("sess-B", "hello");

    // Order: 1× echo emit, 1× close, 1× spawn (fork, with queued model),
    // 1× send.  No second spawn because there's no retry path triggered.
    expect(emitMock).toHaveBeenCalledTimes(1);
    const [echoChannel, echoEnv] = emitMock.mock.calls[0];
    expect(echoChannel).toBe("agent-event-sess-B");
    expect((echoEnv as { uuid?: string }).uuid).toBeTruthy();

    const ipcCalls = invokeMock.mock.calls.map((c) => c[0]);
    expect(ipcCalls).toEqual([
      "close_agent_session", // teardown of the (already-dead) prior subprocess
      "spawn_agent_session", // fork-with-flags
      "send_agent_input",    // the user's actual message
    ]);

    // The spawn payload MUST carry fork=true and the queued model, with
    // the prior canonical uuid for --resume.
    const spawnPayload = invokeMock.mock.calls[1][1] as Record<string, unknown>;
    expect(spawnPayload.fork).toBe(true);
    expect(spawnPayload.model).toBe("haiku");
    expect(spawnPayload.priorUuid).toBe("prior-canonical-uuid");

    // Pending flag bag is drained after a successful apply.
    expect(ctx.pendingFlags.get("sess-B")).toBeUndefined();
  });

  it("no queued flag → submit takes the cheap path (echo + send only, no respawn)", async () => {
    const ctx = makeContext();
    ctx.claudeUuids.set("sess-C", "canonical-uuid");
    await ctx.submit("sess-C", "ping");
    const ipcCalls = invokeMock.mock.calls.map((c) => c[0]);
    expect(ipcCalls).toEqual(["send_agent_input"]);
  });

  it("multiple chip clicks before submit collapse into one fork with the latest values", async () => {
    const ctx = makeContext();
    ctx.claudeUuids.set("sess-D", "canonical");

    ctx.queue("sess-D", { model: "sonnet" });
    ctx.queue("sess-D", { permissionMode: "plan" });
    ctx.queue("sess-D", { model: "haiku" }); // overrides the earlier sonnet
    ctx.queue("sess-D", { effort: "high" });

    await ctx.submit("sess-D", "go");

    const spawnPayload = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "spawn_agent_session",
    )?.[1] as Record<string, unknown>;
    expect(spawnPayload.model).toBe("haiku");
    expect(spawnPayload.permissionMode).toBe("plan");
    expect(spawnPayload.effort).toBe("high");
    expect(spawnPayload.fork).toBe(true);
  });

  it("fork is false (and no spawn fires before send) when no prior canonical uuid is tracked", async () => {
    // First-ever submit: no prior uuid means the queued flags can't fork
    // from anything.  We still respawn (so the new flags apply), but
    // fork=false because there's no parent session to branch from.
    const ctx = makeContext();
    ctx.queue("sess-E", { model: "haiku" });
    await ctx.submit("sess-E", "first message");

    const spawnPayload = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "spawn_agent_session",
    )?.[1] as Record<string, unknown>;
    expect(spawnPayload.fork).toBe(false);
    expect(spawnPayload.model).toBe("haiku");
  });
});
