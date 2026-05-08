/**
 * Tests for `reduceInit`, the pure step inside `useAgentInit` that snapshots
 * the most-recent `system/init` event from a stream of agent events.
 *
 * Hook behaviour itself (Tauri listener wiring) is integration-tested by
 * the AgentSessionView; here we cover only the pure logic.
 */
import { describe, it, expect } from "vitest";
import { reduceInit } from "../agent/useAgentInit";
import type { AgentEvent, InitEvent } from "../agent/types";

function makeInit(overrides: Partial<InitEvent> = {}): InitEvent {
  return {
    type: "system",
    subtype: "init",
    cwd: "/tmp",
    session_id: "abc",
    uuid: "uuid",
    tools: [],
    slash_commands: [],
    mcp_servers: [],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    ...overrides,
  };
}

describe("reduceInit", () => {
  it("returns the previous state for non-init events", () => {
    const ev: AgentEvent = { type: "system", subtype: "status" };
    expect(reduceInit(null, ev)).toBeNull();

    const seeded = makeInit();
    expect(reduceInit(seeded, ev)).toBe(seeded);
  });

  it("captures the first init event when there is no previous state", () => {
    const init = makeInit({ model: "claude-opus-4-1" });
    const next = reduceInit(null, init);
    expect(next).toBe(init);
  });

  it("replaces the previous init event when a fresh init arrives", () => {
    const old = makeInit({ model: "claude-sonnet-4-6", permissionMode: "default" });
    const updated = makeInit({ model: "claude-opus-4-1", permissionMode: "plan" });
    const next = reduceInit(old, updated);
    expect(next).toBe(updated);
  });

  it("ignores assistant events", () => {
    const ev: AgentEvent = {
      type: "assistant",
      message: { id: "m1", role: "assistant", model: "x", content: [] },
      session_id: "abc",
      uuid: "u1",
    };
    const seeded = makeInit();
    expect(reduceInit(seeded, ev)).toBe(seeded);
  });

  it("ignores result events", () => {
    const ev: AgentEvent = { type: "result", subtype: "success", is_error: false };
    expect(reduceInit(null, ev)).toBeNull();
  });

  // ─── two-way picker sync (state-changed) ───────────────────────────
  //
  // The bridge emits `_hermes_state_changed` whenever its live model /
  // permissionMode drifts mid-session (EnterPlanMode flips perm mode
  // without spawning a new init).  reduceInit must patch the cached
  // init so the composer's chip pickers reflect Claude's reality
  // without waiting for a respawn.

  it("state-changed: patches permissionMode on existing init (EnterPlanMode flow)", () => {
    const seeded = makeInit({ permissionMode: "default", model: "claude-opus-4-7" });
    const next = reduceInit(seeded, {
      type: "_hermes_state_changed",
      session_id: "abc",
      permissionMode: "plan",
    });
    expect(next).not.toBe(seeded);
    expect(next?.permissionMode).toBe("plan");
    expect(next?.model).toBe("claude-opus-4-7");
  });

  it("state-changed: patches model when /model is invoked mid-session", () => {
    const seeded = makeInit({ model: "claude-sonnet-4-6", permissionMode: "default" });
    const next = reduceInit(seeded, {
      type: "_hermes_state_changed",
      model: "claude-opus-4-7",
    });
    expect(next?.model).toBe("claude-opus-4-7");
    expect(next?.permissionMode).toBe("default");
  });

  it("state-changed: ignored when no prior init exists (don't fabricate one)", () => {
    const next = reduceInit(null, {
      type: "_hermes_state_changed",
      permissionMode: "plan",
    });
    expect(next).toBeNull();
  });

  it("state-changed: omitted fields don't overwrite their existing values", () => {
    const seeded = makeInit({ model: "x", permissionMode: "default" });
    const next = reduceInit(seeded, { type: "_hermes_state_changed" });
    expect(next?.model).toBe("x");
    expect(next?.permissionMode).toBe("default");
  });
});
