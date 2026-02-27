import { useCallback } from "react";
import { showContextMenu } from "../api/menu";
import { buildTextInputMenuItems } from "./useContextMenu";
import { ensureListener, registerContextMenuHandler, clearContextMenuHandler } from "./nativeMenuBridge";

// ─── Category B Hook — Text Input Context Menu ──────────────────────

export function useTextContextMenu(): {
  onContextMenu: (e: React.MouseEvent) => void;
} {
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    const hasSelection = (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0);
    const items = buildTextInputMenuItems(hasSelection);

    ensureListener();
    registerContextMenuHandler((actionId: string) => {
      handleTextAction(actionId, target);
    });
    showContextMenu(items).catch(() => {
      clearContextMenuHandler();
    });
  }, []);

  return { onContextMenu };
}

function handleTextAction(actionId: string, target: HTMLInputElement | HTMLTextAreaElement): void {
  if (!target.isConnected) return;
  target.focus();

  switch (actionId) {
    case "text.cut":
      document.execCommand("cut");
      break;
    case "text.copy":
      document.execCommand("copy");
      break;
    case "text.paste":
      // Tauri handles native paste via the menu accelerator
      document.execCommand("paste");
      break;
    case "text.select-all":
      target.select();
      break;
  }
}
