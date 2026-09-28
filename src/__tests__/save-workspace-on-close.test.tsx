// @vitest-environment jsdom
/**
 * Closing a session rewrites the saved workspace within a moment instead of
 * on the next 10 s tick, so it cannot come back after a quit or a crash.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { SAVE_AFTER_CLOSE_MS, useSaveWorkspaceOnClose } from "../state/useSaveWorkspaceOnClose";

describe("useSaveWorkspaceOnClose", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(initial: string[]) {
    const save = vi.fn(() => Promise.resolve());
    const hook = renderHook(({ ids }) => useSaveWorkspaceOnClose(ids, save), {
      initialProps: { ids: initial },
    });
    return { save, rerender: (ids: string[]) => hook.rerender({ ids }), unmount: hook.unmount };
  }

  it("saves shortly after a session is closed", () => {
    const { save, rerender } = setup(["a", "b"]);
    rerender(["a"]);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(SAVE_AFTER_CLOSE_MS).toBeLessThan(1_000);
  });

  it("saves when the last session is closed", () => {
    const { save, rerender } = setup(["a"]);
    rerender([]);
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not save on first render or when sessions are only added or reordered", () => {
    const { save, rerender } = setup(["a"]);
    rerender(["a", "b"]);
    rerender(["b", "a"]);
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS * 10);
    expect(save).not.toHaveBeenCalled();
  });

  it("writes several closes in a row once", () => {
    const { save, rerender } = setup(["a", "b", "c"]);
    rerender(["a", "b"]);
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS / 2);
    rerender(["a"]);
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS / 2);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("counts a close even when another session opens at the same time", () => {
    const { save, rerender } = setup(["a", "b"]);
    rerender(["a", "c"]);
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("uses the latest save function", () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const hook = renderHook(({ ids, save }) => useSaveWorkspaceOnClose(ids, save), {
      initialProps: { ids: ["a", "b"], save: first },
    });
    hook.rerender({ ids: ["a"], save: second });
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not save after unmount and survives a failing save", async () => {
    const { save, rerender, unmount } = setup(["a", "b"]);
    rerender(["a"]);
    unmount();
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS);
    expect(save).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(() => Promise.reject(new Error("disk full")));
    const hook = renderHook(({ ids }) => useSaveWorkspaceOnClose(ids, failing), { initialProps: { ids: ["x", "y"] } });
    hook.rerender({ ids: ["x"] });
    vi.advanceTimersByTime(SAVE_AFTER_CLOSE_MS);
    await vi.runAllTimersAsync();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
