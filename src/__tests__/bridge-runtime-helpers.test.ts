/**
 * Coverage for the bridge's runtime/lifecycle helpers:
 *
 * - `createIdempotentLatch` — once-only resolver used to mark "first
 *   SDK init event seen".  Multiple `.resolve()` calls must be safe.
 *
 * - `createControlOpBuffer` — buffers control ops (setModel /
 *   setPermissionMode / interrupt) that arrive between bridge startup
 *   and `query()` returning.  Without it, ops sent in that microsecond
 *   window were silently dropped, which surfaced as confusing "the
 *   chip updated but the model didn't" bugs.
 */
import { describe, it, expect, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module, no .d.ts file
import {
  createIdempotentLatch,
  createControlOpBuffer,
  toSdkUserMessage,
  buildSdkEnv,
  quietExpectedWarnings,
} from "../../src-tauri/bridge/bridgeRuntimeHelpers.mjs";
import { buildUserEnvelope } from "../utils/submitToAgent";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("../api/agent", () => ({ sendAgentInput: vi.fn() }));

describe("createIdempotentLatch", () => {
  it("resolves the promise on first call", async () => {
    const latch = createIdempotentLatch();
    expect(latch.settled()).toBe(false);
    latch.resolve();
    expect(latch.settled()).toBe(true);
    await expect(latch.promise).resolves.toBeUndefined();
  });

  it("subsequent .resolve() calls are silent no-ops", async () => {
    const latch = createIdempotentLatch();
    latch.resolve();
    latch.resolve();
    latch.resolve();
    expect(latch.settled()).toBe(true);
    await expect(latch.promise).resolves.toBeUndefined();
  });

  it("the promise is awaitable before resolution", async () => {
    const latch = createIdempotentLatch();
    let resolvedAt: number | null = null;
    const waiter = latch.promise.then(() => {
      resolvedAt = Date.now();
    });
    expect(resolvedAt).toBeNull();
    latch.resolve();
    await waiter;
    expect(resolvedAt).not.toBeNull();
  });

  it("two latches are independent", () => {
    const a = createIdempotentLatch();
    const b = createIdempotentLatch();
    a.resolve();
    expect(a.settled()).toBe(true);
    expect(b.settled()).toBe(false);
  });
});

describe("createControlOpBuffer", () => {
  it("buffers ops before markReady() — handler not invoked yet", () => {
    const handler = vi.fn();
    const buf = createControlOpBuffer(handler);
    buf.dispatch({ op: "setModel", model: "opus" });
    buf.dispatch({ op: "interrupt" });
    expect(handler).not.toHaveBeenCalled();
    expect(buf.isReady()).toBe(false);
    expect(buf.pending()).toBe(2);
  });

  it("drains buffered ops in arrival order on markReady()", async () => {
    const calls: unknown[] = [];
    const handler = (op: unknown) => { calls.push(op); };
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ op: "setModel", model: "opus" });
    await buf.dispatch({ op: "setPermissionMode", mode: "plan" });
    await buf.dispatch({ op: "interrupt" });
    expect(calls).toEqual([]);

    await buf.markReady();
    expect(calls).toEqual([
      { op: "setModel", model: "opus" },
      { op: "setPermissionMode", mode: "plan" },
      { op: "interrupt" },
    ]);
    expect(buf.pending()).toBe(0);
  });

  it("dispatches synchronously after markReady()", async () => {
    const handler = vi.fn();
    const buf = createControlOpBuffer(handler);
    await buf.markReady();
    await buf.dispatch({ op: "setModel", model: "haiku" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ op: "setModel", model: "haiku" });
  });

  it("awaits async handlers in the drain — no concurrent writes", async () => {
    const calls: string[] = [];
    let active = 0;
    let maxConcurrency = 0;
    const handler = async (op: { id: string }) => {
      active++;
      maxConcurrency = Math.max(maxConcurrency, active);
      await new Promise((r) => setTimeout(r, 5));
      calls.push(op.id);
      active--;
    };
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ id: "first" });
    await buf.dispatch({ id: "second" });
    await buf.dispatch({ id: "third" });
    await buf.markReady();
    // Sequential dispatch — never two at the same time.
    expect(maxConcurrency).toBe(1);
    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("markReady() is idempotent — second call is a no-op", async () => {
    const handler = vi.fn();
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ op: "setModel", model: "opus" });
    await buf.markReady();
    expect(handler).toHaveBeenCalledTimes(1);
    await buf.markReady();
    await buf.markReady();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isReady() reflects state across the lifecycle", async () => {
    const buf = createControlOpBuffer(() => {});
    expect(buf.isReady()).toBe(false);
    await buf.markReady();
    expect(buf.isReady()).toBe(true);
  });
});

describe("toSdkUserMessage — SDK `origin` provenance", () => {
  it("composer path: a typed message reaches the SDK stamped as human", () => {
    const env = buildUserEnvelope("hello", [])!;
    const msg = toSdkUserMessage(JSON.parse(JSON.stringify(env)), "sid-1");
    expect(msg.origin).toEqual({ kind: "human" });
    expect(msg.message).toEqual(env.message);
    expect(msg.session_id).toBe("sid-1");
    expect(msg.parent_tool_use_id).toBeNull();
  });

  it("injected path: an envelope without origin stays unattributed (never defaulted to human)", () => {
    const injected = {
      type: "user",
      uuid: "u-1",
      message: { role: "user", content: [{ type: "text", text: "injected" }] },
    };
    const msg = toSdkUserMessage(injected, "sid-1");
    expect("origin" in msg).toBe(false);
  });

  it("passes a non-human origin through unchanged", () => {
    const origin = { kind: "peer", from: "other-session" };
    const msg = toSdkUserMessage({ type: "user", message: {}, origin }, undefined);
    expect(msg.origin).toEqual(origin);
    expect("session_id" in msg).toBe(false);
  });
});

describe("buildSdkEnv", () => {
  it("enables CLAUDE.md loading from --add-dir folders by default", () => {
    const env = buildSdkEnv({ PATH: "/usr/bin" }, "hermes-ide/v1");
    expect(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("hermes-ide/v1");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("respects an explicit user value, including opting out", () => {
    const env = buildSdkEnv({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "0" }, "x");
    expect(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("0");
  });
});

describe("quietExpectedWarnings", () => {
  it("drops the SDK's note about tools the bridge approves on purpose, and nothing else", () => {
    const seen: unknown[][] = [];
    const proc = { emitWarning: (...args: unknown[]) => { seen.push(args); } };
    const restore = quietExpectedWarnings(proc);
    proc.emitWarning("canUseTool will not be invoked for: mcp__hermes__*", { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" });
    proc.emitWarning("same, older signature", "Warning", "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED");
    proc.emitWarning(Object.assign(new Error("as an Error"), { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" }));
    proc.emitWarning("something else", { code: "SOME_OTHER_WARNING" });
    proc.emitWarning("no code at all");
    expect(seen.map((a) => (a[0] instanceof Error ? a[0].message : a[0]))).toEqual(["something else", "no code at all"]);
    restore();
    proc.emitWarning("back to normal", { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" });
    expect(seen).toHaveLength(3);
  });
});
