import { useEffect } from "react";
import type { ToastStore } from "./useToastStore";

/**
 * Surfaces `hermes:worktree-errors` (dispatched by SessionContext.createSession)
 * as toasts (#286).  `fatal: true` means the session was aborted because every
 * selected worktree failed; otherwise the session proceeded without isolation
 * for the failed projects.
 */
export function useWorktreeErrorToasts(addToast: ToastStore["addToast"]): void {
	useEffect(() => {
		const handler = (e: Event) => {
			const { errors, fatal } = (e as CustomEvent).detail as { errors: string[]; sessionLabel?: string; fatal?: boolean };
			const details = errors.join("; ");
			addToast({
				message: fatal
					? `Session was not created: could not create a worktree for the selected branch. ${details}`
					: `Some projects have no branch isolation (worktree creation failed): ${details}`,
				type: fatal ? "error" : "warning",
				duration: 15000,
			});
		};
		window.addEventListener("hermes:worktree-errors", handler);
		return () => window.removeEventListener("hermes:worktree-errors", handler);
	}, [addToast]);
}
