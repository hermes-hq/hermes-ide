// @vitest-environment jsdom
/** C0 contracts: the attention inbox store (no UI). */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  _resetInboxForTest,
  INBOX_KINDS,
  isInboxKind,
  listInboxItems,
  raiseInboxItem,
  raiseInboxItemFromPlugin,
  resolveInboxItem,
  resolveInboxItemsForSession,
  subscribeInbox,
  useInboxItems,
} from "../agent/contract/inbox";

let now = 1000;
beforeEach(() => {
  now = 1000;
  _resetInboxForTest(() => now++);
});

describe("the inbox", () => {
  it("has the five kinds of the contract", () => {
    expect(INBOX_KINDS).toEqual(["blocked", "ready", "gate", "error", "limit"]);
    expect(isInboxKind("gate")).toBe(true);
    expect(isInboxKind("todo")).toBe(false);
    expect(() => raiseInboxItem({ kind: "todo" as never, detail: "x", source: "test" })).toThrow(/unknown inbox kind/);
  });

  it("lists raised items oldest first with an id, a time and a source", () => {
    const a = raiseInboxItem({ kind: "blocked", sessionId: "s1", detail: "Bash: rm -rf build", source: "status" });
    const b = raiseInboxItem({ kind: "gate", detail: "plan", source: "track" });
    expect(listInboxItems()).toEqual([a, b]);
    expect(a).toEqual({ id: "inbox-1", kind: "blocked", sessionId: "s1", detail: "Bash: rm -rf build", createdAt: 1000, source: "status" });
    expect(b.sessionId).toBeNull();
    expect(b.createdAt).toBe(1001);
    expect(Object.isFrozen(listInboxItems())).toBe(true);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("returns the open item instead of raising the same thing twice", () => {
    const a = raiseInboxItem({ kind: "blocked", sessionId: "s1", detail: "same", source: "status" });
    const again = raiseInboxItem({ kind: "blocked", sessionId: "s1", detail: "same", source: "plugin:x" });
    expect(again).toBe(a);
    expect(listInboxItems()).toHaveLength(1);
    raiseInboxItem({ kind: "blocked", sessionId: "s1", detail: "other", source: "status" });
    raiseInboxItem({ kind: "ready", sessionId: "s1", detail: "same", source: "status" });
    expect(listInboxItems()).toHaveLength(3);
  });

  it("resolves by id, once", () => {
    const a = raiseInboxItem({ kind: "error", sessionId: "s1", detail: "setup failed", source: "worktree" });
    expect(resolveInboxItem(a.id)).toBe(true);
    expect(resolveInboxItem(a.id)).toBe(false);
    expect(listInboxItems()).toEqual([]);
    // Raising the same detail after resolving makes a new item.
    expect(raiseInboxItem({ kind: "error", sessionId: "s1", detail: "setup failed", source: "worktree" }).id).toBe("inbox-2");
  });

  it("resolves everything about a closed session", () => {
    raiseInboxItem({ kind: "blocked", sessionId: "s1", detail: "a", source: "status" });
    raiseInboxItem({ kind: "limit", sessionId: "s1", detail: "b", source: "cap" });
    const keep = raiseInboxItem({ kind: "blocked", sessionId: "s2", detail: "c", source: "status" });
    expect(resolveInboxItemsForSession("s1")).toBe(2);
    expect(resolveInboxItemsForSession("s1")).toBe(0);
    expect(listInboxItems()).toEqual([keep]);
  });

  it("stamps a plugin's items with the plugin's id, never the plugin's own word", () => {
    const item = raiseInboxItemFromPlugin("license-scan", { kind: "gate", detail: "3 files need a license header" });
    expect(item.source).toBe("plugin:license-scan");
    expect(item.sessionId).toBeNull();
  });

  it("tells subscribers on every change and keeps the list stable between changes", () => {
    const l = vi.fn();
    const off = subscribeInbox(l);
    const before = listInboxItems();
    expect(listInboxItems()).toBe(before);
    const a = raiseInboxItem({ kind: "ready", sessionId: "s1", detail: "done", source: "status" });
    expect(l).toHaveBeenCalledTimes(1);
    raiseInboxItem({ kind: "ready", sessionId: "s1", detail: "done", source: "status" }); // duplicate: no change
    expect(l).toHaveBeenCalledTimes(1);
    resolveInboxItem(a.id);
    expect(l).toHaveBeenCalledTimes(2);
    off();
    raiseInboxItem({ kind: "ready", sessionId: "s1", detail: "x", source: "status" });
    expect(l).toHaveBeenCalledTimes(2);
  });

  it("re-renders a component on every change (useInboxItems)", () => {
    const { result } = renderHook(() => useInboxItems());
    expect(result.current).toEqual([]);
    let raised!: { id: string };
    act(() => {
      raised = raiseInboxItem({ kind: "blocked", sessionId: "s1", detail: "a", source: "status" });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe(raised.id);
    act(() => {
      resolveInboxItem(raised.id);
    });
    expect(result.current).toEqual([]);
  });
});
