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

// An app chord can reach both the webview's key listener and the native
// menu (depending on the OS webview), in either order. Whichever arrives
// first runs the action; the other one, for the same action right after it,
// is the same key press and is dropped.
// Side effect, accepted: a mouse click on the same menu item within 500 ms
// of pressing its chord is also taken for the echo and dropped. Nobody runs
// the same action twice that fast on purpose, and the chord already ran it.
const ECHO_WINDOW_MS = 500;
type ActionSource = "keyboard" | "native";
let lastAction: { id: string; at: number; source: ActionSource } | null = null;

/** True when this delivery is the other path's echo of the same key press. */
function isEcho(id: string, source: ActionSource): boolean {
  if (
    lastAction &&
    lastAction.id === id &&
    lastAction.source !== source &&
    Date.now() - lastAction.at < ECHO_WINDOW_MS
  ) {
    lastAction = null;
    return true;
  }
  return false;
}

function onMenuAction(payload: { action: string }) {
  if (isEcho(payload.action, "native")) return;
  // Context menu handler takes priority (it's the most recently opened)
  if (contextMenuHandler) {
    const handler = contextMenuHandler;
    contextMenuHandler = null; // one-shot
    handler(payload.action);
    return;
  }
  lastAction = { id: payload.action, at: Date.now(), source: "native" };
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

/** Run a menu bar action from in-app UI (e.g. a context menu item that
 *  should behave exactly like its menu bar counterpart). */
export function triggerMenuBarAction(actionId: string): void {
  menuBarHandler?.(actionId);
}

/** Run a menu bar action for a key chord pressed in the webview. */
export function triggerMenuBarActionFromKeyboard(actionId: string): void {
  if (isEcho(actionId, "keyboard")) return;
  lastAction = { id: actionId, at: Date.now(), source: "keyboard" };
  menuBarHandler?.(actionId);
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
  lastAction = null;
}
