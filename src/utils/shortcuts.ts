// Small helper shared by ShortcutsPanel and the Settings "Shortcuts" tab:
// both render src/generated/shortcuts.ts, filtered to the shortcuts that
// actually apply on the current platform.
import { isMac } from "./platform";
import type { GeneratedShortcutGroup } from "../generated/shortcuts";

export function visibleShortcutGroups(groups: GeneratedShortcutGroup[]): GeneratedShortcutGroup[] {
  return groups
    .map((group) => ({
      group: group.group,
      shortcuts: group.shortcuts.filter((s) => !s.platform || (s.platform === "macos" ? isMac : !isMac)),
    }))
    .filter((group) => group.shortcuts.length > 0);
}
