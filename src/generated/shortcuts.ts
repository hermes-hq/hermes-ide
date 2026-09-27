// GENERATED FILE — do not edit by hand.
// Run `node scripts/generate-shortcuts.mjs` to regenerate from
// src-tauri/src/menu/mod.rs (with src/utils/keymap.json, if present) and
// src/shortcuts/app-shortcuts.json.

export interface GeneratedShortcut {
  id: string;
  /** English label, as defined in the menu or app-shortcuts.json. */
  label: string;
  /** i18n key the UI renders; its English text equals `label`. */
  labelKey: string;
  /** Canonical key string for `fmt()` in ../utils/platform, e.g. "{mod}N". */
  keys: string;
  /** Windows/Linux key string, set only when it differs from `keys`. */
  pcKeys?: string;
  /** Set only when the menu only registers this accelerator on one platform family. */
  platform?: "macos" | "not-macos";
}

export interface GeneratedShortcutGroup {
  group: string;
  groupKey: string;
  shortcuts: GeneratedShortcut[];
}

export const GENERATED_SHORTCUT_GROUPS: GeneratedShortcutGroup[] = [
  {
    group: "Hermes",
    groupKey: "shortcuts.group.hermes",
    shortcuts: [
      { id: "hermes.settings", label: "Settings...", labelKey: "shortcuts.item.hermes.settings", keys: "{mod}," },
    ],
  },
  {
    group: "File",
    groupKey: "shortcuts.group.file",
    shortcuts: [
      { id: "file.new-session", label: "New Session", labelKey: "shortcuts.item.file.newSession", keys: "{mod}N" },
      { id: "file.new-session-tab", label: "New Tab", labelKey: "shortcuts.item.file.newSessionTab", keys: "{mod}T" },
      { id: "file.close-pane", label: "Close Pane", labelKey: "shortcuts.item.file.closePane", keys: "{mod}W" },
      { id: "file.file-explorer", label: "File Explorer", labelKey: "shortcuts.item.file.fileExplorer", keys: "{mod}F" },
    ],
  },
  {
    group: "Edit",
    groupKey: "shortcuts.group.edit",
    shortcuts: [
      { id: "edit.send-interrupt", label: "Send Interrupt", labelKey: "shortcuts.item.edit.sendInterrupt", keys: "{ctrl}C", platform: "macos" },
    ],
  },
  {
    group: "View",
    groupKey: "shortcuts.group.view",
    shortcuts: [
      { id: "view.toggle-sidebar", label: "Sidebar", labelKey: "shortcuts.item.view.toggleSidebar", keys: "{mod}B" },
      { id: "view.command-palette", label: "Command Palette", labelKey: "shortcuts.item.view.commandPalette", keys: "{mod}K" },
      { id: "view.prompt-composer", label: "Prompt Composer", labelKey: "shortcuts.item.view.promptComposer", keys: "{mod}J" },
      { id: "view.process-panel", label: "Process Panel", labelKey: "shortcuts.item.view.processPanel", keys: "{mod}P" },
      { id: "view.git-panel", label: "Git Panel", labelKey: "shortcuts.item.view.gitPanel", keys: "{mod}G" },
      { id: "view.context-panel", label: "Context Panel", labelKey: "shortcuts.item.view.contextPanel", keys: "{mod}E" },
      { id: "view.cost-dashboard", label: "Cost Dashboard", labelKey: "shortcuts.item.view.costDashboard", keys: "{mod}$" },
      { id: "view.shortcuts", label: "Keyboard Shortcuts", labelKey: "shortcuts.item.view.shortcuts", keys: "{mod}/" },
      { id: "view.split-horizontal", label: "Split Right", labelKey: "shortcuts.item.view.splitHorizontal", keys: "{mod}D" },
      { id: "view.split-vertical", label: "Split Down", labelKey: "shortcuts.item.view.splitVertical", keys: "{mod}{shift}D" },
      { id: "view.flow-mode", label: "Flow Mode", labelKey: "shortcuts.item.view.flowMode", keys: "{mod}{shift}Z" },
      { id: "view.search-panel", label: "Search Panel", labelKey: "shortcuts.item.view.searchPanel", keys: "{mod}{shift}F" },
      { id: "view.fullscreen", label: "Toggle Fullscreen", labelKey: "shortcuts.item.view.fullscreen", keys: "F11", platform: "not-macos" },
      { id: "app.command-palette-alt", label: "Command Palette (alternate)", labelKey: "shortcuts.item.app.commandPaletteAlt", keys: "{mod}{shift}P" },
      { id: "app.toggle-workbench", label: "Workbench", labelKey: "shortcuts.item.app.toggleWorkbench", keys: "{mod}{alt}B" },
    ],
  },
  {
    group: "Session",
    groupKey: "shortcuts.group.session",
    shortcuts: [
      { id: "session.copy-context", label: "Copy Context", labelKey: "shortcuts.item.session.copyContext", keys: "{mod}{shift}C" },
      { id: "app.focus-composer", label: "Focus Composer", labelKey: "shortcuts.item.app.focusComposer", keys: "{mod}{shift}J" },
      { id: "app.switch-session", label: "Switch to Session 1–9", labelKey: "shortcuts.item.app.switchSession", keys: "{mod}1-9" },
    ],
  },
  {
    group: "Panes",
    groupKey: "shortcuts.group.panes",
    shortcuts: [
      { id: "app.focus-next-pane", label: "Focus Next Pane", labelKey: "shortcuts.item.app.focusNextPane", keys: "{mod}{alt}→" },
      { id: "app.focus-previous-pane", label: "Focus Previous Pane", labelKey: "shortcuts.item.app.focusPreviousPane", keys: "{mod}{alt}←" },
    ],
  },
];
