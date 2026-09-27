// GENERATED FILE — do not edit by hand.
// Run `node scripts/generate-shortcuts.mjs` to regenerate from
// src-tauri/src/menu/mod.rs (the menu bar is the source of truth).


export interface GeneratedShortcut {
  id: string;
  label: string;
  /** Canonical key string for `fmt()` in ../utils/platform, e.g. "{mod}N". */
  keys: string;
  /** Set only when the menu only registers this accelerator on one platform family. */
  platform?: "macos" | "not-macos";
}

export interface GeneratedShortcutGroup {
  group: string;
  shortcuts: GeneratedShortcut[];
}

export const GENERATED_SHORTCUT_GROUPS: GeneratedShortcutGroup[] = [
  {
    group: "Hermes",
    shortcuts: [
      { id: "hermes.settings", label: "Settings...", keys: "{mod}," },
    ],
  },
  {
    group: "File",
    shortcuts: [
      { id: "file.new-session", label: "New Session", keys: "{mod}N" },
      { id: "file.new-session-tab", label: "New Tab", keys: "{mod}T" },
      { id: "file.close-pane", label: "Close Pane", keys: "{mod}W" },
      { id: "file.file-explorer", label: "File Explorer", keys: "{mod}F" },
    ],
  },
  {
    group: "Edit",
    shortcuts: [
      { id: "edit.send-interrupt", label: "Send Interrupt", keys: "{ctrl}C", platform: "macos" },
    ],
  },
  {
    group: "View",
    shortcuts: [
      { id: "view.toggle-sidebar", label: "Sidebar", keys: "{mod}B" },
      { id: "view.command-palette", label: "Command Palette", keys: "{mod}K" },
      { id: "view.prompt-composer", label: "Prompt Composer", keys: "{mod}J" },
      { id: "view.process-panel", label: "Process Panel", keys: "{mod}P" },
      { id: "view.git-panel", label: "Git Panel", keys: "{mod}G" },
      { id: "view.context-panel", label: "Context Panel", keys: "{mod}E" },
      { id: "view.cost-dashboard", label: "Cost Dashboard", keys: "{mod}$" },
      { id: "view.shortcuts", label: "Keyboard Shortcuts", keys: "{mod}/" },
      { id: "view.split-horizontal", label: "Split Right", keys: "{mod}D" },
      { id: "view.split-vertical", label: "Split Down", keys: "{mod}{shift}D" },
      { id: "view.flow-mode", label: "Flow Mode", keys: "{mod}{shift}Z" },
      { id: "view.search-panel", label: "Search Panel", keys: "{mod}{shift}F" },
      { id: "view.fullscreen", label: "Toggle Fullscreen", keys: "F11", platform: "not-macos" },
    ],
  },
  {
    group: "Session",
    shortcuts: [
      { id: "session.copy-context", label: "Copy Context", keys: "{mod}{shift}C" },
    ],
  },
];
