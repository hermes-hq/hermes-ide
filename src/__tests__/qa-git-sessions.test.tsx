// @vitest-environment jsdom
/**
 * The git / session-close fixes of the QA sweep, at the component and logic
 * level (the real-app scenarios are e2e/app/scenarios/QA-git-*.mjs):
 *
 * - "Close session?" and "Kill Process" are modal alert dialogs: Enter on
 *   the focused Cancel closes nothing, Escape cancels, focus returns
 *   (NEWCOMER-01);
 * - the Uncommitted Changes dialog asks the right question: a check that
 *   failed, commits on no branch, edits inside a submodule, a worktree
 *   switched to another branch, a hook that refused (QAGIT-07/09/11/12/13/19);
 * - closeCheckEntry turns a failed check into a question (QAGIT-11);
 * - sessions that end together are kept (CHAOS-02);
 * - the Branch In Use choice can remove a leftover of this Hermes (QAGIT-10);
 * - errors are sentences (QAGIT-14), and the German packs leave no English
 *   in these dialogs (QAGIT-20).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  updateSettings: vi.fn(),
  writeScrollback: vi.fn(),
  estimateInitialDimensions: vi.fn(() => ({ rows: 24, cols: 80 })),
}));

import { CloseSessionDialog } from "../components/CloseSessionDialog";
import { KillConfirmDialog } from "../components/ProcessPanel";
import { BranchConflictDialog } from "../components/BranchConflictDialog";
import {
  DirtyWorktreeDialog,
  commitBranchLabel,
  detachedArchiveBranch,
  dirtyCloseMode,
  type DirtyWorktreeChange,
} from "../components/DirtyWorktreeDialog";
import { I18nProvider } from "../i18n/I18nProvider";
import { registerLanguagePack, setLanguage } from "../i18n/registry";
import { dePack } from "../i18n/packs/de";
import { closeCheckEntry, endedSessionsVerdict } from "../state/SessionContext";
import { createSessionWorktrees, parseBranchInUseError, describeBranchHolder } from "../state/isolation";
import { parseHookRefusal, parseUnmergedBranch, plainGitError } from "../utils/gitErrors";
import { endedSessionsMessage } from "../hooks/useSessionNoticeToasts";
import { worktreeErrorToastMessage } from "../hooks/useWorktreeErrorToasts";

afterEach(() => cleanup());

const key = (k: string, opts: KeyboardEventInit = {}) =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  });

describe("Close session? (NEWCOMER-01)", () => {
  function open(props: Partial<Parameters<typeof CloseSessionDialog>[0]> = {}) {
    const opener = document.createElement("button");
    opener.className = "session-item-close";
    document.body.appendChild(opener);
    opener.focus();
    const handlers = { onConfirm: vi.fn(), onCancel: vi.fn(), onDontAskAgain: vi.fn() };
    const view = render(
      <I18nProvider>
        <CloseSessionDialog sessionId="s1" sessionMode="terminal" label="Fix the build" agentName="Claude Code" {...handlers} {...props} />
      </I18nProvider>,
    );
    return { ...handlers, view, opener };
  }

  it("is a modal alert dialog, labelled and described, with the confirm focused", () => {
    open();
    const d = screen.getByRole("alertdialog");
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(d).toHaveAccessibleName("Close “Fix the build”?");
    expect(d).toHaveAccessibleDescription("Claude Code is still running in it. Closing stops it.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close session" }));
  });

  it("says 'a program' when no agent runs in a terminal", () => {
    open({ agentName: null });
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription("A program is still running in it. Closing stops it.");
  });

  it("Enter on the focused Cancel confirms nothing; Escape cancels; focus goes back", () => {
    const h = open();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    key("Enter");
    expect(h.onConfirm).not.toHaveBeenCalled();
    key("Escape");
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    h.view.unmount();
    expect(document.activeElement).toBe(h.opener);
    h.opener.remove();
  });

  it("Tab stays inside", () => {
    open();
    const d = screen.getByRole("alertdialog");
    for (let i = 0; i < 5; i++) key("Tab");
    expect(d.contains(document.activeElement)).toBe(true);
    key("Tab", { shiftKey: true });
    expect(d.contains(document.activeElement)).toBe(true);
  });
});

describe("Kill Process (NEWCOMER-01, same rules)", () => {
  it("is a modal alert dialog; Enter on Cancel kills nothing; Escape cancels", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<KillConfirmDialog processName="node" pid={42} signal="SIGTERM" isTree={false} onConfirm={onConfirm} onCancel={onCancel} skipConfirm={false} onToggleSkip={vi.fn()} />);
    const d = screen.getByRole("alertdialog");
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Kill" }));
    screen.getByRole("button", { name: "Cancel" }).focus();
    key("Enter");
    expect(onConfirm).not.toHaveBeenCalled();
    key("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

const base: DirtyWorktreeChange = { projectId: "p1", projectName: "demo-app", branchName: "hermes/task-a", files: [{ path: "a.txt", status: "modified" }] };
const noop = { onStashAndClose: vi.fn(), onCloseAnyway: vi.fn(), onCancel: vi.fn() };

describe("Uncommitted Changes: the right question", () => {
  it("picks one mode from what the check found", () => {
    expect(dirtyCloseMode([base], false)).toBe("changes");
    expect(dirtyCloseMode([{ ...base, checkError: "index is damaged" }], false)).toBe("check-failed");
    expect(dirtyCloseMode([{ ...base, files: [], detached: true, lostCommits: 1 }], false)).toBe("detached");
    expect(dirtyCloseMode([{ ...base, files: [], dirtySubmodules: ["vendor/lib"] }], false)).toBe("keep-only");
    expect(dirtyCloseMode([{ ...base, files: [], operation: "bisect" }], false)).toBe("keep-only");
    expect(dirtyCloseMode([base], true)).toBe("hook-refused");
    expect(detachedArchiveBranch("hermes/bisect-build")).toBe("hermes-archive/bisect-build-detached");
  });

  it("a failed check keeps the worktree by default (QAGIT-11)", () => {
    const onKeepAndClose = vi.fn();
    render(<DirtyWorktreeDialog sessionId="s1" sessionLabel="One" variant="commit" changes={[{ ...base, files: [], checkError: "failed to read index" }]} onKeepAndClose={onKeepAndClose} {...noop} />);
    expect(screen.getByText("Could not check demo-app for uncommitted changes: failed to read index")).toBeInTheDocument();
    const keep = screen.getByRole("button", { name: "Keep the worktree and close" });
    expect(keep.className).toContain("h-btn--primary");
    expect(screen.getByRole("button", { name: "Delete anyway" })).toBeInTheDocument();
    fireEvent.click(keep);
    expect(onKeepAndClose).toHaveBeenCalled();
  });

  it("commits on no branch: save on hermes-archive/…-detached (QAGIT-09)", () => {
    const onSave = vi.fn();
    render(
      <DirtyWorktreeDialog sessionId="s1" sessionLabel="One" variant="commit" changes={[{ ...base, files: [], detached: true, lostCommits: 1 }]} onSaveDetachedAndClose={onSave} {...noop} />,
    );
    expect(screen.getByText("1 commit is on no branch (detached HEAD)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save on hermes-archive/task-a-detached & close" }));
    expect(onSave).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Discard and close" })).toBeInTheDocument();
  });

  it("edits inside a submodule: named, and Keep the worktree (QAGIT-19)", () => {
    render(<DirtyWorktreeDialog sessionId="s1" sessionLabel="One" variant="commit" changes={[{ ...base, files: [], dirtySubmodules: ["vendor/lib"] }]} onKeepAndClose={vi.fn()} {...noop} />);
    expect(
      screen.getByText("vendor/lib has uncommitted changes inside the submodule; Hermes cannot commit those — commit them in the submodule or keep the worktree."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no changes to commit/i)).toBeNull();
  });

  it("a worktree switched to another branch: the button names where the commit goes (QAGIT-07)", () => {
    const moved = { ...base, actualBranch: "feature/inbox" };
    expect(commitBranchLabel([moved])).toEqual({ branch: "feature/inbox", switchedFrom: "hermes/task-a" });
    expect(commitBranchLabel([base])).toBeNull();
    render(<DirtyWorktreeDialog sessionId="s1" sessionLabel="One" variant="commit" changes={[moved]} onCommitAndClose={vi.fn()} onArchiveAndClose={vi.fn()} {...noop} />);
    expect(screen.getByText("This task's worktree was switched from hermes/task-a to feature/inbox.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit to feature/inbox & close" })).toBeInTheDocument();
  });

  it("says the agent is stopped first (QAGIT-12) and shows a refusing hook as it spoke (QAGIT-13)", () => {
    const onArchive = vi.fn();
    render(
      <DirtyWorktreeDialog
        sessionId="s1" sessionLabel="One" variant="commit" changes={[base]} agentWorking
        hookRefusal={{ projectName: "demo-app", hook: "pre-commit", output: "eslint: 3 problems" }}
        onArchiveAndClose={onArchive} {...noop}
      />,
    );
    expect(screen.getByText("The agent is still working — it will be stopped before its changes are saved.")).toBeInTheDocument();
    expect(screen.getByText("pre-commit refused: eslint: 3 problems")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive instead" }));
    expect(onArchive).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});

describe("closeCheckEntry (QAGIT-11)", () => {
  it("a failing check is a question, never a silent delete", async () => {
    const entry = await closeCheckEntry("s1", { id: "p1", name: "demo-app" }, "hermes/x", async () => {
      throw new Error("failed to read index; class=Index (10); code=GenericError (-1)");
    });
    expect(entry).toMatchObject({ projectId: "p1", projectName: "demo-app", files: [], checkError: "failed to read index" });
  });

  it("asks about commits on no branch and operations even with a clean tree", async () => {
    const head = { branch: null, detached: true, head: "abc", lostCommits: 2, operation: null, dirtySubmodules: [] };
    const entry = await closeCheckEntry("s1", { id: "p1", name: "demo-app" }, "hermes/x", async () => ({ has_changes: false, files: [], head }));
    expect(entry).toMatchObject({ detached: true, lostCommits: 2, actualBranch: null });
    const clean = await closeCheckEntry("s1", { id: "p1", name: "demo-app" }, "hermes/x", async () => ({
      has_changes: false,
      files: [],
      head: { ...head, detached: false, lostCommits: 0, branch: "hermes/x" },
    }));
    expect(clean).toBeNull();
  });
});

describe("sessions that end on their own (CHAOS-02)", () => {
  it("one program that ends closes; several at once, or the service gone, are kept", () => {
    expect(endedSessionsVerdict({ count: 1, hostGone: false })).toBe("close");
    expect(endedSessionsVerdict({ count: 2, hostGone: false })).toBe("keep");
    expect(endedSessionsVerdict({ count: 1, hostGone: true })).toBe("keep");
  });

  it("one notice for all of them", () => {
    expect(endedSessionsMessage([{ id: "a", label: "A" }, { id: "b", label: "B" }], "service")).toBe(
      "2 sessions ended. The terminal service stopped unexpectedly. Their output is kept.",
    );
    expect(endedSessionsMessage([{ id: "a", label: "A" }], "killed", 9)).toBe("“A” ended. The program was killed (signal 9). Its output is kept.");
  });
});

describe("Branch In Use: a leftover of this Hermes (QAGIT-10)", () => {
  it("is called a leftover, and Remove it and retry uses its branch", async () => {
    const err = `BRANCH_IN_USE:${JSON.stringify({ branch: "hermes/x", path: "/data/hermes-worktrees/h/s_x", sessionId: null, projectFolder: false, leftover: true })}`;
    const conflict = parseBranchInUseError(err)!;
    expect(conflict.leftover).toBe(true);
    expect(describeBranchHolder(conflict, null)).toBe("a leftover Hermes worktree");
    const calls: string[] = [];
    let first = true;
    const outcome = await createSessionWorktrees("s1", ["p1"], { p1: { branch: "hermes/x", createNew: true } }, {
      createWorktree: async (_s, _p, branch, createNew) => {
        calls.push(`create ${branch} ${createNew}`);
        if (first) {
          first = false;
          throw new Error(err);
        }
        return { worktreePath: "/w", branchName: branch, isMainWorktree: false };
      },
      attachWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      detachWorktree: vi.fn(),
      removeLeftover: async (_p, path) => {
        calls.push(`remove ${path}`);
      },
      resolveConflict: async () => ({ kind: "remove-leftover" }),
    });
    expect(outcome.succeeded).toBe(1);
    expect(calls).toEqual(["create hermes/x true", "remove /data/hermes-worktrees/h/s_x", "create hermes/x false"]);
  });

  it("the dialog offers Remove it and retry only for a leftover", () => {
    const onRemoveLeftover = vi.fn();
    const handlers = { onReuse: vi.fn(), onCreateNewBranch: vi.fn(), onCancel: vi.fn() };
    render(<BranchConflictDialog branchName="hermes/x" heldBy="a leftover Hermes worktree" path="/w" onRemoveLeftover={onRemoveLeftover} {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove it and retry" }));
    expect(onRemoveLeftover).toHaveBeenCalled();
  });
});

describe("errors in words (QAGIT-14, QAGIT-05, QAGIT-13)", () => {
  it("drops libgit2 codes and ids, and names projects", () => {
    expect(plainGitError("7c9e6679-7425-40de-944b-e07fc1f90ae7: Failed to create branch 'x': cannot lock ref; class=Reference (4); code=Locked (-14)")).toBe(
      "Failed to create branch 'x': cannot lock ref",
    );
    expect(plainGitError("p-1: fresh-repo has no commits yet. Make a first commit, or continue without isolation.", { "p-1": "fresh-repo" })).toBe(
      "fresh-repo has no commits yet. Make a first commit, or continue without isolation.",
    );
    const toast = worktreeErrorToastMessage(["demo: x; class=Reference (4); code=InvalidSpec (-12)"], true);
    expect(toast).not.toMatch(/class=|code=/);
  });

  it("reads the structured refusals", () => {
    expect(parseHookRefusal(`HOOK_REFUSED:${JSON.stringify({ hook: "commit-msg", output: "too long" })}`)).toEqual({ hook: "commit-msg", output: "too long" });
    expect(parseUnmergedBranch(`BRANCH_UNMERGED:${JSON.stringify({ branch: "hermes/old", base: "main", commits: 2 })}`)).toEqual({ branch: "hermes/old", base: "main", commits: 2 });
    expect(parseHookRefusal("Commit failed: x")).toBeNull();
  });
});

describe("German: no English left in these dialogs (QAGIT-20)", () => {
  it("Uncommitted Changes and Branch In Use speak German", async () => {
    const pack = registerLanguagePack(dePack);
    await setLanguage("de");
    try {
      const { container } = render(
        <DirtyWorktreeDialog sessionId="s1" sessionLabel="Eins" variant="commit" changes={[base]} onCommitAndClose={vi.fn()} onArchiveAndClose={vi.fn()} {...noop} />,
      );
      const text = container.textContent ?? "";
      for (const english of ["Uncommitted Changes", "Commit to session branch", "Discard changes and close", "Archive (keep branch)", "Cancel", "modified", "Closing this session"]) {
        expect(text, english).not.toContain(english);
      }
      expect(text).toContain("Nicht übernommene Änderungen");
      expect(text).toContain("In den Sitzungs-Branch committen und schließen");
      cleanup();
      const conflict = render(
        <BranchConflictDialog branchName="feature/inbox" heldBy="the project folder" path="/w" onReuse={vi.fn()} onCreateNewBranch={vi.fn()} onCancel={vi.fn()} />,
      );
      const t2 = conflict.container.textContent ?? "";
      for (const english of ["Branch In Use", "is already checked out by", "Use new branch", "Reuse its checkout", "Cancel"]) {
        expect(t2, english).not.toContain(english);
      }
      expect(t2).toContain("Branch wird verwendet");
    } finally {
      await setLanguage("en");
      pack.dispose();
    }
  });
});
