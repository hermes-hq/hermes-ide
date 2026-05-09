/**
 * Tests for `reportAgentSpawnFailure`.
 *
 * Until v1.1.1, spawn rejections from `spawnAgentSession` were caught
 * with `console.error` only, leaving the user staring at a "Ready"
 * session that wasn't actually running.  This helper round-trips the
 * error through the same `agent-stderr-{sessionId}` /
 * `agent-exit-{sessionId}` events the AgentSessionView already
 * renders, so the failure shows up inline.
 *
 * These tests pin both the channel names and the payload shape so a
 * future refactor doesn't accidentally break the surfacing path.
 */

import { describe, it, expect, vi } from "vitest";
import {
  formatSpawnError,
  reportAgentSpawnFailure,
} from "../utils/agentSpawnFailure";

describe("formatSpawnError", () => {
  it("unwraps Error instances to their message", () => {
    expect(formatSpawnError(new Error("boom"))).toBe("boom");
  });
  it("passes through string errors verbatim", () => {
    expect(formatSpawnError("could not locate hermes-claude-bridge.mjs")).toBe(
      "could not locate hermes-claude-bridge.mjs",
    );
  });
  it("JSON-encodes object errors", () => {
    expect(formatSpawnError({ code: "ENOENT" })).toBe('{"code":"ENOENT"}');
  });
  it("falls back to String() on unencodable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Should not throw.
    const out = formatSpawnError(cyclic);
    expect(typeof out).toBe("string");
  });
});

describe("reportAgentSpawnFailure", () => {
  it("emits to both stderr and exit channels with the formatted message", async () => {
    const events: Array<{ name: string; payload: unknown }> = [];
    const fakeEmitter = vi.fn(async (name: string, payload: unknown) => {
      events.push({ name, payload });
    });

    await reportAgentSpawnFailure(
      {
        sessionId: "abc-123",
        error: new Error("could not locate hermes-claude-bridge.mjs"),
        context: "create",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeEmitter as any,
    );

    expect(events).toHaveLength(2);
    const stderrEvent = events.find((e) => e.name === "agent-stderr-abc-123");
    const exitEvent = events.find((e) => e.name === "agent-exit-abc-123");
    expect(stderrEvent).toBeDefined();
    expect(exitEvent).toBeDefined();
    expect(stderrEvent!.payload).toMatch(
      /\[spawn:create\] could not locate hermes-claude-bridge\.mjs/,
    );
    // Trailing newline so concatenated chunks render line-per-failure.
    expect(stderrEvent!.payload).toMatch(/\n$/);
    expect(exitEvent!.payload).toMatchObject({
      code: -1,
      signal: "spawn-failed",
    });
  });

  it("uses a generic prefix when no context is supplied", async () => {
    const events: Array<{ name: string; payload: unknown }> = [];
    const fakeEmitter = vi.fn(async (name: string, payload: unknown) => {
      events.push({ name, payload });
    });

    await reportAgentSpawnFailure(
      { sessionId: "s1", error: "node not found" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeEmitter as any,
    );
    const stderr = events.find((e) => e.name === "agent-stderr-s1")!;
    expect(stderr.payload).toMatch(/^\[spawn\] node not found/);
  });

  it("does not throw when the emitter rejects", async () => {
    const flaky = vi.fn(async () => {
      throw new Error("ipc broken");
    });

    await expect(
      reportAgentSpawnFailure(
        { sessionId: "s1", error: new Error("x") },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        flaky as any,
      ),
    ).resolves.toBeUndefined();
  });
});
