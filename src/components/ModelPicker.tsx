import type { ReactNode } from "react";
import type { ModelInfo } from "../agent/modelOptions";
import { isCurrentModel } from "../utils/modelPicker";
import { Menu, type MenuEntry, type MenuTriggerProps } from "./ui/Menu";

interface ModelPickerProps {
  /** Models discovered from the local Claude CLI; empty when discovery failed. */
  options: ModelInfo[];
  currentModel: string | null;
  onSelect: (modelId: string) => void;
  /** The composer's model chip; it opens the menu. */
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
}

/** Sentinel id passed to onSelect for the "Open Claude's picker…" escape hatch. */
const OPEN_PICKER_ID = "";

/**
 * The model menu behind the composer's model chip: the kit Menu, so ↑ ↓
 * Home End and type-ahead ("o" for Opus) move, Enter picks, Esc closes and
 * focus returns to the chip. The current model carries the check.
 */
export function ModelPicker({ options, currentModel, onSelect, renderTrigger }: ModelPickerProps) {
  const entries: MenuEntry[] =
    options.length === 0
      ? [{ id: "none", label: "Discovery unavailable on this Claude version.", disabled: true, onSelect: () => {} }]
      : options.map((opt) => ({
          id: `model-${opt.id}`,
          label: opt.label,
          detail: opt.description,
          checked: isCurrentModel(opt, currentModel),
          onSelect: () => onSelect(opt.id),
        }));
  entries.push(
    { id: "separator", separator: true },
    {
      id: "open-claude-picker",
      label: "Open Claude's picker…",
      detail: "Claude's full model menu in the terminal",
      onSelect: () => onSelect(OPEN_PICKER_ID),
    },
  );
  return (
    <Menu
      label="Select model"
      entries={entries}
      renderTrigger={renderTrigger}
      className="model-picker"
      footer={<>From your next message: Claude restarts with the new <kbd>--model</kbd>, same conversation</>}
    />
  );
}
