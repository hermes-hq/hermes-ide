/**
 * F07 — typed Agent view errors, spawn/restart error plumbing, and the
 * store's record of unreadable agent output. Behavioural: every test feeds
 * inputs through the real functions and checks what comes out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  AgentCommandError,
  restartAgentSession,
  spawnAgentSession,
  toAgentCommandError,
} from "../api/agent";
import { agentDisplayName, classifyAgentError, looksSignedOut, type AgentErrorInput } from "../agent/agentErrors";
import { AgentSessionStore, protocolErrorOf } from "../agent/agentSessionStore";
import { emptyState, reduceEvent } from "../agent/messageStore";
import type { AgentEvent } from "../agent/types";
import { reportAgentSpawnFailure } from "../utils/agentSpawnFailure";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function input(over: Partial<AgentErrorInput> = {}): AgentErrorInput {
  return { state: emptyState(), stderr: "", exit: null, protocolError: null, ...over };
}

/** A state with one user message, so a clean exit is "between turns". */
function withConversation(): AgentErrorInput["state"] {
  return reduceEvent(emptyState(), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  } as AgentEvent);
}

function withResult(result: string, isError: boolean): AgentErrorInput["state"] {
  return reduceEvent(withConversation(), {
    type: "result",
    subtype: "success",
    is_error: isError,
    result,
    session_id: "s",
  } as unknown as AgentEvent);
}

describe("classifyAgentError", () => {
  it("returns nothing for a healthy session", () => {
    expect(classifyAgentError(input())).toBeNull();
    expect(classifyAgentError(input({ state: withResult("done", false) }))).toBeNull();
  });

  it("a clean exit between turns is not an error", () => {
    const e = classifyAgentError(input({ state: withConversation(), exit: { code: 0, signal: null } }));
    expect(e).toBeNull();
  });

  it("a crash is `exited` with the exit code and a Retry", () => {
    const e = classifyAgentError(input({
      state: withConversation(),
      stderr: "line one\nfake-bridge: simulated crash\n",
      exit: { code: 3, signal: null },
    }));
    expect(e).toMatchObject({ kind: "exited", title: "Claude stopped", action: "retry" });
    expect(e!.message).toContain("exit code 3");
    expect(e!.detail).toBe("line one\nfake-bridge: simulated crash");
  });

  it("a signal kill is `exited` and names the signal", () => {
    const e = classifyAgentError(input({ state: withConversation(), exit: { code: null, signal: "9" } }));
    expect(e?.kind).toBe("exited");
    expect(e!.message).toContain("signal 9");
  });

  it("an exit before any conversation is `exited` even with code 0", () => {
    expect(classifyAgentError(input({ exit: { code: 0, signal: null } }))?.kind).toBe("exited");
  });

  it("a signed-out result is `signed_out` with a Sign in action, even though the exit code is 0", () => {
    const e = classifyAgentError(input({
      state: withResult("Not logged in · Please run /login", true),
      exit: { code: 0, signal: null },
    }));
    expect(e).toMatchObject({ kind: "signed_out", title: "Claude is signed out", action: "sign-in" });
    expect(e!.detail).toBe("Not logged in · Please run /login");
  });

  it("sign-in text on stderr of a dead process is `signed_out` too", () => {
    const e = classifyAgentError(input({
      state: withConversation(),
      stderr: "Error: Invalid API key\n",
      exit: { code: 1, signal: null },
    }));
    expect(e?.kind).toBe("signed_out");
  });

  it("an old sign-in warning higher up in stderr does not turn a later crash into `signed_out`", () => {
    const e = classifyAgentError(input({
      state: withConversation(),
      stderr: [
        "warning: OAuth token has expired, refreshing",
        "turn 2 ok",
        "turn 3 ok",
        "turn 4 ok",
        "turn 5 ok",
        "panic: index out of range",
        "",
      ].join("\n"),
      exit: { code: 2, signal: null },
    }));
    expect(e?.kind).toBe("exited");
    expect(e?.action).toBe("retry");
  });

  it("sign-in text on stderr of a live process is not treated as signed out", () => {
    expect(classifyAgentError(input({ state: withConversation(), stderr: "Invalid API key\n" }))).toBeNull();
  });

  it("other result errors are left to the existing banner", () => {
    expect(classifyAgentError(input({ state: withResult("prompt is too long", true) }))).toBeNull();
  });

  it("a failed start is `spawn_failed` with the backend's message as detail", () => {
    const e = classifyAgentError(input({
      stderr: "[spawn:respawn] HERMES_BRIDGE_PATH points to a non-existent file: /work/x.mjs\n",
      exit: { code: -1, signal: "spawn-failed", kind: "spawn_failed" },
    }));
    expect(e).toMatchObject({ kind: "spawn_failed", title: "Couldn't start Claude", action: "retry" });
    expect(e!.detail).toContain("non-existent file");
  });

  it("an older spawn-failure exit without a kind still reads as `spawn_failed`", () => {
    expect(classifyAgentError(input({ exit: { code: -1, signal: "spawn-failed" } }))?.kind).toBe("spawn_failed");
  });

  it("`busy` offers only Dismiss", () => {
    const e = classifyAgentError(input({ exit: { code: -1, signal: "spawn-failed", kind: "busy" } }));
    expect(e).toMatchObject({ kind: "busy", action: "dismiss" });
  });

  it("unreadable output is `protocol` and wins over the exit it caused", () => {
    const e = classifyAgentError(input({
      state: withConversation(),
      protocolError: "expected value: garbage",
      exit: { code: 1, signal: null },
    }));
    expect(e).toMatchObject({ kind: "protocol", action: "retry", detail: "expected value: garbage" });
  });

  it("signed out wins over unreadable output and the exit", () => {
    const e = classifyAgentError(input({
      state: withResult("OAuth token has expired", true),
      protocolError: "bad",
      exit: { code: 1, signal: null },
    }));
    expect(e?.kind).toBe("signed_out");
  });

  it("a later failed restart wins over an earlier sign-in error", () => {
    const e = classifyAgentError(input({
      state: withResult("Not logged in · Please run /login", true),
      stderr: "[spawn:respawn] could not locate hermes-claude-bridge.mjs\n",
      exit: { code: -1, signal: "spawn-failed", kind: "spawn_failed" },
    }));
    expect(e?.kind).toBe("spawn_failed");
  });

  it("uses the agent's display name", () => {
    const e = classifyAgentError(input({ exit: { code: 0, signal: null } }), "Codex");
    expect(e!.title).toBe("Codex stopped");
  });

  it("builds every sentence from the translation function it is given", () => {
    const calls: [string, Record<string, string | number> | undefined][] = [];
    const t = (key: string, values?: Record<string, string | number>) => {
      calls.push([key, values]);
      return `<${key}>`;
    };
    const e = classifyAgentError(input({ state: withConversation(), exit: { code: 3, signal: null } }), "Gemini", t);
    expect(e).toMatchObject({ title: "<agentError.exited.title>", message: "<agentError.exited.messageWithStatus>" });
    expect(calls).toContainEqual(["agentError.exitCode", { code: 3 }]);
    expect(calls).toContainEqual(["agentError.exited.messageWithStatus", { agent: "Gemini", status: "<agentError.exitCode>" }]);
  });
});

describe("agentDisplayName", () => {
  it("is the provider's label, the raw id for an unknown provider, and Claude when unset", () => {
    expect(agentDisplayName("claude")).toBe("Claude");
    expect(agentDisplayName("codex")).toBe("Codex");
    expect(agentDisplayName("my-agent")).toBe("my-agent");
    expect(agentDisplayName(undefined)).toBe("Claude");
  });
});

describe("looksSignedOut", () => {
  it.each([
    "Not logged in · Please run /login",
    "Invalid API key · Please run /login",
    "OAuth token has expired",
    "assistant error: authentication_failed",
  ])("matches %j", (text) => {
    expect(looksSignedOut(text)).toBe(true);
  });

  it.each([
    "",
    "prompt is too long",
    "Read login.tsx and fix the form",
    "rate limit reached",
  ])("does not match %j", (text) => {
    expect(looksSignedOut(text)).toBe(false);
  });
});

describe("spawn / restart command errors", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("restartAgentSession calls the locked restart command with every option", async () => {
    invokeMock.mockResolvedValueOnce("uuid-1");
    const out = await restartAgentSession({ sessionId: "s1", workingDir: "/work/p", priorUuid: "u0", fork: false });
    expect(out).toBe("uuid-1");
    expect(invokeMock).toHaveBeenCalledWith("restart_agent_session", {
      sessionId: "s1",
      workingDir: "/work/p",
      priorUuid: "u0",
      fork: false,
    });
  });

  it("a typed backend error becomes an AgentCommandError with its kind and message", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "busy", message: "The agent for session 's1' is already running" });
    const err = await spawnAgentSession({ sessionId: "s1", workingDir: "/w" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCommandError);
    expect(err.kind).toBe("busy");
    expect(err.message).toBe("The agent for session 's1' is already running");
  });

  it("an untyped rejection counts as spawn_failed and keeps its text", async () => {
    invokeMock.mockRejectedValueOnce("Could not find `node`");
    const err = await restartAgentSession({ sessionId: "s1", workingDir: "/w" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCommandError);
    expect(err.kind).toBe("spawn_failed");
    expect(err.message).toBe("Could not find `node`");
  });

  it("toAgentCommandError ignores unknown kinds instead of trusting them", () => {
    expect(toAgentCommandError({ kind: "root", message: "x" }).kind).toBe("spawn_failed");
    expect(toAgentCommandError(new Error("boom")).message).toBe("boom");
  });

  it("a failed restart reports its kind on the exit channel", async () => {
    const events: Array<{ name: string; payload: unknown }> = [];
    const emitter = vi.fn(async (name: string, payload: unknown) => {
      events.push({ name, payload });
    });
    await reportAgentSpawnFailure(
      { sessionId: "s1", error: new AgentCommandError("busy", "already running"), context: "respawn" },
      emitter as any,
    );
    expect(events.find((e) => e.name === "agent-exit-s1")?.payload).toEqual({
      code: -1,
      signal: "spawn-failed",
      kind: "busy",
    });
    await reportAgentSpawnFailure(
      { sessionId: "s2", error: "HERMES_BRIDGE_PATH points to a non-existent file" },
      emitter as any,
    );
    expect(events.find((e) => e.name === "agent-exit-s2")?.payload).toMatchObject({ kind: "spawn_failed" });
  });
});

describe("store: unreadable agent output", () => {
  const listen = async () => () => {};

  it("recognises the backend's parse_error and oversize events", () => {
    expect(protocolErrorOf({ type: "parse_error", raw: "not json {", error: "expected value" })).toBe(
      "expected value: not json {",
    );
    expect(protocolErrorOf({ type: "_hermes_event", subtype: "parse_error", limit: 8 })).toContain("8 bytes");
    expect(protocolErrorOf({ type: "assistant" })).toBeNull();
  });

  it("records a bad line, keeps it through other events, and clears it on a new start", () => {
    const store = new AgentSessionStore("s", listen);
    store.injectEvent({ type: "parse_error", raw: "garbage", error: "expected value" } as unknown as AgentEvent);
    expect(store.getSnapshot().protocolError).toBe("expected value: garbage");
    store.injectEvent({ type: "rate_limit_event", rate_limit_info: {} } as unknown as AgentEvent);
    expect(store.getSnapshot().protocolError).toBe("expected value: garbage");
    store.injectEvent({ type: "system", subtype: "init", session_id: "s" } as unknown as AgentEvent);
    expect(store.getSnapshot().protocolError).toBeNull();
  });

  it("a turn that completes normally clears it; a failed one does not", () => {
    const store = new AgentSessionStore("s", listen);
    store.injectEvent({ type: "parse_error", raw: "x", error: "e" } as unknown as AgentEvent);
    store.injectEvent({ type: "result", subtype: "error", is_error: true, result: "no" } as unknown as AgentEvent);
    expect(store.getSnapshot().protocolError).not.toBeNull();
    store.injectEvent({ type: "result", subtype: "success", is_error: false, result: "ok" } as unknown as AgentEvent);
    expect(store.getSnapshot().protocolError).toBeNull();
  });

  it("clearExitNotice (after a successful Retry) clears it", () => {
    const store = new AgentSessionStore("s", listen);
    store.injectEvent({ type: "parse_error", raw: "x", error: "e" } as unknown as AgentEvent);
    store.clearExitNotice();
    expect(store.getSnapshot().protocolError).toBeNull();
  });
});
