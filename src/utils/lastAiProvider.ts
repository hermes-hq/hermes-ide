// ─── Last selected AI provider ───────────────────────────────────────
//
// Backing the "remember last selected AI engine" UX (issue #3): the
// terminal-mode session-creator pre-selects the provider the user
// picked last time, so they don't re-pick on every new session.
//
// Stored in the `last_ai_provider` setting key. Only provider IDs that
// still exist in the registry are honored — a stale ID (e.g. a removed
// provider) silently falls back to "no pre-selection."
//
// Scope: single global default. Per-project / per-workspace memory is
// an explicit follow-up; see the open question on the issue.

export const LAST_AI_PROVIDER_KEY = "last_ai_provider";

/** Validate a persisted setting value against the current provider registry.
 *  Returns the trimmed id if it's known, otherwise null. Empty / unset /
 *  whitespace-only values return null. */
export function resolveDefaultAiProvider(
	raw: string | null | undefined,
	knownProviderIds: readonly string[],
): string | null {
	if (raw == null) return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	if (!knownProviderIds.includes(trimmed)) return null;
	return trimmed;
}
