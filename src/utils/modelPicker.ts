import type { ModelInfo } from "../api/sessions";

/**
 * Decide whether a `ModelInfo` option should be highlighted as the currently
 * active model in the picker.
 *
 * The "default" option is special: it is current when no model has been
 * detected yet (`null` or empty string). All other options match by
 * case-insensitive substring on the model id — Claude reports model strings
 * like `claude-sonnet-4-6` so a containment check on `sonnet` is the most
 * permissive way to flag the right row without coupling to the exact wire
 * format.
 */
export function isCurrentModel(option: ModelInfo, currentModel: string | null): boolean {
  if (!currentModel) return option.id === "default";
  return currentModel.toLowerCase().includes(option.id.toLowerCase());
}
