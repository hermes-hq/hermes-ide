/**
 * Pure helpers for the always-on right Context Panel in agent mode.
 * Math + persistence live here so they are testable without rendering
 * the component.  See `docs/internal/v1-tui-parity-plan.md` §2 (M0)
 * and §7.2 for the contract this code satisfies.
 */

export const DEFAULT_PANEL_WIDTH = 280;
export const MIN_PANEL_WIDTH = 200;
export const MAX_PANEL_WIDTH = 480;
/** Conversation column needs at least this much room.  Above-max input
 *  is clamped to `min(MAX_PANEL_WIDTH, viewport - MIN_CONVERSATION_WIDTH)`
 *  so opening the panel can't ever cover the conversation entirely. */
export const MIN_CONVERSATION_WIDTH = 320;

export const PANEL_SECTION_ORDER = [
  "mcp",
  "memory",
  "permissions",
  "pinned",
] as const;

export type PanelSectionKey = (typeof PANEL_SECTION_ORDER)[number];

export interface PanelState {
  width: number;
  collapsed: Partial<Record<PanelSectionKey, boolean>>;
}

/** Clamp a width input to [MIN, min(MAX, viewport - MIN_CONVERSATION_WIDTH)]
 *  and round to integer.  Floors below MIN; tiny viewports floor to MIN
 *  rather than collapsing the panel. */
export function clampPanelWidth(width: number, viewportWidth: number): number {
  const upperBound = Math.max(
    MIN_PANEL_WIDTH,
    Math.min(MAX_PANEL_WIDTH, viewportWidth - MIN_CONVERSATION_WIDTH),
  );
  const clamped = Math.min(Math.max(width, MIN_PANEL_WIDTH), upperBound);
  return Math.round(clamped);
}

/** Parse a possibly-corrupt persisted state blob into a strict PanelState.
 *  Defaults applied: width → DEFAULT_PANEL_WIDTH, collapsed → {}.
 *  Unknown section keys in `collapsed` are dropped.  Invalid widths are
 *  clamped through `clampPanelWidth` (with a generous viewport so the
 *  cap doesn't accidentally floor a sensible saved value). */
export function loadPanelState(raw: unknown): PanelState {
  const width = readPanelWidth(raw);
  const collapsed = readCollapsedMap(raw);
  return { width, collapsed };
}

function readPanelWidth(raw: unknown): number {
  if (raw === null || typeof raw !== "object") return DEFAULT_PANEL_WIDTH;
  const obj = raw as Record<string, unknown>;
  const v = obj.right_panel_width ?? obj.width;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_PANEL_WIDTH;
  return clampPanelWidth(v, 1920);
}

function readCollapsedMap(raw: unknown): PanelState["collapsed"] {
  if (raw === null || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const c = obj.agent_section_collapsed ?? obj.collapsed;
  if (c === null || typeof c !== "object" || Array.isArray(c)) return {};
  const out: PanelState["collapsed"] = {};
  for (const key of PANEL_SECTION_ORDER) {
    const v = (c as Record<string, unknown>)[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

/** Serialize a PanelState into the saved_workspace.json shape.  Mirrors
 *  the shape `loadPanelState` accepts; round-trip identity is pinned by
 *  test cps-4. */
export function serializePanelState(state: PanelState): {
  right_panel_width: number;
  agent_section_collapsed: Partial<Record<PanelSectionKey, boolean>>;
} {
  return {
    right_panel_width: state.width,
    agent_section_collapsed: { ...state.collapsed },
  };
}
