// @vitest-environment jsdom
/**
 * The stash list follows the stash count: a stash made elsewhere (an agent
 * in the terminal, another worktree of the same repository) renumbers every
 * entry, and Drop/Pop/Apply act by position, so a stale list would drop the
 * wrong stash.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { GitStashEntry } from "../types/git";

const api = vi.hoisted(() => ({
  gitStashList: vi.fn(),
  gitStashSave: vi.fn(),
  gitStashApply: vi.fn(),
  gitStashPop: vi.fn(),
  gitStashDrop: vi.fn(),
  gitStashClear: vi.fn(),
}));
vi.mock("../api/git", () => api);
vi.mock("../hooks/useContextMenu", () => ({
  useContextMenu: () => ({ showMenu: vi.fn() }),
  buildStashMenuItems: () => [],
}));

import { GitStashSection } from "../components/GitStashSection";

const A: GitStashEntry = { index: 0, message: "On main: stash A", timestamp: 1700000000, branch_name: "main" };
const B: GitStashEntry = { index: 0, message: "On main: stash B", timestamp: 1700000100, branch_name: "main" };

function section(stashCount: number) {
  return (
    <GitStashSection
      sessionId="s1"
      projectId="p1"
      stashCount={stashCount}
      hasChanges={false}
      onRefresh={() => {}}
      onToast={() => {}}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GitStashSection when stashes change elsewhere", () => {
  it("reloads when the count changes, so Drop goes to the stash the row shows", async () => {
    api.gitStashList.mockResolvedValue([A]);
    api.gitStashDrop.mockResolvedValue({ success: true, message: "Dropped", error: null });
    const { rerender } = render(section(1));
    await screen.findByText("stash A");

    // An agent runs `git stash`: B is now stash@{0} and A stash@{1}.
    api.gitStashList.mockResolvedValue([B, { ...A, index: 1 }]);
    rerender(section(2));
    await screen.findByText("stash B");

    const rowA = screen.getByText("stash A").closest(".git-stash-entry") as HTMLElement;
    expect(rowA).toHaveTextContent("stash@{1}");
    fireEvent.click(rowA.querySelector(".git-stash-btn-drop")!);
    fireEvent.click(rowA.querySelector(".git-branch-delete-yes")!);
    await waitFor(() => expect(api.gitStashDrop).toHaveBeenCalled());
    expect(api.gitStashDrop).toHaveBeenCalledWith("s1", "p1", 1);
  });

  it("closes a Drop confirm left open when the count changes", async () => {
    api.gitStashList.mockResolvedValue([A]);
    const { rerender, container } = render(section(1));
    await screen.findByText("stash A");
    fireEvent.click(container.querySelector(".git-stash-btn-drop")!);
    expect(container.querySelector(".git-stash-entry .git-branch-delete-yes")).not.toBeNull();

    api.gitStashList.mockResolvedValue([B, { ...A, index: 1 }]);
    rerender(section(2));
    await screen.findByText("stash B");
    expect(container.querySelector(".git-stash-entry .git-branch-delete-yes")).toBeNull();
  });
});
