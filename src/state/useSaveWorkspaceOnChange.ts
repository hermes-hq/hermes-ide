import { useEffect, useRef } from "react";

/**
 * How long after the set of sessions changes the saved workspace is
 * rewritten. Several changes in a row write it once.
 */
export const SAVE_AFTER_CHANGE_MS = 300;

/**
 * Rewrite the saved workspace shortly after the workspace is loaded and
 * whenever a session opens or closes.
 *
 * The periodic save runs every 10 s, so without this a session created or
 * closed just before a quit or a crash was saved wrong, and the sessions
 * restored at launch were only in the saved workspace again once the next
 * tick came. Nothing is saved before `ready` (the launch's own restore has
 * settled): an empty list then means "not loaded yet", not "no sessions".
 */
export function useSaveWorkspaceOnChange(
  sessionIds: readonly string[],
  ready: boolean,
  save: () => Promise<void>,
  delayMs: number = SAVE_AFTER_CHANGE_MS,
): void {
  const saveRef = useRef(save);
  saveRef.current = save;
  const key = [...sessionIds].sort().join("\n");
  const previous = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ready) return;
    const before = previous.current;
    previous.current = key;
    if (before === key) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      saveRef.current().catch((err) => console.error("[SessionContext] Save after a session change failed:", err));
    }, delayMs);
  }, [key, ready, delayMs]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
}
