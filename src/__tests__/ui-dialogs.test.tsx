// @vitest-environment jsdom
/**
 * UI-D: the dialog long tail on the control set. Each dialog is rendered and
 * its buttons are read back from the DOM: at most one primary (brass) or,
 * in a confirm dialog, one danger-solid button, placed right-most among its
 * actions; close buttons are the one CloseButton with a name; checkboxes are
 * the kit's; and pressing each button still does what it did.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactElement } from "react";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { I18nProvider } from "../i18n/I18nProvider";
import { CloseSessionDialog } from "../components/CloseSessionDialog";
import { QuitWithAgentsDialog } from "../components/QuitWithAgentsDialog";
import { UpdateDialog } from "../components/UpdateDialog";
import { PluginUpdateConfirmDialog } from "../components/PluginUpdateConfirmDialog";
import { BranchConflictDialog } from "../components/BranchConflictDialog";
import { DirtyWorktreeDialog } from "../components/DirtyWorktreeDialog";
import { PermissionRequestModal } from "../components/PermissionRequestModal";
import { ToastContainer } from "../components/ToastContainer";
import { KillConfirmDialog } from "../components/ProcessPanel";
import type { UpdateState } from "../hooks/useAutoUpdater";

afterEach(() => cleanup());

const wrap = (ui: ReactElement) => render(ui, { wrapper: I18nProvider });

/** The emphasised buttons of a surface: brass primary, or a confirm's danger-solid. */
function strongButtons(root: ParentNode = document) {
  return [...root.querySelectorAll<HTMLButtonElement>(".h-btn--primary, .h-btn--danger-solid")];
}

/** Every button of an action row is a kit button and the strong one, if any, is the last. */
function expectActionRow(row: Element | null, strong: "primary" | "danger-solid" | null) {
  expect(row).not.toBeNull();
  const buttons = [...row!.querySelectorAll("button")];
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) expect(b.className).toMatch(/\bh-btn\b/);
  const strongOnes = strongButtons(row!);
  if (strong === null) {
    expect(strongOnes).toHaveLength(0);
    return;
  }
  expect(strongOnes).toHaveLength(1);
  expect(strongOnes[0].className).toContain(`h-btn--${strong}`);
  expect(buttons[buttons.length - 1]).toBe(strongOnes[0]);
}

const baseUpdate: UpdateState = {
  available: true,
  version: "9.9.9",
  notes: "",
  downloading: false,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  ready: false,
  dismissed: false,
  dismissedVersion: "",
  error: false,
  stalled: false,
  installing: false,
  busySessionCount: 0,
} as UpdateState;

describe("close, quit and update", () => {
  it("closing a session: Cancel, then the danger-solid confirm; the kit checkbox remembers 'don't ask'", () => {
    const onConfirm = vi.fn();
    const onDontAskAgain = vi.fn();
    wrap(<CloseSessionDialog sessionId="s1" sessionMode="terminal" onConfirm={onConfirm} onCancel={vi.fn()} onDontAskAgain={onDontAskAgain} />);
    expectActionRow(document.querySelector(".close-dialog-actions"), "danger-solid");
    const box = screen.getByRole("checkbox");
    expect(box).toHaveClass("h-checkbox");
    fireEvent.click(box);
    fireEvent.click(document.querySelector(".close-dialog-btn-confirm")!);
    expect(onDontAskAgain).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("s1");
  });

  it("quitting with agents: Keep running is the one primary, Stop is danger, not solid", () => {
    const onStop = vi.fn();
    wrap(<QuitWithAgentsDialog sessions={[{ id: "a", label: "Task" }]} onKeep={vi.fn()} onStop={onStop} onCancel={vi.fn()} />);
    expectActionRow(document.querySelector(".quit-dialog-actions"), "primary");
    const stop = screen.getByRole("button", { name: /stop/i });
    expect(stop).toHaveClass("h-btn--danger");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["available", {}, "Update Now"],
    ["ready", { ready: true, progress: 100 }, "Install & Relaunch"],
    ["waiting for agents", { ready: true, progress: 100, busySessionCount: 2 }, "Relaunch now"],
  ])("update %s: one primary, right-most, named %s", (_what, patch, name) => {
    render(
      <UpdateDialog state={{ ...baseUpdate, ...patch } as UpdateState} onDismiss={vi.fn()} onDownload={vi.fn()} onCancel={vi.fn()} onInstall={vi.fn()} onRelaunchNow={vi.fn()} />,
    );
    expectActionRow(document.querySelector(".update-dialog-actions"), "primary");
    expect(strongButtons()[0]).toHaveAccessibleName(name);
  });

  it("update downloading: the primary shows progress and cannot be pressed again", () => {
    const onDownload = vi.fn();
    render(
      <UpdateDialog state={{ ...baseUpdate, downloading: true, progress: 40 }} onDismiss={vi.fn()} onDownload={onDownload} onCancel={vi.fn()} onInstall={vi.fn()} onRelaunchNow={vi.fn()} />,
    );
    const primary = strongButtons()[0];
    expect(primary).toHaveAttribute("aria-busy", "true");
    fireEvent.click(primary);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("plugin update confirm: Update is the one primary", () => {
    const onConfirm = vi.fn();
    render(
      <PluginUpdateConfirmDialog
        plugins={[{ id: "p", name: "Sample", currentVersion: "1.0.0", newVersion: "1.1.0", downloadUrl: "https://example.invalid/p.tgz" }]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expectActionRow(document.querySelector(".puc-footer"), "primary");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("worktree dialogs", () => {
  it("branch in use: a named close, a code field with its error, one primary", () => {
    render(<BranchConflictDialog branchName="main" heldBy="the project folder" path="/tmp/x" onReuse={vi.fn()} onCreateNewBranch={vi.fn()} onCancel={vi.fn()} />);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveClass("h-close-btn");
    expect(strongButtons()).toHaveLength(1);
    expect(strongButtons()[0]).toHaveAccessibleName("Use new branch");
    const field = screen.getByLabelText("New branch name");
    expect(field).toHaveClass("h-input", "h-input--code");
    fireEvent.change(field, { target: { value: "main" } });
    fireEvent.click(strongButtons()[0]);
    // The field stays the same element (typing focus is not lost) and points at the message.
    expect(screen.getByLabelText("New branch name")).toBe(field);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("New branch must have a different name");
  });

  it("uncommitted changes: Discard is danger (not solid), Commit is the one primary, right-most", () => {
    render(
      <DirtyWorktreeDialog
        sessionId="s1"
        sessionLabel="One"
        variant="commit"
        changes={[{ projectId: "p", projectName: "repo", branchName: "hermes/a", files: [{ path: "a.txt", status: "modified" }] }]}
        onStashAndClose={vi.fn()}
        onCommitAndClose={vi.fn()}
        onArchiveAndClose={vi.fn()}
        onCloseAnyway={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Four long choices: the other ways out on a row of their own, then Cancel and the one primary.
    const rows = [...document.querySelectorAll(".dirty-wt-actions--rows > .dirty-wt-actions-row")];
    expect(rows.map((r) => [...r.querySelectorAll("button")].map((b) => b.textContent))).toEqual([
      ["Discard changes and close", "Archive (keep branch)"],
      ["Cancel", "Commit to session branch & close"],
    ]);
    expectActionRow(rows[0], null);
    expectActionRow(rows[1], "primary");
    expect(screen.getByRole("button", { name: "Discard changes and close" })).toHaveClass("h-btn--danger");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("h-close-btn");
  });
});

describe("process panel", () => {
  it("Kill Process Tree: Cancel, then the danger-solid Kill Tree; the kit checkbox; each does what it says", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const onToggleSkip = vi.fn();
    render(
      <KillConfirmDialog processName="node" pid={42} signal="SIGKILL" isTree onConfirm={onConfirm} onCancel={onCancel} skipConfirm={false} onToggleSkip={onToggleSkip} />,
    );
    expectActionRow(document.querySelector(".close-dialog-actions"), "danger-solid");
    expect(screen.getByRole("button", { name: "Kill Tree" })).toHaveClass("h-btn--danger-solid");
    expect(screen.getByText(/may cause data loss/)).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: "Don't ask again this session" });
    expect(box).toHaveClass("h-checkbox");
    fireEvent.click(box);
    expect(onToggleSkip).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Kill Tree" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("a plain SIGTERM kill: the confirm reads Kill and there is no data-loss warning", () => {
    render(<KillConfirmDialog processName="node" pid={42} signal="SIGTERM" isTree={false} onConfirm={vi.fn()} onCancel={vi.fn()} skipConfirm onToggleSkip={vi.fn()} />);
    expectActionRow(document.querySelector(".close-dialog-actions"), "danger-solid");
    expect(screen.getByRole("button", { name: "Kill" })).toBeInTheDocument();
    expect(screen.queryByText(/may cause data loss/)).toBeNull();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});

describe("permission request", () => {
  const request = { type: "_hermes_perm_request" as const, id: "r", toolName: "Bash", input: { command: "ls" } };

  it("Approve once is the one primary, right-most; Deny is danger", () => {
    render(<PermissionRequestModal request={request} permissionMode="default" onDecision={vi.fn()} />);
    expectActionRow(document.querySelector(".perm-modal-actions"), "primary");
    expect(screen.getByRole("button", { name: /^deny$/i })).toHaveClass("h-btn--danger");
  });

  it("editing: the JSON field is the kit's code field, marked invalid while the JSON is broken", () => {
    const onDecision = vi.fn();
    render(<PermissionRequestModal request={request} permissionMode="default" onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: /edit input/i }));
    const field = screen.getByRole("textbox");
    expect(field).toHaveClass("h-input", "h-textarea", "h-input--code");
    fireEvent.change(field, { target: { value: "{" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /confirm edit/i })).toBeDisabled();
    expectActionRow(document.querySelector(".perm-modal-actions"), "primary");
  });
});

describe("toasts", () => {
  it("action buttons are small kit buttons, the primary right-most whatever the order given; the close is named", () => {
    const review = vi.fn();
    const dismiss = vi.fn();
    render(
      <ToastContainer
        toasts={[
          {
            id: "t1",
            message: "2 plugin updates available",
            type: "info",
            duration: null,
            actions: [
              { label: "Review & Update", primary: true, onClick: review },
              { label: "Later", onClick: vi.fn() },
            ],
          },
        ]}
        onDismiss={dismiss}
      />,
    );
    const row = document.querySelector(".toast-actions");
    expectActionRow(row, "primary");
    for (const b of row!.querySelectorAll("button")) expect(b).toHaveClass("h-btn--sm");
    expect([...row!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Later", "Review & Update"]);
    fireEvent.click(screen.getByRole("button", { name: "Review & Update" }));
    expect(review).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith("t1");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("h-close-btn");
  });

  it("two actions with the same label both render and each runs its own handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ToastContainer
        toasts={[{ id: "t2", message: "Two of a kind", type: "info", duration: null, actions: [{ label: "Open", onClick: first }, { label: "Open", onClick: second }] }]}
        onDismiss={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Open" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    warn.mockRestore();
  });
});
