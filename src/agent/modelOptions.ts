/**
 * Static model + permission-mode catalogues for the composer's pickers in
 * Agent mode (v1.0.0).
 *
 * These describe the set of choices the user can pick from the chip;
 * selection is sent to Claude as a `/model <id>` slash command and the
 * actual active model is reconciled from the next `init` event's
 * `model` field.  The list itself is intentionally static — Claude's
 * agent-mode init event does not enumerate available models, and the
 * slash command is the source of truth.  When Claude renames or adds
 * models we update this list rather than parsing `claude --help`.
 */

export interface ModelInfo {
  id: string;
  label: string;
  description: string;
}

/** Claude's published model aliases (which always resolve to the latest
 *  model in each family), plus Fable, which has no alias. */
export const CLAUDE_MODEL_OPTIONS: ModelInfo[] = [
  { id: "default", label: "Default", description: "Use Claude's default for this session" },
  { id: "sonnet", label: "Sonnet", description: "Balanced speed and capability" },
  { id: "opus", label: "Opus", description: "Highly capable for complex work" },
  { id: "claude-fable-5-1", label: "Fable 5.1", description: "Most capable, for the toughest tasks" },
  { id: "haiku", label: "Haiku", description: "Fastest, lighter weight" },
];

/** Collapse a full Claude model id (`claude-opus-4-1-20250805`,
 *  `claude-fable-5`) to its family alias (`opus`, `fable`).  Anything
 *  that doesn't match `claude-<family>-…` is returned trimmed; empty and
 *  `"unknown"` become null so callers can fall back to the provider. */
export function compactModelName(model: string | null | undefined): string | null {
  const m = model?.trim();
  if (!m || m.toLowerCase() === "unknown") return null;
  const match = /^claude-([a-z]+)-/.exec(m.toLowerCase());
  return match ? match[1] : m;
}
