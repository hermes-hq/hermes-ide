// ─── Auto-generated session labels ───────────────────────────────────
//
// When a user opens an agent-mode session without giving it a name,
// the backend assigns a placeholder like "Session 7". Once the user
// sends their first message we can do better: derive a label from the
// message text and rename the session in place (issue #1).
//
// This is intentionally not a model round-trip — the first message is
// already a great summary of "what this session is for," it costs no
// tokens, and it works in airgapped / no-API-key environments. If a
// future PR wants AI-generated names that's an additive layer; this
// module just owns the heuristic.

/** Pattern the backend uses for unnamed sessions ("Session 1",
 *  "Session 2", ...). Anything else means the user named it manually
 *  or a previous auto-name already ran. */
export const DEFAULT_LABEL_PATTERN = /^Session \d+$/;

export const MAX_AUTO_LABEL_CHARS = 40;

/** True if `label` looks like the backend's auto-assigned placeholder. */
export function isDefaultSessionLabel(label: string | null | undefined): boolean {
	if (!label) return true;
	return DEFAULT_LABEL_PATTERN.test(label.trim());
}

/** Derive a session label from the user's first message. Returns null
 *  when the message has no usable text content (e.g. only attachments). */
export function deriveSessionLabelFromMessage(draft: string): string | null {
	if (!draft) return null;
	// Take the first non-empty line — multi-line drafts are common when the
	// user pastes context, but the first line is almost always the prompt.
	let first = "";
	for (const line of draft.split(/\r?\n/)) {
		const t = line.trim();
		if (t) { first = t; break; }
	}
	if (!first) return null;
	// Collapse runs of internal whitespace so a tab-indented or
	// double-spaced fragment still reads cleanly in the sidebar.
	first = first.replace(/\s+/g, " ");
	if (first.length <= MAX_AUTO_LABEL_CHARS) return first;
	// Truncate, preferring to break on a word boundary if one's nearby.
	const slice = first.slice(0, MAX_AUTO_LABEL_CHARS);
	const lastSpace = slice.lastIndexOf(" ");
	const cutoff = lastSpace >= MAX_AUTO_LABEL_CHARS - 12 ? lastSpace : MAX_AUTO_LABEL_CHARS;
	return slice.slice(0, cutoff).trimEnd() + "…";
}
