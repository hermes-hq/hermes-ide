// ─── Editor font size ────────────────────────────────────────────────
//
// The editor pane has its own font-size dimension, separate from the
// terminal `font_size` setting and from the global `ui_scale`. Bound
// to the persisted `editor_font_size` setting; mutated by Mod+= /
// Mod+- / Mod+0 shortcuts inside the editor.

export const DEFAULT_EDITOR_FONT_PX = 13;
export const MIN_EDITOR_FONT_PX = 8;
export const MAX_EDITOR_FONT_PX = 32;
export const EDITOR_FONT_STEP_PX = 1;

const clamp = (n: number): number =>
	Math.min(MAX_EDITOR_FONT_PX, Math.max(MIN_EDITOR_FONT_PX, n));

/** Parse a persisted setting value into an integer pixel size, falling back
 *  to the default on missing/invalid input. The persisted value is clamped
 *  to the allowed range so that a hand-edited DB row can't push the editor
 *  to 2pt or 200pt. */
export function parseEditorFontSize(raw: string | undefined | null): number {
	if (raw == null || raw === "") return DEFAULT_EDITOR_FONT_PX;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return DEFAULT_EDITOR_FONT_PX;
	return clamp(n);
}

/** Apply an increase / decrease / reset action to the current font size,
 *  always returning a clamped value. */
export function nextEditorFontSize(
	current: number,
	action: "increase" | "decrease" | "reset",
): number {
	if (action === "reset") return DEFAULT_EDITOR_FONT_PX;
	const step = action === "increase" ? EDITOR_FONT_STEP_PX : -EDITOR_FONT_STEP_PX;
	return clamp(current + step);
}
