// @vitest-environment jsdom
/**
 * The Context panel lists the pins the agent's context file uses, project
 * pins included, and refreshes them when that changes.
 *
 * Was broken: the panel asked for the session's pins with no project, so a
 * pin saved for the project (the panel's default scope) was never listed,
 * and attaching another project left the list as it was.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const handlers = new Map<string, () => void>();
const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: () => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

import { useContextState } from "../hooks/useContextState";
import type { SessionData } from "../state/SessionContext";

const session = {
  id: "s1",
  working_directory: "/work/one",
  workspace_paths: [],
  detected_agent: null,
  metrics: { memory_facts: [], files_touched: [], recent_errors: [] },
} as unknown as SessionData;

const pin = (id: number, scope: { session_id?: string; project_id?: string }) => ({
  id, session_id: scope.session_id ?? null, project_id: scope.project_id ?? null,
  kind: "file", target: `/work/${id}.md`, label: null, priority: 128, created_at: 0,
});

let pins: ReturnType<typeof pin>[] = [];

beforeEach(() => {
  handlers.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_context_pins") return pins;
    if (cmd === "assemble_session_context") return { projects: [], token_budget: 4000, estimated_tokens: 0 };
    if (cmd === "get_all_memory") return [];
    return null;
  });
});

describe("Context panel pins", () => {
  it("asks for the session's pins and lets the backend add its project's", async () => {
    pins = [pin(1, { session_id: "s1" }), pin(2, { project_id: "p1" })];
    const { result } = renderHook(() => useContextState(session));
    await waitFor(() => expect(result.current.context.pinnedItems.map((p) => p.id)).toEqual([1, 2]));
    expect(invoke).toHaveBeenCalledWith("get_context_pins", { sessionId: "s1", projectId: null });
  });

  it("lists the pins again when a pin changes and when the session's projects change", async () => {
    pins = [pin(1, { session_id: "s1" })];
    const { result } = renderHook(() => useContextState(session));
    await waitFor(() => expect(result.current.context.pinnedItems).toHaveLength(1));
    await waitFor(() => expect(handlers.has("context-pins-changed-s1") && handlers.has("session-projects-updated-s1")).toBe(true));

    pins = [pin(1, { session_id: "s1" }), pin(2, { project_id: "p1" })];
    act(() => handlers.get("context-pins-changed-s1")!());
    await waitFor(() => expect(result.current.context.pinnedItems.map((p) => p.id)).toEqual([1, 2]));

    // Another project became the primary one: its pins replace the old project's.
    pins = [pin(1, { session_id: "s1" }), pin(3, { project_id: "p2" })];
    act(() => handlers.get("session-projects-updated-s1")!());
    await waitFor(() => expect(result.current.context.pinnedItems.map((p) => p.id)).toEqual([1, 3]));
  });
});
