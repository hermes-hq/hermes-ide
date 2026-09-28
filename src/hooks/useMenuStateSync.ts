import { useEffect } from "react";
import { updateMenuState, type MenuItemUpdate } from "../api/menu";

// ─── Sync React UI State → Native Menu Checkmarks/Enabled ──────────

interface MenuSyncState {
  sidebarVisible: boolean;
  processPanelOpen: boolean;
  gitPanelOpen: boolean;
  /** F21: the ⌘G item's label while the Review Desk replaces the git panel; unset keeps "Git Panel". */
  gitPanelLabel?: string;
  contextPanelOpen: boolean;
  searchPanelOpen: boolean;
  flowMode: boolean;
}

export function useMenuStateSync(uiState: MenuSyncState): void {
  useEffect(() => {
    const updates: MenuItemUpdate[] = [
      { id: "view.toggle-sidebar", checked: uiState.sidebarVisible },
      { id: "view.process-panel", checked: uiState.processPanelOpen },
      { id: "view.git-panel", checked: uiState.gitPanelOpen, ...(uiState.gitPanelLabel ? { text: uiState.gitPanelLabel } : {}) },
      { id: "view.context-panel", checked: uiState.contextPanelOpen },
      { id: "view.search-panel", checked: uiState.searchPanelOpen },
      { id: "view.flow-mode", checked: uiState.flowMode },
    ];

    updateMenuState(updates).catch(console.error);
  }, [
    uiState.sidebarVisible,
    uiState.processPanelOpen,
    uiState.gitPanelOpen,
    uiState.gitPanelLabel,
    uiState.contextPanelOpen,
    uiState.searchPanelOpen,
    uiState.flowMode,
  ]);
}
