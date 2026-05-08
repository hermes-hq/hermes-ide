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

/** Claude's published model aliases as of 1.0.0. */
export const CLAUDE_MODEL_OPTIONS: ModelInfo[] = [
  { id: "default", label: "Default", description: "Use Claude's default for this session" },
  { id: "sonnet", label: "Sonnet", description: "Balanced speed and capability" },
  { id: "opus", label: "Opus", description: "Most capable, slower" },
  { id: "haiku", label: "Haiku", description: "Fastest, lighter weight" },
];
