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
} from "../../src-tauri/bridge/bridgeRuntimeHelpers.mjs";

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
