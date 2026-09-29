/**
 * Keystrokes reach a session's terminal in the order they were typed: each
 * is its own backend call, and two calls in flight can arrive in either
 * order, so writes to one session go out one after the other.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { sessionId: string; data: string; done: () => void; fail: (e: Error) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    (_cmd: string, args: { sessionId: string; data: string }) =>
      new Promise<void>((resolve, reject) => {
        h.calls.push({ ...args, done: () => resolve(), fail: reject });
      }),
  ),
}));

import { writeToSession } from "../api/sessions";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("writeToSession", () => {
  it("sends a session's writes one after the other, in order; other sessions do not wait", async () => {
    const a = writeToSession("s1", "C");
    const b = writeToSession("s1", ":");
    const c = writeToSession("s1", "\\\\");
    const other = writeToSession("s2", "x");
    await flush();
    // The first write of each session goes out at once; the next waits.
    expect(h.calls.map((c) => `${c.sessionId}:${c.data}`)).toEqual(["s1:C", "s2:x"]);
    h.calls[0].done();
    await a;
    await flush();
    expect(h.calls.map((c) => c.data)).toEqual(["C", "x", ":"]);
    // A failed write does not stop the ones after it.
    h.calls[2].fail(new Error("gone"));
    await expect(b).rejects.toThrow("gone");
    await flush();
    expect(h.calls.map((c) => c.data)).toEqual(["C", "x", ":", "\\\\"]);
    h.calls[3].done();
    h.calls[1].done();
    await Promise.all([c, other]);
  });
});
