import { useSyncExternalStore } from "react";

/**
 * Test-only crash switch. Lets the automation bridge make one chosen part
 * of the UI throw while rendering, to prove that a crash stays inside its
 * pane or block. Probes are only placed in the tree when the frontend is
 * built for the real-app tests: each call site guards with
 * `import.meta.env.VITE_HERMES_E2E === "1" &&` written out in place, so
 * normal builds drop the probes (and this module) entirely.
 *
 * Targets: `pane:<sessionId>` and `block:<messageId>:<blockIndex>`.
 */
const armed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
	version++;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getVersion(): number {
	return version;
}

/** Make the probe for `target` throw on its next render (one time). */
export function armCrash(target: string): void {
	armed.add(target);
	notify();
}

export function isCrashArmed(target: string): boolean {
	return armed.has(target);
}

export function CrashProbe({ target }: { target: string }) {
	useSyncExternalStore(subscribe, getVersion, getVersion);
	if (armed.has(target)) {
		// One-shot: disarm after React has finished this render attempt
		// (it retries a failed render once, synchronously), so the part of
		// the UI can be brought back with its Reload action.
		setTimeout(() => armed.delete(target), 0);
		throw new Error(`Test crash requested for ${target}`);
	}
	return null;
}
