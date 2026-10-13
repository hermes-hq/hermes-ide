// @vitest-environment jsdom
/**
 * The project picker tells the agent about a change (the projects nudge)
 * when it closes. The row shows a project attached before the attach has
 * finished, and Done pressed then used to close the picker without any
 * nudge: the change was only recorded once the attach returned.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({
  nudge: vi.fn(() => Promise.resolve("sent" as const)),
  attach: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../api/projects", () => ({
  getProjectsOrdered: () =>
    Promise.resolve([
      { id: "p2", name: "dev-to-posts", path: "/fixture-home/dev-to-posts", languages: [], frameworks: [], scan_status: "surface", session_count: 0, last_opened_at: null, path_exists: true },
    ]),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  nudgeProjectContext: api.nudge,
}));
vi.mock("../hooks/useSessionProjects", () => ({
  useSessionProjects: () => ({ projects: [], loaded: true, attach: api.attach, detach: vi.fn() }),
}));

import { ProjectPicker } from "../components/ProjectPicker";

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("ProjectPicker — the projects nudge", () => {
  afterEach(() => {
    cleanup();
    api.nudge.mockClear();
    api.attach.mockReset();
  });

  it("Done while an attach is still running nudges once it has finished", async () => {
    let finish: () => void = () => {};
    api.attach.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const onClose = vi.fn();
    render(<ProjectPicker sessionId="s1" onClose={onClose} />);
    fireEvent.click(await screen.findByText("dev-to-posts"));
    expect(api.attach).toHaveBeenCalledWith("p2");

    fireEvent.click(screen.getByText("Done"));
    expect(onClose).toHaveBeenCalled();
    await flush();
    expect(api.nudge).not.toHaveBeenCalled();

    await act(async () => finish());
    await flush();
    expect(api.nudge).toHaveBeenCalledTimes(1);
    expect(api.nudge).toHaveBeenCalledWith("s1");
  });

  it("closing without a change sends no nudge", async () => {
    const onClose = vi.fn();
    render(<ProjectPicker sessionId="s1" onClose={onClose} />);
    await screen.findByText("dev-to-posts");
    fireEvent.click(screen.getByText("Done"));
    await flush();
    expect(onClose).toHaveBeenCalled();
    expect(api.nudge).not.toHaveBeenCalled();
  });
});
