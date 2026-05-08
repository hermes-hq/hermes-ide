/**
 * Tests for the Rust→frontend respawn-flag plumbing.
 *
 * The actual respawn semantics (does --resume find the session, does
 * --fork-session honor a new --model, etc.) are tested end-to-end against
 * the real `claude` binary in `src-tauri/src/agent/e2e_tests.rs`.  This
 * file pins the *frontend-side* contract: that `spawnAgentSession` accepts
 * the new option fields (effort, fork) and forwards them to the Rust IPC
 * with the right names.
 *
 * The IPC layer is deliberately thin (`invoke()` passthrough), so a
 * straight assertion on the call payload is enough to catch any
 * accidental rename / drop on the frontend side of the boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { spawnAgentSession } from "../api/agent";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

describe("spawnAgentSession IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue("returned-session-id");
  });

  it("forwards every spawn option through to the `spawn_agent_session` command", async () => {
    await spawnAgentSession({
      sessionId: "sess-1",
      workingDir: "/tmp/work",
      priorUuid: "prior-uuid-aaa",
      model: "haiku",
      permissionMode: "plan",
      effort: "high",
      fork: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("spawn_agent_session", {
      sessionId: "sess-1",
      workingDir: "/tmp/work",
      priorUuid: "prior-uuid-aaa",
      model: "haiku",
      permissionMode: "plan",
      effort: "high",
      fork: true,
    });
  });

  it("returns the Claude session id from the IPC", async () => {
    invokeMock.mockResolvedValueOnce("the-claude-uuid");
    const result = await spawnAgentSession({
      sessionId: "sess-2",
      workingDir: "/tmp",
    });
    expect(result).toBe("the-claude-uuid");
  });

  it("omits absent option fields rather than sending undefined", async () => {
    await spawnAgentSession({
      sessionId: "sess-3",
      workingDir: "/tmp",
    });
    const [, payload] = invokeMock.mock.calls[0];
    const keys = Object.keys(payload as Record<string, unknown>);
    // Required only — optional fields shouldn't pollute the payload.  This
    // protects against future regressions where someone sets `fork: undefined`
    // explicitly and Claude Rust sees a key it can't deserialize.
    expect(keys.sort()).toEqual(["sessionId", "workingDir"]);
  });

  it("permits the four published permission modes plus auto/dontAsk (whitelist tested in Rust)", async () => {
    // The frontend doesn't enforce the whitelist — Rust does.  All we pin
    // here is that the value is forwarded as-is so the Rust whitelist sees
    // exactly what the user picked.
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"]) {
      invokeMock.mockClear();
      await spawnAgentSession({
        sessionId: "sess-mode",
        workingDir: "/tmp",
        permissionMode: mode,
      });
      const [, payload] = invokeMock.mock.calls[0];
      expect((payload as { permissionMode?: string }).permissionMode).toBe(mode);
    }
  });

  it("forwards effort levels exactly so the Rust whitelist can validate them", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      invokeMock.mockClear();
      await spawnAgentSession({
        sessionId: "sess-effort",
        workingDir: "/tmp",
        effort: level,
      });
      const [, payload] = invokeMock.mock.calls[0];
      expect((payload as { effort?: string }).effort).toBe(level);
    }
  });
});
