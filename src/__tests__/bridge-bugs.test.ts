/**
 * Audit-found bug coverage for the Hermes Claude Bridge.
 *
 * Each test in this file is intentionally written to FAIL against the
 * current bridge implementation — they document concrete bugs (not
 * style nits) the audit identified.  See the report accompanying this
 * file for severity, root cause, and proposed fix per bug.
 */
import { describe, it, expect, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module, no .d.ts file
import { createControlOpBuffer } from "../../src-tauri/bridge/bridgeRuntimeHelpers.mjs";

// ─── BUG-1 ─────────────────────────────────────────────────────────
// `controlOpBuffer.markReady()` drains queued ops with `await handler(op)`
// inside a sequential `for…of`.  When the handler REJECTS for one op
// (e.g. SDK `setModel` returns a rejected promise because the model id
// is unknown), the whole drain aborts and every subsequent queued op is
// silently lost.  Because `markReady()` is also marked idempotent
// (`if (ready) return`), there is NO recovery path — re-calling it does
// nothing, and the lost ops never run.
//
// Symptom in production: a user sends `setModel`, `setPermissionMode`,
// `interrupt` in fast succession during early bridge startup.  If the
// first one rejects, the permission flip and the interrupt are dropped
// without any error surfaced to the host (the rejection is logged once
// to stderr and that's it).

describe("BUG-1: controlOpBuffer.markReady drops remaining queued ops on first handler rejection", () => {
  it("invokes ALL buffered handlers even when one rejects", async () => {
    const calls: unknown[] = [];
    const handler = vi.fn(async (op: { id: string }) => {
      calls.push(op.id);
      if (op.id === "second") throw new Error("simulated SDK rejection");
    });
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ id: "first" });
    await buf.dispatch({ id: "second" });
    await buf.dispatch({ id: "third" });
    await buf.dispatch({ id: "fourth" });

    // markReady SHOULD drain every queued op even if one rejects —
    // each control op is independent.  The rejection should surface
    // (e.g. via a Promise.allSettled-style failure list, or by the
    // caller catching the markReady() rejection AFTER all ops ran),
    // but op #3 and op #4 must STILL run.
    await buf.markReady().catch(() => { /* swallow drain error */ });

    expect(calls).toEqual(["first", "second", "third", "fourth"]);
  });

  it("subsequent dispatches still execute after a drain failure (queue is not stuck)", async () => {
    const calls: string[] = [];
    const handler = vi.fn(async (op: { id: string }) => {
      calls.push(op.id);
      if (op.id === "boom") throw new Error("boom");
    });
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ id: "boom" });
    await buf.dispatch({ id: "queued-after-boom" });

    await buf.markReady().catch(() => {});

    // Direct dispatch after markReady (post-drain) must still work.
    await buf.dispatch({ id: "post-ready" });

    // The queued one MUST have been processed (the drain swallowed it).
    expect(calls).toContain("queued-after-boom");
    expect(calls).toContain("post-ready");
  });
});

// ─── BUG-2 ─────────────────────────────────────────────────────────
// `controlOpBuffer.dispatch()` called concurrently with `markReady()`
// breaks FIFO ordering.  `markReady()` flips `ready = true` BEFORE
// awaiting the drain loop.  If a new `dispatch()` arrives during the
// drain (e.g. another control op landed on stdin while we are still
// processing the first one), it sees `ready === true` and runs the
// handler IMMEDIATELY rather than queuing behind the drain.
//
// Result: the live op can complete BEFORE earlier-queued ops, even
// though the code comment in markReady() promises "Awaited
// sequentially: control ops are stateful (setModel followed by
// setPermissionMode shouldn't race), so preserving arrival order
// matters."
//
// Symptom: a `setPermissionMode("plan")` queued during startup can land
// AFTER a freshly-arrived `setModel("opus")` because the latter
// short-circuits the queue.  This is exactly the race the buffer was
// supposed to prevent.

describe("BUG-2: controlOpBuffer breaks FIFO when dispatch races with markReady drain", () => {
  it("a dispatch that races the drain MUST not jump ahead of queued ops", async () => {
    const order: string[] = [];
    let resolveSlow: (() => void) | null = null;
    const handler = async (op: { id: string }) => {
      if (op.id === "slow-queued") {
        await new Promise<void>((r) => { resolveSlow = r; });
      }
      order.push(op.id);
    };
    const buf = createControlOpBuffer(handler);

    // Queue an op that will block the drain.
    await buf.dispatch({ id: "slow-queued" });
    // Queue a second op behind it.
    await buf.dispatch({ id: "second-queued" });

    // Begin draining (slow-queued will block on the awaitable resolver).
    const drainPromise = buf.markReady();

    // Yield so the drain loop reaches `await handler(slow-queued)`.
    await new Promise((r) => setTimeout(r, 0));

    // Now a "live" dispatch arrives — should NOT run before the
    // already-queued ops complete.
    const livePromise = buf.dispatch({ id: "racing-live" });

    // Unblock the drain.
    resolveSlow!();
    await Promise.all([drainPromise, livePromise]);

    expect(order).toEqual(["slow-queued", "second-queued", "racing-live"]);
  });
});

// ─── BUG-3 ─────────────────────────────────────────────────────────
// `markReady()` rejects with the FIRST handler rejection but never
// surfaces what was lost.  Even ignoring BUG-1 (queue gets stuck), the
// caller has no way to know the queue was partially drained — they get
// one rejection, but the in-flight + remaining ops are silently dropped.
//
// At minimum, `markReady()` should either:
//   (a) collect all rejections and raise an AggregateError, OR
//   (b) run every op via `Promise.allSettled` and report a summary.
//
// The current behaviour (first-rejection-stops) is the worst of both.

describe("BUG-3: markReady() does not report all failures (silent partial drain)", () => {
  it("when multiple ops reject, the caller should learn about all of them", async () => {
    const handler = async (op: { id: string }) => {
      if (op.id === "a" || op.id === "c") {
        throw new Error(`handler failed for ${op.id}`);
      }
    };
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ id: "a" });
    await buf.dispatch({ id: "b" });
    await buf.dispatch({ id: "c" });

    let caught: unknown;
    try {
      await buf.markReady();
    } catch (err) {
      caught = err;
    }

    // Ideally an AggregateError listing both 'a' and 'c'.  Today the
    // caller only sees the 'a' rejection and 'c' is silently swallowed
    // because the drain loop never reaches it (BUG-1).
    const message = String(caught instanceof Error ? caught.message : caught);
    expect(message).toMatch(/c/);
  });
});
