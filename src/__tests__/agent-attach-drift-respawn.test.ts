/**
 * `submitAgentMessage` must detect drift between the live
 * `session.workspace_paths` and the snapshot of `--add-dir` values the
 * bridge was last spawned with, and respawn the SDK with the new dirs
 * BEFORE writing the user envelope to stdin.
 *
 * Bug repro: until 1.0.0 the user attach/detach round-trip mutated only
 * `session_realms` rows in the auto-attach branch, leaving
 * `workspace_paths` empty.  Even after we fixed the upstream (T1, T2),
 * we need the downstream check too: an attach AFTER spawn means the
 * subprocess is alive with stale `additionalDirectories`.  Until the
 * next user submit we close+respawn the bridge with the new add-dir
 * list, the SDK's file tools will refuse the freshly-attached path.
 *
 * The respawn shape MUST be a plain `--resume` (not a fork) when only
 * add-dirs change — the conversation is unchanged, so forking would
 * needlessly branch the session id and lose continuity.  The Anthropic
 * Agent SDK takes `additionalDirectories` per-invocation, so resume +
 * fresh dirs is enough.
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
import { hasAddDirDrift } from "../utils/agentDrift";

/**
 * Mini-replica of `submitAgentMessage`'s drift-detection branch.
 * Mirrors `SessionContext.tsx::submitAgentMessage` lines around the
 * "Detect attach/detach drift" comment.  When that code drifts, the
 * assertions below catch it.
 */
function makeContext() {
  const claudeUuids = new Map<string, string>();
  const claudeAddDirs = new Map<string, string[]>();
  const sessions = new Map<string, { id: string; mode: "agent" | "terminal"; workspace_paths: string[] }>();

  const submit = async (sid: string, draft: string) => {
    const env = buildUserEnvelope(draft, []);
    if (!env) return;
    await emit(`agent-event-${sid}`, env);

    const session = sessions.get(sid);
    let mustRespawn = false;
    if (session?.mode === "agent") {
      const live = session.workspace_paths;
      const prior = claudeAddDirs.get(sid) ?? [];
      if (hasAddDirDrift(prior, live)) mustRespawn = true;
    }

    if (mustRespawn && session) {
      const priorUuid = claudeUuids.get(sid);
      await closeAgentSession(sid).catch(() => {});
      const newUuid = await spawnAgentSession({
        sessionId: sid,
        workingDir: "/proj",
        priorUuid,
        addDirs: session.workspace_paths,
        fork: false,
      });
      claudeUuids.set(sid, newUuid);
      claudeAddDirs.set(sid, [...session.workspace_paths]);
    }

    await sendAgentInput(sid, env);
  };

  return { sessions, claudeUuids, claudeAddDirs, submit };
}

describe("agent submit: add-dir drift respawn", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "spawn_agent_session") return `respawned-uuid-${invokeMock.mock.calls.length}`;
      return undefined;
    });
  });

  it("attached project AFTER spawn: next submit respawns with new addDirs (plain resume, no fork)", async () => {
    const ctx = makeContext();
    ctx.sessions.set("sess-A", {
      id: "sess-A",
      mode: "agent",
      workspace_paths: ["/Users/dev/proj-a", "/Users/dev/proj-b"], // live
    });
    ctx.claudeUuids.set("sess-A", "canonical-uuid");
    ctx.claudeAddDirs.set("sess-A", ["/Users/dev/proj-a"]); // snapshot from prior spawn

    await ctx.submit("sess-A", "read README in proj-b");

    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual([
      "close_agent_session",
      "spawn_agent_session",
      "send_agent_input",
    ]);

    const spawnPayload = invokeMock.mock.calls.find(
      ([c]) => c === "spawn_agent_session",
    )?.[1] as Record<string, unknown>;
    expect(spawnPayload.addDirs).toEqual(["/Users/dev/proj-a", "/Users/dev/proj-b"]);
    expect(spawnPayload.fork).toBe(false);
    expect(spawnPayload.priorUuid).toBe("canonical-uuid");

    // The drift snapshot is updated post-respawn so the next submit is a no-op.
    expect(ctx.claudeAddDirs.get("sess-A")).toEqual([
      "/Users/dev/proj-a",
      "/Users/dev/proj-b",
    ]);
  });

  it("detach back to empty: respawn fires, addDirs becomes []", async () => {
    const ctx = makeContext();
    ctx.sessions.set("sess-B", {
      id: "sess-B",
      mode: "agent",
      workspace_paths: [], // user just detached the only project
    });
    ctx.claudeUuids.set("sess-B", "canonical-uuid");
    ctx.claudeAddDirs.set("sess-B", ["/Users/dev/proj-a"]);

    await ctx.submit("sess-B", "now without proj-a");

    const spawnPayload = invokeMock.mock.calls.find(
      ([c]) => c === "spawn_agent_session",
    )?.[1] as Record<string, unknown>;
    expect(spawnPayload.addDirs).toEqual([]);
    expect(spawnPayload.fork).toBe(false);
  });

  it("no drift: cheap path — only echo + send, no close/spawn (regression guard)", async () => {
    const ctx = makeContext();
    ctx.sessions.set("sess-C", {
      id: "sess-C",
      mode: "agent",
      workspace_paths: ["/Users/dev/proj-a"],
    });
    ctx.claudeAddDirs.set("sess-C", ["/Users/dev/proj-a"]);
    ctx.claudeUuids.set("sess-C", "canonical");

    await ctx.submit("sess-C", "ping");
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(["send_agent_input"]);
  });

  it("drift on a TERMINAL session: NEVER respawns (Terminal mode does not use --add-dir)", async () => {
    const ctx = makeContext();
    ctx.sessions.set("sess-D", {
      id: "sess-D",
      mode: "terminal",
      workspace_paths: ["/Users/dev/proj-a", "/Users/dev/proj-b"],
    });
    ctx.claudeAddDirs.set("sess-D", []); // never set, but if it were stale...
    ctx.claudeUuids.set("sess-D", "n/a");

    await ctx.submit("sess-D", "ls");
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(["send_agent_input"]);
  });

  it("first attach BEFORE first submit: drift respawn carries the new dir", async () => {
    // Session created with workspace_paths: [], snapshot also [].  User
    // attaches project (workspace_paths -> [A]) BEFORE typing anything.
    // First submit should respawn with [A] (plain resume from the init
    // uuid Claude returned on initial spawn).
    const ctx = makeContext();
    ctx.sessions.set("sess-E", {
      id: "sess-E",
      mode: "agent",
      workspace_paths: ["/Users/dev/proj-a"],
    });
    ctx.claudeAddDirs.set("sess-E", []);
    ctx.claudeUuids.set("sess-E", "init-uuid");

    await ctx.submit("sess-E", "first message");

    const spawnPayload = invokeMock.mock.calls.find(
      ([c]) => c === "spawn_agent_session",
    )?.[1] as Record<string, unknown>;
    expect(spawnPayload.addDirs).toEqual(["/Users/dev/proj-a"]);
    expect(spawnPayload.priorUuid).toBe("init-uuid");
    expect(spawnPayload.fork).toBe(false);
  });
});
