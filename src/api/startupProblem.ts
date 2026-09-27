import { invoke } from "@tauri-apps/api/core";

/** Why Hermes could not open its data this run (see src-tauri/src/db/startup.rs). */
export interface StartupProblem {
	kind: "newer-data" | "backup-failed" | "migration-failed" | "open-failed";
	title: string;
	message: string;
	/** The database file Hermes tried to open. */
	dataPath: string;
}

/**
 * The problem that stopped Hermes from opening its data, or null when the
 * data opened normally. Also null outside the desktop app (e.g. `vite dev`
 * in a browser), where there is no backend to ask.
 */
export async function getStartupProblem(): Promise<StartupProblem | null> {
	try {
		return (await invoke<StartupProblem | null>("get_startup_problem")) ?? null;
	} catch {
		return null;
	}
}
