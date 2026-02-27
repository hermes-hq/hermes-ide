import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ─── Singleton Menu Event Bridge ────────────────────────────────────
//
// All native menu events (menu bar + popup context menus) arrive as
// a single "menu-action" event from Rust. This module routes them to
// the appropriate handler:
//   - menuBarHandler: registered once by useNativeMenuEvents
//   - contextMenuHandler: set transiently by useContextMenu (only one
//     native popup can be open at a time)

type ActionHandler = (actionId: string) => void;

let menuBarHandler: ActionHandler | null = null;
let contextMenuHandler: ActionHandler | null = null;
let unlisten: UnlistenFn | null = null;
let listenerPromise: Promise<void> | null = null;

function onMenuAction(payload: { action: string }) {
  // Context menu handler takes priority (it's the most recently opened)
  if (contextMenuHandler) {
    const handler = contextMenuHandler;
    contextMenuHandler = null; // one-shot
    handler(payload.action);
    return;
  }
  // Fall through to menu bar handler
  if (menuBarHandler) {
    menuBarHandler(payload.action);
  }
}

export function ensureListener(): Promise<void> {
  if (listenerPromise) return listenerPromise;
  listenerPromise = listen<{ action: string }>("menu-action", (event) => {
    onMenuAction(event.payload);
  }).then((u) => {
    unlisten = u;
  }).catch((err) => {
    listenerPromise = null;
    throw err;
  });
  return listenerPromise;
}

export function registerMenuBarHandler(handler: ActionHandler): () => void {
  menuBarHandler = handler;
  return () => {
    if (menuBarHandler === handler) menuBarHandler = null;
  };
}

export function registerContextMenuHandler(handler: ActionHandler): void {
  contextMenuHandler = handler;
}

export function clearContextMenuHandler(): void {
  contextMenuHandler = null;
}

export function cleanupListener(): void {
  unlisten?.();
  unlisten = null;
  listenerPromise = null;
  menuBarHandler = null;
  contextMenuHandler = null;
}
