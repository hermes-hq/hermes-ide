// @vitest-environment jsdom
/**
 * useSessionProjects says when the active session's projects are known:
 * an empty list while they load is not "this session has no project"
 * (the Search panel flashed that, with its field off, on every open).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../api/projects", () => ({
  getSessionProjects: vi.fn(),
  attachSessionProject: vi.fn(),
  detachSessionProject: vi.fn(),
  getProjects: vi.fn(),
}));

import { getSessionProjects } from "../api/projects";
import { useSessionProjects } from "../hooks/useSessionProjects";

const getMock = getSessionProjects as unknown as ReturnType<typeof vi.fn>;
const project = (id: string) => ({ id, path: `/work-fixture/${id}`, name: id }) as never;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("useSessionProjects: loaded", () => {
  beforeEach(() => getMock.mockReset());

  it("is false until the session's projects arrive, then true", async () => {
    const d = deferred<unknown[]>();
    getMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useSessionProjects("s1"));
    expect(result.current.loaded).toBe(false);
    expect(result.current.projects).toEqual([]);
    await act(async () => d.resolve([project("p1")]));
    expect(result.current.loaded).toBe(true);
    expect(result.current.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("an empty answer is loaded (the session really has no project)", async () => {
    getMock.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useSessionProjects("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.projects).toEqual([]);
  });

  it("a failed read counts as loaded with no project", async () => {
    getMock.mockRejectedValueOnce(new Error("db"));
    const { result } = renderHook(() => useSessionProjects("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
  });

  it("switching sessions is not loaded until the new session's projects arrive", async () => {
    getMock.mockResolvedValueOnce([project("p1")]);
    const { result, rerender } = renderHook(({ id }) => useSessionProjects(id), { initialProps: { id: "s1" as string | null } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const d = deferred<unknown[]>();
    getMock.mockReturnValueOnce(d.promise);
    rerender({ id: "s2" });
    expect(result.current.loaded).toBe(false);
    await act(async () => d.resolve([]));
    expect(result.current.loaded).toBe(true);
    rerender({ id: null });
    expect(result.current.loaded).toBe(true);
  });
});
