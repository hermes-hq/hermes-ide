import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Sent by the backend when the app is about to quit (src-tauri/src/quit_flush.rs). */
export const FLUSH_EVENT = "workspace-flush-requested";

/**
 * Write the saved workspace when the app is about to quit, and tell the
 * backend when it is written so the quit can go on. The backend waits a
 * few seconds at most; a save that fails still answers, so a broken save
 * never keeps the app from quitting.
 */
export function useWorkspaceFlushOnQuit(save: () => Promise<void>): void {
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen<number>(FLUSH_EVENT, async (event) => {
      try {
        await saveRef.current();
      } catch (err) {
        console.error("[SessionContext] Save before quitting failed:", err);
      } finally {
        await invoke("workspace_flush_done", { id: event.payload }).catch(console.error);
      }
    })
      .then((u) => {
        if (disposed) {
          u();
          return;
        }
        unlisten = u;
        // Only now can the backend count on an answer.
        return invoke("workspace_flush_ready");
      })
      .catch((err) => console.error("[SessionContext] Could not listen for quit:", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
