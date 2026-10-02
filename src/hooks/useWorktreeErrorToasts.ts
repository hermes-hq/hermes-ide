import { useEffect } from "react";
import type { ToastStore } from "./useToastStore";
import { plainGitError } from "../utils/gitErrors";

/** Start of the disk guard's refusal (src-tauri/src/git/disk_guard.rs). */
const LOW_DISK_PREFIX = "Not enough free disk space";

/**
 * The toast text for worktree failures. A low-disk refusal is shown as is,
 * without the project id SessionContext puts in front of each error.
 */
export function worktreeErrorToastMessage(errors: string[], fatal: boolean | undefined): string {
	const lowDisk = errors.find((e) => e.includes(LOW_DISK_PREFIX));
	if (lowDisk) {
		const reason = lowDisk.slice(lowDisk.indexOf(LOW_DISK_PREFIX));
		return fatal ? `Session was not created. ${reason}` : reason;
	}
	// Sentences, not libgit2 codes or ids (SessionContext already puts the
	// project's name in front of each error).
	const details = errors.map((e) => plainGitError(e)).join("; ");
	return fatal
		? `Session was not created: could not create a worktree for the selected branch. ${details}`
		: `Some projects have no branch isolation (worktree creation failed): ${details}`;
}

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
			addToast({
				message: worktreeErrorToastMessage(errors, fatal),
				type: fatal ? "error" : "warning",
				duration: 15000,
			});
		};
		window.addEventListener("hermes:worktree-errors", handler);
		return () => window.removeEventListener("hermes:worktree-errors", handler);
	}, [addToast]);
}
