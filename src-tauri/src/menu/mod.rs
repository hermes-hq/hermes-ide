use serde::{Deserialize, Serialize};
use tauri::menu::{
    AboutMetadata, AboutMetadataBuilder, CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent,
    MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

// ─── Data Models ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuItem {
    pub id: String,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub is_separator: bool,
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub accelerator: Option<String>,
    #[serde(default)]
    pub children: Vec<ContextMenuItem>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuItemUpdate {
    pub id: String,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub checked: Option<bool>,
    /// A new label for the item (F21: "Git Panel" reads "Review Desk" with the flag on).
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuActionPayload {
    pub action: String,
}

// ─── About dialog ───────────────────────────────────────────────────

/// Shown in the About dialog so nobody mistakes this app for a different
/// project that shares the Hermes name.
pub const NON_AFFILIATION_NOTE: &str = "Not affiliated with Nous Research or its Hermes Agent.";

/// Metadata for the native About dialog.  The non-affiliation note goes in
/// both `comments` (shown on Windows and Linux) and `credits` (shown on
/// macOS), because each platform shows only one of them.
fn about_metadata() -> AboutMetadata<'static> {
    AboutMetadataBuilder::new()
        .name(Some("HERMES-IDE"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .comments(Some(NON_AFFILIATION_NOTE))
        .credits(Some(NON_AFFILIATION_NOTE))
        .build()
}

// ─── Keymap ─────────────────────────────────────────────────────────
//
// App chords live in one table shared with the frontend (which shows them in
// the Shortcuts panel and handles them inside the webview). On Windows/Linux
// a native accelerator can take a key before the webview sees it, so no app
// chord there is a bare Ctrl+letter: those belong to the terminal.

const KEYMAP_JSON: &str = include_str!("../../../src/utils/keymap.json");

#[derive(Debug, Deserialize)]
struct KeymapFile {
    chords: Vec<KeymapChord>,
}

#[derive(Debug, Deserialize)]
struct KeymapChord {
    action: String,
    mac: String,
    pc: String,
}

fn keymap() -> &'static KeymapFile {
    static KEYMAP: std::sync::OnceLock<KeymapFile> = std::sync::OnceLock::new();
    KEYMAP
        .get_or_init(|| serde_json::from_str(KEYMAP_JSON).expect("src/utils/keymap.json is valid"))
}

/// Canonical chord ("{mod}{shift}D") → accelerator string ("CmdOrCtrl+Shift+D").
fn to_accelerator(canonical: &str) -> String {
    canonical
        .replace("{mod}", "CmdOrCtrl+")
        .replace("{ctrl}", "Ctrl+")
        .replace("{shift}", "Shift+")
        .replace("{alt}", "Alt+")
}

/// Accelerator for a menu action on the given platform.
fn accelerator_for(action: &str, mac: bool) -> Option<String> {
    keymap()
        .chords
        .iter()
        .find(|c| c.action == action)
        .map(|c| to_accelerator(if mac { &c.mac } else { &c.pc }))
}

fn app_accel(action: &str) -> Result<String, Box<dyn std::error::Error>> {
    accelerator_for(action, cfg!(target_os = "macos"))
        .ok_or_else(|| format!("no keyboard chord for menu action {action}").into())
}

// ─── Quit ───────────────────────────────────────────────────────────

/// The app menu's Quit item.
pub const QUIT_ID: &str = "hermes.quit";

/// Label and accelerator the predefined Quit item has on each platform:
/// Cmd+Q on macOS only; on Windows and Linux no chord (Ctrl+Q belongs to the
/// terminal).
fn quit_label_and_accelerator(mac: bool, windows: bool) -> (&'static str, Option<&'static str>) {
    if mac {
        ("Quit HERMES-IDE", Some("CmdOrCtrl+Q"))
    } else if windows {
        ("Exit", None)
    } else {
        ("Quit", None)
    }
}

fn quit_item(app: &AppHandle) -> tauri::Result<tauri::menu::MenuItem<Wry>> {
    let (label, accel) =
        quit_label_and_accelerator(cfg!(target_os = "macos"), cfg!(target_os = "windows"));
    let builder = MenuItemBuilder::with_id(QUIT_ID, label);
    match accel {
        Some(a) => builder.accelerator(a).build(app),
        None => builder.build(app),
    }
}

// ─── Build Application Menu Bar ─────────────────────────────────────

pub fn build_app_menu(app: &AppHandle) -> Result<Menu<Wry>, Box<dyn std::error::Error>> {
    // ── Hermes menu (app menu) ──
    let about = PredefinedMenuItem::about(app, Some("About HERMES-IDE"), Some(about_metadata()))?;
    let settings = MenuItemBuilder::with_id("hermes.settings", "Settings...")
        .accelerator(app_accel("hermes.settings")?)
        .build(app)?;
    // Not the predefined Quit: that one exits without asking the frontend
    // to save its workspace first (see quit_flush).
    let quit = quit_item(app)?;

    #[cfg(target_os = "macos")]
    let hermes_menu = {
        let services = PredefinedMenuItem::services(app, None)?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;

        SubmenuBuilder::new(app, "HERMES-IDE")
            .item(&about)
            .separator()
            .item(&settings)
            .separator()
            .item(&services)
            .separator()
            .item(&hide)
            .item(&hide_others)
            .item(&show_all)
            .separator()
            .item(&quit)
            .build()?
    };

    #[cfg(not(target_os = "macos"))]
    let hermes_menu = SubmenuBuilder::new(app, "HERMES-IDE")
        .item(&about)
        .separator()
        .item(&settings)
        .separator()
        .item(&quit)
        .build()?;

    // ── File menu ──
    let new_session = MenuItemBuilder::with_id("file.new-session", "New Session")
        .accelerator(app_accel("file.new-session")?)
        .build(app)?;
    let new_tab = MenuItemBuilder::with_id("file.new-session-tab", "New Tab")
        .accelerator(app_accel("file.new-session-tab")?)
        .build(app)?;
    let close_pane = MenuItemBuilder::with_id("file.close-pane", "Close Pane")
        .accelerator(app_accel("file.close-pane")?)
        .build(app)?;
    let open_file_explorer = MenuItemBuilder::with_id("file.file-explorer", "File Explorer")
        .accelerator(app_accel("file.file-explorer")?)
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_session)
        .item(&new_tab)
        .item(&close_pane)
        .separator()
        .item(&open_file_explorer)
        .build()?;

    // ── Edit menu ──
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let find = MenuItemBuilder::with_id("edit.find", "Find...").build(app)?;

    // macOS: Ctrl+C → Send Interrupt (SIGINT to active terminal).
    // WKWebView consumes Ctrl+C at the native level before JavaScript
    // can see the keydown event.  By registering it as a menu accelerator,
    // the macOS menu system intercepts it first and fires a menu event
    // that we forward to the frontend as "native-sigint".
    #[cfg(target_os = "macos")]
    let send_interrupt = MenuItemBuilder::with_id("edit.send-interrupt", "Send Interrupt")
        .accelerator("Ctrl+C")
        .build(app)?;

    #[allow(unused_mut)]
    let mut edit_builder = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&select_all)
        .separator()
        .item(&find);

    #[cfg(target_os = "macos")]
    {
        edit_builder = edit_builder.separator().item(&send_interrupt);
    }

    let edit_menu = edit_builder.build()?;

    // ── View menu ──
    let toggle_sidebar = CheckMenuItemBuilder::with_id("view.toggle-sidebar", "Sidebar")
        .accelerator(app_accel("view.toggle-sidebar")?)
        .checked(true)
        .build(app)?;
    let command_palette = MenuItemBuilder::with_id("view.command-palette", "Command Palette")
        .accelerator(app_accel("view.command-palette")?)
        .build(app)?;
    let prompt_composer = MenuItemBuilder::with_id("view.prompt-composer", "Prompt Composer")
        .accelerator(app_accel("view.prompt-composer")?)
        .build(app)?;
    let process_panel = CheckMenuItemBuilder::with_id("view.process-panel", "Process Panel")
        .accelerator(app_accel("view.process-panel")?)
        .build(app)?;
    let git_panel = CheckMenuItemBuilder::with_id("view.git-panel", "Git Panel")
        .accelerator(app_accel("view.git-panel")?)
        .build(app)?;
    let context_panel = CheckMenuItemBuilder::with_id("view.context-panel", "Context Panel")
        .accelerator(app_accel("view.context-panel")?)
        .build(app)?;
    let cost_dashboard = MenuItemBuilder::with_id("view.cost-dashboard", "Cost Dashboard")
        .accelerator(app_accel("view.cost-dashboard")?)
        .build(app)?;
    let shortcuts = MenuItemBuilder::with_id("view.shortcuts", "Keyboard Shortcuts")
        .accelerator(app_accel("view.shortcuts")?)
        .build(app)?;

    // Split submenu
    let split_horizontal = MenuItemBuilder::with_id("view.split-horizontal", "Split Right")
        .accelerator(app_accel("view.split-horizontal")?)
        .build(app)?;
    let split_vertical = MenuItemBuilder::with_id("view.split-vertical", "Split Down")
        .accelerator(app_accel("view.split-vertical")?)
        .build(app)?;

    let split_submenu = SubmenuBuilder::new(app, "Split")
        .item(&split_horizontal)
        .item(&split_vertical)
        .build()?;

    let toggle_flow_mode = CheckMenuItemBuilder::with_id("view.flow-mode", "Flow Mode")
        .accelerator(app_accel("view.flow-mode")?)
        .build(app)?;
    let search_panel = CheckMenuItemBuilder::with_id("view.search-panel", "Search Panel")
        .accelerator(app_accel("view.search-panel")?)
        .build(app)?;

    let mut view_builder = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .item(&command_palette)
        .item(&prompt_composer)
        .separator()
        .item(&process_panel)
        .item(&git_panel)
        .item(&context_panel)
        .item(&search_panel)
        .separator()
        .item(&split_submenu)
        .item(&toggle_flow_mode)
        .separator()
        .item(&cost_dashboard)
        .item(&shortcuts)
        .separator();

    #[cfg(target_os = "macos")]
    {
        let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
        view_builder = view_builder.item(&fullscreen);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let fullscreen = MenuItemBuilder::with_id("view.fullscreen", "Toggle Fullscreen")
            .accelerator("F11")
            .build(app)?;
        view_builder = view_builder.item(&fullscreen);
    }

    let view_menu = view_builder.build()?;

    // ── Session menu ──
    let copy_context = MenuItemBuilder::with_id("session.copy-context", "Copy Context")
        .accelerator(app_accel("session.copy-context")?)
        .build(app)?;

    let session_menu = SubmenuBuilder::new(app, "Session")
        .item(&copy_context)
        .build()?;

    // ── Window menu ──
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let maximize = PredefinedMenuItem::maximize(app, None)?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&minimize)
        .item(&maximize)
        .build()?;

    // ── Help menu ──
    let help_check_update =
        MenuItemBuilder::with_id("help.check-update", "Check for Updates...").build(app)?;
    let help_website = MenuItemBuilder::with_id("help.website", "Hermes IDE Website").build(app)?;
    let help_legal =
        MenuItemBuilder::with_id("help.legal", "Privacy, Terms & License").build(app)?;
    let help_report_bug =
        MenuItemBuilder::with_id("help.report-bug", "Report a Bug...").build(app)?;
    let help_shortcuts =
        MenuItemBuilder::with_id("help.shortcuts", "Keyboard Shortcuts").build(app)?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&help_check_update)
        .separator()
        .item(&help_website)
        .item(&help_legal)
        .separator()
        .item(&help_report_bug)
        .separator()
        .item(&help_shortcuts)
        .build()?;

    // ── Build complete menu bar ──
    let menu = MenuBuilder::new(app)
        .item(&hermes_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&session_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    Ok(menu)
}

// ─── Handle Menu Bar Events ─────────────────────────────────────────

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    dispatch_menu_action(app, event.id().0.clone());
}

/// What choosing the menu item `id` does.
pub fn dispatch_menu_action(app: &AppHandle, id: String) {
    // Skip predefined items (handled by the OS)
    if id.starts_with("__") {
        return;
    }

    if id == QUIT_ID {
        crate::quit_flush::quit(app);
        return;
    }

    // Ctrl+C menu accelerator → emit dedicated SIGINT event.
    // The frontend sends \x03 to the active terminal's PTY.
    if id == "edit.send-interrupt" {
        let _ = app.emit("native-sigint", ());
        return;
    }

    let _ = app.emit("menu-action", MenuActionPayload { action: id });
}

// ─── Show Context Menu (Tauri Command) ──────────────────────────────

#[tauri::command]
pub async fn show_context_menu(
    window: tauri::Window,
    items: Vec<ContextMenuItem>,
) -> Result<(), String> {
    build_and_show_popup(&window, &items).map_err(|e| e.to_string())
}

fn build_and_show_popup(
    window: &tauri::Window,
    items: &[ContextMenuItem],
) -> Result<(), Box<dyn std::error::Error>> {
    let app = window.app_handle();
    let mut menu_builder = MenuBuilder::new(app);

    for item in items {
        menu_builder = append_context_item(app, menu_builder, item)?;
    }

    let menu = menu_builder.build()?;
    window.popup_menu(&menu)?;

    Ok(())
}

fn append_context_item<'a>(
    app: &'a AppHandle,
    mut builder: MenuBuilder<'a, Wry, AppHandle<Wry>>,
    item: &ContextMenuItem,
) -> Result<MenuBuilder<'a, Wry, AppHandle<Wry>>, Box<dyn std::error::Error>> {
    if item.is_separator {
        builder = builder.separator();
        return Ok(builder);
    }

    if !item.children.is_empty() {
        // Submenu
        let mut sub = SubmenuBuilder::new(app, &item.label);
        for child in &item.children {
            sub = append_context_submenu_item(app, sub, child)?;
        }
        let submenu = sub.build()?;
        builder = builder.item(&submenu);
        return Ok(builder);
    }

    if let Some(checked) = item.checked {
        let mut check = CheckMenuItemBuilder::with_id(&item.id, &item.label).checked(checked);
        if !item.enabled {
            check = check.enabled(false);
        }
        if let Some(ref accel) = item.accelerator {
            check = check.accelerator(accel);
        }
        let check_item = check.build(app)?;
        builder = builder.item(&check_item);
    } else {
        let mut mi = MenuItemBuilder::with_id(&item.id, &item.label);
        if !item.enabled {
            mi = mi.enabled(false);
        }
        if let Some(ref accel) = item.accelerator {
            mi = mi.accelerator(accel);
        }
        let menu_item = mi.build(app)?;
        builder = builder.item(&menu_item);
    }

    Ok(builder)
}

fn append_context_submenu_item<'a>(
    app: &'a AppHandle,
    mut builder: SubmenuBuilder<'a, Wry, AppHandle<Wry>>,
    item: &ContextMenuItem,
) -> Result<SubmenuBuilder<'a, Wry, AppHandle<Wry>>, Box<dyn std::error::Error>> {
    if item.is_separator {
        builder = builder.separator();
        return Ok(builder);
    }

    if !item.children.is_empty() {
        let mut sub = SubmenuBuilder::new(app, &item.label);
        for child in &item.children {
            sub = append_context_submenu_item(app, sub, child)?;
        }
        let submenu = sub.build()?;
        builder = builder.item(&submenu);
        return Ok(builder);
    }

    if let Some(checked) = item.checked {
        let mut check = CheckMenuItemBuilder::with_id(&item.id, &item.label).checked(checked);
        if !item.enabled {
            check = check.enabled(false);
        }
        if let Some(ref accel) = item.accelerator {
            check = check.accelerator(accel);
        }
        let check_item = check.build(app)?;
        builder = builder.item(&check_item);
    } else {
        let mut mi = MenuItemBuilder::with_id(&item.id, &item.label);
        if !item.enabled {
            mi = mi.enabled(false);
        }
        if let Some(ref accel) = item.accelerator {
            mi = mi.accelerator(accel);
        }
        let menu_item = mi.build(app)?;
        builder = builder.item(&menu_item);
    }

    Ok(builder)
}

// ─── Update Menu State (Tauri Command) ──────────────────────────────

#[tauri::command]
pub async fn update_menu_state(app: AppHandle, updates: Vec<MenuItemUpdate>) -> Result<(), String> {
    let menu = match app.menu() {
        Some(m) => m,
        None => return Ok(()),
    };

    for update in &updates {
        let item = find_menu_item_recursive(&menu, &update.id);
        if let Some(ref item) = item {
            if let Some(checked) = update.checked {
                if let Some(check_item) = item.as_check_menuitem() {
                    let _ = check_item.set_checked(checked);
                }
            }
            if let Some(enabled) = update.enabled {
                if let Some(mi) = item.as_menuitem() {
                    let _ = mi.set_enabled(enabled);
                } else if let Some(ci) = item.as_check_menuitem() {
                    let _ = ci.set_enabled(enabled);
                }
            }
            if let Some(ref text) = update.text {
                if let Some(mi) = item.as_menuitem() {
                    let _ = mi.set_text(text);
                } else if let Some(ci) = item.as_check_menuitem() {
                    let _ = ci.set_text(text);
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn find_menu_item_recursive(
    menu: &Menu<Wry>,
    target_id: &str,
) -> Option<tauri::menu::MenuItemKind<Wry>> {
    use tauri::menu::MenuItemKind;

    if let Ok(items) = menu.items() {
        for item in items {
            if item.id().0 == target_id {
                return Some(item);
            }
            if let MenuItemKind::Submenu(ref sub) = item {
                if let Some(found) = find_in_submenu(sub, target_id) {
                    return Some(found);
                }
            }
        }
    }
    None
}

fn find_in_submenu(
    submenu: &tauri::menu::Submenu<Wry>,
    target_id: &str,
) -> Option<tauri::menu::MenuItemKind<Wry>> {
    use tauri::menu::MenuItemKind;

    if let Ok(items) = submenu.items() {
        for item in items {
            if item.id().0 == target_id {
                return Some(item);
            }
            if let MenuItemKind::Submenu(ref sub) = item {
                if let Some(found) = find_in_submenu(sub, target_id) {
                    return Some(found);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_dialog_says_not_affiliated_on_every_platform() {
        let meta = about_metadata();
        assert_eq!(meta.name.as_deref(), Some("HERMES-IDE"));
        assert_eq!(meta.version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
        // Windows and Linux show `comments`; macOS shows `credits`.
        assert_eq!(meta.comments.as_deref(), Some(NON_AFFILIATION_NOTE));
        assert_eq!(meta.credits.as_deref(), Some(NON_AFFILIATION_NOTE));
        assert!(NON_AFFILIATION_NOTE.contains("Not affiliated with Nous Research"));
    }

    /// Every menu item that carries an app chord.
    const MENU_ACTIONS_WITH_CHORDS: &[&str] = &[
        "hermes.settings",
        "file.new-session",
        "file.new-session-tab",
        "file.close-pane",
        "file.file-explorer",
        "view.toggle-sidebar",
        "view.command-palette",
        "view.prompt-composer",
        "view.process-panel",
        "view.git-panel",
        "view.context-panel",
        "view.cost-dashboard",
        "view.shortcuts",
        "view.split-horizontal",
        "view.split-vertical",
        "view.flow-mode",
        "view.search-panel",
        "session.copy-context",
    ];

    fn is_bare_ctrl_letter(accel: &str) -> bool {
        let parts: Vec<&str> = accel.split('+').collect();
        parts.len() == 2
            && matches!(parts[0], "Ctrl" | "CmdOrCtrl" | "Control")
            && parts[1].len() == 1
            && parts[1].chars().all(|c| c.is_ascii_alphabetic())
    }

    #[test]
    fn every_menu_action_has_a_chord_on_both_platforms() {
        for action in MENU_ACTIONS_WITH_CHORDS {
            assert!(accelerator_for(action, true).is_some(), "{action} (mac)");
            assert!(accelerator_for(action, false).is_some(), "{action} (pc)");
        }
    }

    #[test]
    fn no_windows_linux_chord_takes_a_bare_ctrl_letter() {
        for action in MENU_ACTIONS_WITH_CHORDS {
            let accel = accelerator_for(action, false).unwrap();
            assert!(
                !is_bare_ctrl_letter(&accel),
                "{action} uses {accel}, which a terminal needs"
            );
        }
    }

    #[test]
    fn chords_are_unique_per_platform() {
        for mac in [true, false] {
            let mut seen = std::collections::HashMap::new();
            for action in MENU_ACTIONS_WITH_CHORDS {
                let accel = accelerator_for(action, mac).unwrap();
                if let Some(other) = seen.insert(accel.clone(), *action) {
                    panic!("{accel} is used by both {other} and {action} (mac={mac})");
                }
            }
        }
    }

    #[test]
    fn mac_chords_keep_their_cmd_accelerators() {
        assert_eq!(
            accelerator_for("view.split-horizontal", true).unwrap(),
            "CmdOrCtrl+D"
        );
        assert_eq!(
            accelerator_for("view.split-vertical", true).unwrap(),
            "CmdOrCtrl+Shift+D"
        );
        assert_eq!(
            accelerator_for("file.close-pane", true).unwrap(),
            "CmdOrCtrl+W"
        );
        assert_eq!(
            accelerator_for("hermes.settings", true).unwrap(),
            "CmdOrCtrl+,"
        );
    }

    #[test]
    fn windows_linux_split_is_ctrl_shift_d() {
        assert_eq!(
            accelerator_for("view.split-horizontal", false).unwrap(),
            "Ctrl+Shift+D"
        );
        assert_eq!(
            accelerator_for("file.close-pane", false).unwrap(),
            "Ctrl+Shift+W"
        );
    }

    #[test]
    fn quit_keeps_cmd_q_on_mac_and_leaves_ctrl_q_to_the_terminal() {
        assert_eq!(
            quit_label_and_accelerator(true, false),
            ("Quit HERMES-IDE", Some("CmdOrCtrl+Q"))
        );
        assert_eq!(quit_label_and_accelerator(false, true), ("Exit", None));
        assert_eq!(quit_label_and_accelerator(false, false), ("Quit", None));
    }

    #[test]
    fn unknown_action_has_no_chord() {
        assert!(accelerator_for("view.nope", false).is_none());
        assert!(app_accel("view.nope").is_err());
    }

    #[test]
    fn detects_bare_ctrl_letter() {
        assert!(is_bare_ctrl_letter("Ctrl+D"));
        assert!(is_bare_ctrl_letter("CmdOrCtrl+W"));
        assert!(!is_bare_ctrl_letter("Ctrl+Shift+D"));
        assert!(!is_bare_ctrl_letter("Ctrl+,"));
    }
}
