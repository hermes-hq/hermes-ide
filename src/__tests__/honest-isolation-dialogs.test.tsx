// @vitest-environment jsdom
/**
 * F09 — honest isolation: the blocking branch-in-use choice, the new close
 * choices, and the hermes/<slug> default in the branch picker, rendered.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { BranchConflictDialog, validateNewBranchName } from "../components/BranchConflictDialog";
import { DirtyWorktreeDialog } from "../components/DirtyWorktreeDialog";
import { SessionBranchSelector } from "../components/SessionBranchSelector";
import { I18nProvider } from "../i18n/I18nProvider";

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe("BranchConflictDialog", () => {
  function renderDialog() {
    const handlers = { onReuse: vi.fn(), onCreateNewBranch: vi.fn(), onCancel: vi.fn() };
    const view = render(
      <BranchConflictDialog branchName="hermes/task-a" heldBy='session "One"' path="/tmp/hermes-test/wt" {...handlers} />,
    );
    return { ...handlers, view };
  }

  it("offers reuse, a -2 branch and cancel", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toHaveTextContent('already checked out by session "One"');
    expect(screen.getByLabelText("New branch name")).toHaveValue("hermes/task-a-2");
    expect(screen.getByRole("button", { name: "Reuse its checkout" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use new branch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("each button reports its own choice", () => {
    const h = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Use new branch" }));
    expect(h.onCreateNewBranch).toHaveBeenCalledWith("hermes/task-a-2");
    fireEvent.click(screen.getByRole("button", { name: "Reuse its checkout" }));
    expect(h.onReuse).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("is blocking: clicking outside chooses nothing; Escape cancels", () => {
    const h = renderDialog();
    fireEvent.click(h.view.container.querySelector(".branch-conflict-overlay")!);
    expect(h.onCancel).not.toHaveBeenCalled();
    expect(h.onReuse).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty, spaced or identical new name", () => {
    const h = renderDialog();
    const input = screen.getByLabelText("New branch name");
    fireEvent.change(input, { target: { value: "hermes/task-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Use new branch" }));
    expect(screen.getByText("New branch must have a different name")).toBeInTheDocument();
    expect(h.onCreateNewBranch).not.toHaveBeenCalled();
    expect(validateNewBranchName("", "x")).toBe("Branch name cannot be empty");
    expect(validateNewBranchName("a b", "x")).toBe("Branch name cannot contain spaces");
    expect(validateNewBranchName(" y ", "x")).toBeNull();
  });
});

describe("DirtyWorktreeDialog", () => {
  const changes = [{ projectId: "p1", projectName: "repo", branchName: "hermes/task-a", files: [{ path: "a.txt", status: "modified" }] }];

  it("with honest isolation: commit or archive, and no Stash & Close", async () => {
    const onCommitAndClose = vi.fn(async () => undefined);
    const onArchiveAndClose = vi.fn(async () => undefined);
    const onStashAndClose = vi.fn();
    render(
      <DirtyWorktreeDialog
        sessionId="s1" sessionLabel="One" changes={changes} variant="commit"
        onStashAndClose={onStashAndClose} onCommitAndClose={onCommitAndClose} onArchiveAndClose={onArchiveAndClose}
        onCloseAnyway={vi.fn()} onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Stash/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Commit to session branch & close" }));
    await waitFor(() => expect(onCommitAndClose).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Archive (keep branch)" }));
    await waitFor(() => expect(onArchiveAndClose).toHaveBeenCalledTimes(1));
    expect(onStashAndClose).not.toHaveBeenCalled();
  });

  it("names the failed action", () => {
    render(
      <DirtyWorktreeDialog
        sessionId="s1" sessionLabel="One" changes={changes} variant="commit"
        stashErrors={[{ projectName: "repo", error: "nope" }]}
        onStashAndClose={vi.fn()} onCloseAnyway={vi.fn()} onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/Could not save repo:/)).toBeInTheDocument();
  });

  it("without the flag it is unchanged (Stash & Close)", () => {
    render(
      <DirtyWorktreeDialog
        sessionId="s1" sessionLabel="One" changes={changes}
        onStashAndClose={vi.fn()} onCloseAnyway={vi.fn()} onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Stash & Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Commit to session branch/ })).toBeNull();
  });
});

describe("SessionBranchSelector with a task slug", () => {
  function mockBackend(branches: string[], current: string) {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_list_branches_for_project") {
        return branches.map((name) => ({ name, is_remote: false, is_current: name === current, last_commit_summary: null }));
      }
      if (cmd === "git_list_worktrees") return [];
      return undefined;
    });
  }

  it("defaults to a NEW hermes/<slug> branch instead of the current branch", async () => {
    mockBackend(["main", "dev"], "main");
    const onBranchSelected = vi.fn();
    render(
      <SessionBranchSelector projectId="p1" defaultTaskSlug="task-ab12" onBranchSelected={onBranchSelected} onSkip={() => {}} />,
      { wrapper: I18nProvider },
    );
    await waitFor(() => expect(onBranchSelected).toHaveBeenCalledWith("hermes/task-ab12", true));
    expect(onBranchSelected).toHaveBeenCalledTimes(1);
    // Editable: the New branch tab is open and filled in.
    expect(screen.getByPlaceholderText("feature/my-branch")).toHaveValue("hermes/task-ab12");
  });

  it("picks a free name when hermes/<slug> already exists", async () => {
    mockBackend(["main", "hermes/task-ab12"], "main");
    const onBranchSelected = vi.fn();
    render(
      <SessionBranchSelector projectId="p1" defaultTaskSlug="task-ab12" onBranchSelected={onBranchSelected} onSkip={() => {}} />,
      { wrapper: I18nProvider },
    );
    await waitFor(() => expect(onBranchSelected).toHaveBeenCalledWith("hermes/task-ab12-2", true));
  });

  it("without a slug keeps the old default (the current branch)", async () => {
    mockBackend(["main", "dev"], "main");
    const onBranchSelected = vi.fn();
    render(
      <SessionBranchSelector projectId="p1" onBranchSelected={onBranchSelected} onSkip={() => {}} />,
      { wrapper: I18nProvider },
    );
    await waitFor(() => expect(onBranchSelected).toHaveBeenCalledWith("main", false));
  });
});
