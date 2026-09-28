// @vitest-environment jsdom
/**
 * The saved workspace is rewritten within a moment of the launch's restore
 * settling and of every session opening or closing, instead of on the next
 * 10 s tick, so a quit or a crash right after neither loses a session nor
 * brings a closed one back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { SAVE_AFTER_CHANGE_MS, useSaveWorkspaceOnChange } from "../state/useSaveWorkspaceOnChange";

describe("useSaveWorkspaceOnChange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A hook that is already loaded and has written its first save. */
  function setup(initial: string[]) {
    const save = vi.fn(() => Promise.resolve());
    const hook = renderHook(({ ids, ready }) => useSaveWorkspaceOnChange(ids, ready, save), {
      initialProps: { ids: initial, ready: true },
    });
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    save.mockClear();
    return { save, rerender: (ids: string[]) => hook.rerender({ ids, ready: true }), unmount: hook.unmount };
  }

  it("never saves before the workspace is loaded", () => {
    const save = vi.fn(() => Promise.resolve());
    const hook = renderHook(({ ids, ready }) => useSaveWorkspaceOnChange(ids, ready, save), {
      initialProps: { ids: [] as string[], ready: false },
    });
    hook.rerender({ ids: ["a"], ready: false });
    hook.rerender({ ids: [], ready: false });
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS * 10);
    expect(save).not.toHaveBeenCalled();
  });

  it("writes the restored workspace as soon as it is loaded", () => {
    const save = vi.fn(() => Promise.resolve());
    const hook = renderHook(({ ids, ready }) => useSaveWorkspaceOnChange(ids, ready, save), {
      initialProps: { ids: ["restored"], ready: false },
    });
    hook.rerender({ ids: ["restored"], ready: true });
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(SAVE_AFTER_CHANGE_MS).toBeLessThan(1_000);
  });

  it("writes a loaded, empty workspace too", () => {
    const save = vi.fn(() => Promise.resolve());
    renderHook(() => useSaveWorkspaceOnChange([], true, save));
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves shortly after a session is created", () => {
    const { save, rerender } = setup(["a"]);
    rerender(["a", "b"]);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves shortly after a session is closed", () => {
    const { save, rerender } = setup(["a", "b"]);
    rerender(["a"]);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves when the last session is closed", () => {
    const { save, rerender } = setup(["a"]);
    rerender([]);
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not save when the sessions are only reordered or re-rendered", () => {
    const { save, rerender } = setup(["a", "b"]);
    rerender(["b", "a"]);
    rerender(["a", "b"]);
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS * 10);
    expect(save).not.toHaveBeenCalled();
  });

  it("writes several changes in a row once", () => {
    const { save, rerender } = setup(["a", "b", "c"]);
    rerender(["a", "b"]);
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS / 2);
    rerender(["a", "b", "d"]);
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS / 2);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("uses the latest save function", () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const hook = renderHook(({ ids, save }) => useSaveWorkspaceOnChange(ids, true, save), {
      initialProps: { ids: ["a", "b"], save: first },
    });
    hook.rerender({ ids: ["a"], save: second });
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not save after unmount and survives a failing save", async () => {
    const { save, rerender, unmount } = setup(["a", "b"]);
    rerender(["a"]);
    unmount();
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    expect(save).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(() => Promise.reject(new Error("disk full")));
    renderHook(() => useSaveWorkspaceOnChange(["x"], true, failing));
    vi.advanceTimersByTime(SAVE_AFTER_CHANGE_MS);
    await vi.runAllTimersAsync();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
