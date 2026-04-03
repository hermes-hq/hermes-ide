import { useCallback, useRef } from "react";
import { showContextMenu, separator, menuItem, subMenu, type ContextMenuItem } from "../api/menu";
import { ensureListener, registerContextMenuHandler, clearContextMenuHandler } from "./nativeMenuBridge";

// Re-export types for convenience
export type { ContextMenuItem } from "../api/menu";
export { separator, menuItem, subMenu } from "../api/menu";

// ─── Category A Hook ────────────────────────────────────────────────

export function useContextMenu(onAction: (actionId: string) => void): {
  showMenu: (e: React.MouseEvent, items: ContextMenuItem[]) => void;
} {
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  const showMenu = useCallback(
    (e: React.MouseEvent, items: ContextMenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      ensureListener();
      registerContextMenuHandler((actionId) => onActionRef.current(actionId));
      showContextMenu(items).then(() => {
        // Menu closed (resolved) — clear stale handler if no action was fired.
        // The handler is one-shot and self-clears on action, but if the user
        // dismissed the menu without selecting, it stays registered and would
        // intercept the next menu bar action.
        clearContextMenuHandler();
      }).catch(() => {
        clearContextMenuHandler();
      });
    },
    [],
  );

  return { showMenu };
}

// ─── Builder Functions ──────────────────────────────────────────────

export function buildTerminalMenuItems(hasSelection: boolean): ContextMenuItem[] {
  return [
    menuItem("terminal.copy", "Copy", { enabled: hasSelection, accelerator: "CmdOrCtrl+C" }),
    menuItem("terminal.paste", "Paste", { accelerator: "CmdOrCtrl+V" }),
    separator(),
    menuItem("terminal.select-all", "Select All"),
    menuItem("terminal.clear", "Clear Terminal", { accelerator: "CmdOrCtrl+L" }),
    menuItem("terminal.reset", "Reset Terminal"),
    separator(),
    menuItem("terminal.split-right", "Split Right", { accelerator: "CmdOrCtrl+D" }),
    menuItem("terminal.split-down", "Split Down", { accelerator: "CmdOrCtrl+Shift+D" }),
    separator(),
    menuItem("terminal.search", "Find...", { accelerator: "CmdOrCtrl+Shift+F" }),
  ];
}

export function buildSessionMenuItems(
  session: { id: string; group: string | null; phase: string },
  groups: string[],
  _executionMode?: string,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    menuItem("session.rename", "Rename..."),
    separator(),
  ];

  if (groups.length > 0) {
    const groupChildren = groups.map((g) =>
      menuItem(`session.set-group.${g}`, g, {
        checked: session.group === g ? true : undefined,
      }),
    );
    groupChildren.push(separator());
    groupChildren.push(menuItem("session.new-group", "New Project..."));
    if (session.group) {
      groupChildren.push(separator());
      groupChildren.push(menuItem("session.remove-group", "Remove from Project"));
    }
    items.push(subMenu("Project", groupChildren));
  } else {
    items.push(menuItem("session.new-group", "New Project..."));
  }

  items.push(separator());
  items.push(menuItem("session.close", "Close Session"));

  return items;
}

export function buildGitFileMenuItems(
  file: { path: string; status: string },
  _projectPath?: string,
): ContextMenuItem[] {
  const isStaged = file.status.startsWith("staged") || file.status === "added";
  const isUntracked = file.status === "untracked" || file.status === "new";

  return [
    menuItem(isStaged ? "git-file.unstage" : "git-file.stage", isStaged ? "Unstage" : "Stage"),
    menuItem("git-file.diff", "View Diff", { enabled: !isUntracked }),
    separator(),
    menuItem("git-file.discard", "Discard Changes", { enabled: !isUntracked }),
    separator(),
    menuItem("git-file.copy-path", "Copy Path"),
    menuItem("git-file.reveal", "Reveal in Finder"),
    menuItem("git-file.open-terminal", "Open in Terminal"),
  ];
}

export function buildBranchMenuItems(
  branch: { name: string; is_remote: boolean },
  currentBranch: string,
): ContextMenuItem[] {
  const isCurrent = branch.name === currentBranch;
  return [
    menuItem("branch.checkout", "Checkout", { enabled: !isCurrent }),
    menuItem("branch.merge", "Merge into Current", { enabled: !isCurrent }),
    separator(),
    menuItem("branch.copy-name", "Copy Branch Name"),
    separator(),
    menuItem("branch.delete", "Delete Branch", { enabled: !isCurrent && !branch.is_remote }),
  ];
}

export function buildCommitMenuItems(
  commit: { sha: string; message?: string },
): ContextMenuItem[] {
  return [
    menuItem("commit.copy-sha", "Copy SHA"),
    menuItem("commit.copy-message", "Copy Message", { enabled: !!commit.message }),
    separator(),
    menuItem("commit.checkout", "Checkout Commit"),
    menuItem("commit.view-details", "View Details"),
  ];
}

export function buildStashMenuItems(
  _stash: { index: number },
): ContextMenuItem[] {
  return [
    menuItem("stash.apply", "Apply"),
    menuItem("stash.pop", "Pop"),
    separator(),
    menuItem("stash.drop", "Drop"),
  ];
}

export function buildFileExplorerMenuItems(
  entry: { name: string; is_dir: boolean; path: string },
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (entry.is_dir) {
    items.push(menuItem("file-explorer.new-file", "New File..."));
    items.push(menuItem("file-explorer.new-folder", "New Folder..."));
    items.push(separator());
  }

  if (!entry.is_dir) {
    items.push(menuItem("file-explorer.open-in-editor", "Open in Editor"));
  }
  items.push(menuItem("file-explorer.open-terminal", "Open in Terminal"));
  items.push(separator());
  items.push(menuItem("file-explorer.rename", "Rename..."));
  items.push(menuItem("file-explorer.delete", "Delete"));
  items.push(separator());
  items.push(menuItem("file-explorer.copy-path", "Copy Path"));
  items.push(menuItem("file-explorer.reveal", "Reveal in Finder"));

  return items;
}

export function buildProcessMenuItems(
  process: { pid: number; is_protected: boolean; exe_path?: string },
  advancedMode: boolean,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    menuItem("process.copy-pid", "Copy PID"),
    menuItem("process.sigterm", "Send SIGTERM", { enabled: !process.is_protected }),
  ];

  if (advancedMode) {
    items.push(menuItem("process.sigkill", "Send SIGKILL", { enabled: !process.is_protected }));
    items.push(menuItem("process.kill-tree", "Kill Tree", { enabled: !process.is_protected }));
  }

  if (process.exe_path) {
    items.push(separator());
    items.push(menuItem("process.reveal", "Reveal in Finder"));
  }

  return items;
}

export function buildSearchResultMenuItems(
  _result: { path: string },
): ContextMenuItem[] {
  return [
    menuItem("search.open-terminal", "Open in Terminal"),
    separator(),
    menuItem("search.copy-path", "Copy Path"),
    menuItem("search.reveal", "Reveal in Finder"),
  ];
}

export function buildContextEntryMenuItems(
  entry: { pinned?: boolean },
): ContextMenuItem[] {
  return [
    menuItem(entry.pinned ? "context.unpin" : "context.pin", entry.pinned ? "Unpin" : "Pin"),
    menuItem("context.remove", "Remove"),
    separator(),
    menuItem("context.copy-path", "Copy Path"),
  ];
}

export function buildPaneHeaderMenuItems(
  _paneId: string,
  hasSiblings: boolean,
): ContextMenuItem[] {
  return [
    menuItem("pane.split-right", "Split Right", { accelerator: "CmdOrCtrl+D" }),
    menuItem("pane.split-down", "Split Down", { accelerator: "CmdOrCtrl+Shift+D" }),
    separator(),
    menuItem("pane.close", "Close Pane", { enabled: hasSiblings, accelerator: "CmdOrCtrl+W" }),
    menuItem("pane.close-others", "Close Other Panes", { enabled: hasSiblings }),
  ];
}

export function buildTextInputMenuItems(hasSelection: boolean): ContextMenuItem[] {
  return [
    menuItem("text.cut", "Cut", { enabled: hasSelection, accelerator: "CmdOrCtrl+X" }),
    menuItem("text.copy", "Copy", { enabled: hasSelection, accelerator: "CmdOrCtrl+C" }),
    menuItem("text.paste", "Paste", { accelerator: "CmdOrCtrl+V" }),
    separator(),
    menuItem("text.select-all", "Select All", { accelerator: "CmdOrCtrl+A" }),
  ];
}

export function buildEmptyAreaMenuItems(
  region: "sidebar" | "file-explorer" | "git-section",
): ContextMenuItem[] {
  switch (region) {
    case "sidebar":
      return [
        menuItem("empty.new-session", "New Session", { accelerator: "CmdOrCtrl+N" }),
      ];
    case "file-explorer":
      return [
        menuItem("empty.new-file", "New File..."),
        menuItem("empty.new-folder", "New Folder..."),
        separator(),
        menuItem("empty.open-terminal", "Open Terminal Here"),
      ];
    case "git-section":
      return [
        menuItem("empty.refresh", "Refresh"),
      ];
  }
}
