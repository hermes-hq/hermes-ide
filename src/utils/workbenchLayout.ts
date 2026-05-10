/**
 * Pure helpers + persistence-shape for the right-rail Workbench
 * (Files / Context / Notes), agent-mode only.
 *
 * The Workbench is the dedicated right-side panel introduced in
 * v1.1.14.  It replaces the per-session-row folder icon: every agent
 * session gets its own workbench with files (top), an optional Context
 * tab (the legacy AgentContextPanel content), and a notes drawer at
 * the bottom.  Math + serialization live here so the reducer + UI
 * code can be tested without rendering the panel.
 *
 * See `docs/mockups/right-rail-workbench.html` for the visual spec.
 */

// ─── Tabs ───────────────────────────────────────────────────────────

export const WORKBENCH_TABS = ["files", "context", "git"] as const;
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];

export const DEFAULT_WORKBENCH_TAB: WorkbenchTab = "files";

export function isWorkbenchTab(value: unknown): value is WorkbenchTab {
  return typeof value === "string" && (WORKBENCH_TABS as readonly string[]).includes(value);
}

// ─── Width: chat ↔ workbench split ─────────────────────────────────
//
// The workbench takes a portion of the viewport.  We persist a *ratio*
// of the viewport (0–1), not pixels — that way a user who saves a
// workspace on a 27" display doesn't open it on a 13" laptop and find
// the chat collapsed to nothing.

export const DEFAULT_WORKBENCH_RATIO = 0.5; // 50/50 chat ↔ workbench
export const MIN_WORKBENCH_RATIO = 0.18;
export const MAX_WORKBENCH_RATIO = 0.7;

/** Minimum chat-pane width in pixels.  When the viewport is narrow,
 *  the workbench width is clamped down so the chat never shrinks
 *  below this. */
export const MIN_CHAT_WIDTH_PX = 320;
/** Minimum absolute workbench width.  At very small viewports we
 *  prefer keeping the workbench at this floor over collapsing it
 *  entirely; the user can always close it via the toggle. */
export const MIN_WORKBENCH_WIDTH_PX = 280;

/** Clamp a stored ratio (0–1) to its allowed band.  Returns the
 *  default when the input is non-finite or out of any sensible range. */
export function clampWorkbenchRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_WORKBENCH_RATIO;
  return Math.max(MIN_WORKBENCH_RATIO, Math.min(MAX_WORKBENCH_RATIO, ratio));
}

/** Resolve the workbench's pixel width given the current viewport
 *  width and the persisted ratio.  Honors the chat-pane floor so the
 *  conversation never collapses. */
export function workbenchPixelWidth(
  viewportWidth: number,
  ratio: number,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return Math.round(viewportWidth * DEFAULT_WORKBENCH_RATIO);
  }
  const desired = viewportWidth * clampWorkbenchRatio(ratio);
  const upper = Math.max(MIN_WORKBENCH_WIDTH_PX, viewportWidth - MIN_CHAT_WIDTH_PX);
  return Math.round(Math.max(MIN_WORKBENCH_WIDTH_PX, Math.min(desired, upper)));
}

// ─── Internal: files ↔ notes split inside the workbench ─────────────

export const DEFAULT_FILES_NOTES_SPLIT = 0.7; // files take 70% of panel height
export const MIN_FILES_NOTES_SPLIT = 0.25;
export const MAX_FILES_NOTES_SPLIT = 0.9;

export function clampFilesNotesSplit(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_FILES_NOTES_SPLIT;
  return Math.max(MIN_FILES_NOTES_SPLIT, Math.min(MAX_FILES_NOTES_SPLIT, ratio));
}

// ─── Notes ──────────────────────────────────────────────────────────
//
// Per-session notes — one string per session id.  Persisted alongside
// the rest of the workspace.  We cap at a sane size so a runaway
// keystroke loop can't bloat saved_workspace.

export const NOTES_MAX_LEN = 64 * 1024; // 64 KiB per session

export function clampNoteContent(text: string): string {
  if (typeof text !== "string") return "";
  if (text.length <= NOTES_MAX_LEN) return text;
  return text.slice(0, NOTES_MAX_LEN);
}

// ─── Persisted shape ────────────────────────────────────────────────
//
// The Workbench attaches three new fields onto SavedWorkspace:
//   - workbench: { open, tab, ratio, filesNotesSplit }
//   - notes:     Record<sessionId, string>
//
// Older saves omit them; the loader fills defaults.  When a session
// is removed we drop its note (handled in the reducer's
// SESSION_REMOVED case, not here).

export interface PersistedWorkbenchLayout {
  open: boolean;
  tab: WorkbenchTab;
  ratio: number;
  filesNotesSplit: number;
}

export const DEFAULT_PERSISTED_WORKBENCH: PersistedWorkbenchLayout = {
  open: true,
  tab: DEFAULT_WORKBENCH_TAB,
  ratio: DEFAULT_WORKBENCH_RATIO,
  filesNotesSplit: DEFAULT_FILES_NOTES_SPLIT,
};

/** Parse an unknown blob (from saved_workspace.json) into a strict
 *  PersistedWorkbenchLayout.  Tolerates missing fields, unknown tab
 *  names, malformed numbers — the goal is "never let a corrupt save
 *  crash the app". */
export function loadWorkbenchLayout(raw: unknown): PersistedWorkbenchLayout {
  if (raw === null || typeof raw !== "object") {
    return { ...DEFAULT_PERSISTED_WORKBENCH };
  }
  const obj = raw as Record<string, unknown>;
  return {
    open: typeof obj.open === "boolean" ? obj.open : DEFAULT_PERSISTED_WORKBENCH.open,
    tab: isWorkbenchTab(obj.tab) ? obj.tab : DEFAULT_WORKBENCH_TAB,
    ratio:
      typeof obj.ratio === "number"
        ? clampWorkbenchRatio(obj.ratio)
        : DEFAULT_WORKBENCH_RATIO,
    filesNotesSplit:
      typeof obj.filesNotesSplit === "number"
        ? clampFilesNotesSplit(obj.filesNotesSplit)
        : DEFAULT_FILES_NOTES_SPLIT,
  };
}

/** Inverse of `loadWorkbenchLayout` — produces the JSON-safe shape we
 *  attach onto SavedWorkspace. */
export function serializeWorkbenchLayout(
  state: PersistedWorkbenchLayout,
): PersistedWorkbenchLayout {
  return {
    open: state.open,
    tab: state.tab,
    ratio: clampWorkbenchRatio(state.ratio),
    filesNotesSplit: clampFilesNotesSplit(state.filesNotesSplit),
  };
}

/** Validate a loose `notes` blob from saved_workspace into a strict
 *  Record<sessionId, string>.  Drops non-string values silently and
 *  truncates oversized strings to NOTES_MAX_LEN.  Unknown session ids
 *  are kept — the reducer's SESSION_REMOVED case prunes orphans on
 *  the next mutation. */
export function loadNotesMap(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (typeof v !== "string") continue;
    out[k] = clampNoteContent(v);
  }
  return out;
}

/** Mirror of `loadNotesMap` — drops empty strings so the saved
 *  workspace doesn't accumulate dead session-id keys with no content. */
export function serializeNotesMap(
  notes: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(notes)) {
    if (typeof v === "string" && v.length > 0) {
      out[k] = clampNoteContent(v);
    }
  }
  return out;
}
