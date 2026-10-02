import { useEffect, useRef } from "react";
import type { ToastStore } from "./useToastStore";
import { translate } from "../i18n/registry";

export interface EndedSession {
  id: string;
  label: string;
}

/** The notice for sessions that ended without Hermes closing them (one for all of them). */
export function endedSessionsMessage(sessions: readonly EndedSession[], reason: "service" | "killed", signal?: number): string {
  const why = reason === "killed" ? translate("ended.killed", { signal: signal ?? 9 }) : translate("ended.serviceStopped");
  return sessions.length === 1
    ? translate("ended.one", { label: sessions[0].label, reason: why })
    : translate("ended.many", { count: sessions.length, reason: why });
}

/**
 * Notices about sessions and their worktrees that SessionContext raises
 * as window events:
 *  - `hermes:sessions-ended`: sessions whose terminal ended on its own
 *    (the terminal service died): one notice with Restart and Close;
 *  - `hermes:worktrees-kept`: worktree folders left on disk on close, and where;
 *  - `hermes:worktree-warnings`: a worktree that was made although git
 *    reported a problem (a hook that failed after checkout).
 */
export function useSessionNoticeToasts(
  addToast: ToastStore["addToast"],
  actions: { restart: (ids: string[]) => void; close: (ids: string[]) => void },
): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onEnded = (e: Event) => {
      const { sessions, reason, signal } = (e as CustomEvent).detail as { sessions: EndedSession[]; reason: "service" | "killed"; signal?: number };
      if (!sessions?.length) return;
      const ids = sessions.map((s) => s.id);
      addToast({
        message: endedSessionsMessage(sessions, reason, signal),
        type: "warning",
        duration: null,
        actions: [
          { label: translate("ended.restart"), primary: true, onClick: () => actionsRef.current.restart(ids) },
          { label: translate("common.close"), onClick: () => actionsRef.current.close(ids) },
        ],
      });
    };
    const onKept = (e: Event) => {
      const { paths } = (e as CustomEvent).detail as { paths: string[] };
      for (const path of paths ?? []) {
        addToast({ message: translate("dirty.keptAt", { path }), type: "info", duration: 15000 });
      }
    };
    const onWarnings = (e: Event) => {
      const { warnings } = (e as CustomEvent).detail as { warnings: string[] };
      for (const w of warnings ?? []) addToast({ message: w, type: "warning", duration: 20000 });
    };
    window.addEventListener("hermes:sessions-ended", onEnded);
    window.addEventListener("hermes:worktrees-kept", onKept);
    window.addEventListener("hermes:worktree-warnings", onWarnings);
    return () => {
      window.removeEventListener("hermes:sessions-ended", onEnded);
      window.removeEventListener("hermes:worktrees-kept", onKept);
      window.removeEventListener("hermes:worktree-warnings", onWarnings);
    };
  }, [addToast]);
}
