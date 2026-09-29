// Test builds only (VITE_HERMES_E2E=1): the session provider hands its
// createSession and a way to show a session here, so a real-app scenario
// can start a terminal agent with a model, effort and account the way the
// launcher does (src/e2e/hooks.ts `launchWithChoice`). Normal builds never
// register anything.

import type { CreateSessionOpts, SessionData } from "../types/session";

export interface E2ESessionBridge {
	createSession(opts: CreateSessionOpts): Promise<SessionData | null>;
	show(sessionId: string): void;
}

let bridge: E2ESessionBridge | null = null;

export function setE2ESessionBridge(b: E2ESessionBridge | null): void {
	bridge = b;
}

export function getE2ESessionBridge(): E2ESessionBridge | null {
	return bridge;
}
