import { useEffect, useRef } from "react";

/**
 * How long after a session closes the saved workspace is rewritten. Closing
 * several sessions in a row writes it once.
 */
export const SAVE_AFTER_CLOSE_MS = 300;

/**
 * Rewrite the saved workspace shortly after a session goes away.
 *
 * The periodic save runs every 10 s, so without this a session closed just
 * before a quit or a crash was still in the saved workspace and came back on
 * the next launch. Sessions being added do not trigger a save here.
 */
export function useSaveWorkspaceOnClose(
  sessionIds: readonly string[],
  save: () => Promise<void>,
  delayMs: number = SAVE_AFTER_CLOSE_MS,
): void {
  const saveRef = useRef(save);
  saveRef.current = save;
  const key = [...sessionIds].sort().join("\n");
  const previous = useRef<ReadonlySet<string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const current = new Set(key ? key.split("\n") : []);
    const before = previous.current;
    previous.current = current;
    if (!before || ![...before].some((id) => !current.has(id))) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      saveRef.current().catch((err) => console.error("[SessionContext] Save after close failed:", err));
    }, delayMs);
  }, [key, delayMs]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
}
