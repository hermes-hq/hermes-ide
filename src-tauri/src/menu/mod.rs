use serde::{Deserialize, Serialize};
use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder,
    PredefinedMenuItem, SubmenuBuilder,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuActionPayload {
    pub action: String,
}

// ─── Build Application Menu Bar ─────────────────────────────────────

pub fn build_app_menu(app: &AppHandle) -> Result<Menu<Wry>, Box<dyn std::error::Error>> {
    // ── Hermes menu (app menu) ──
    let about = PredefinedMenuItem::about(
        app,
        Some("About HERMES-IDE"),
        Some(
            AboutMetadataBuilder::new()
                .name(Some("HERMES-IDE"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .build(),
        ),
    )?;
    let settings = MenuItemBuilder::with_id("hermes.settings", "Settings...")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;

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
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_tab = MenuItemBuilder::with_id("file.new-session-tab", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let close_pane = MenuItemBuilder::with_id("file.close-pane", "Close Pane")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let open_file_explorer = MenuItemBuilder::with_id("file.file-explorer", "File Explorer")
        .accelerator("CmdOrCtrl+F")
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
        .accelerator("CmdOrCtrl+B")
        .checked(true)
        .build(app)?;
    let command_palette = MenuItemBuilder::with_id("view.command-palette", "Command Palette")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let prompt_composer = MenuItemBuilder::with_id("view.prompt-composer", "Prompt Composer")
        .accelerator("CmdOrCtrl+J")
        .build(app)?;
    let process_panel = CheckMenuItemBuilder::with_id("view.process-panel", "Process Panel")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let git_panel = CheckMenuItemBuilder::with_id("view.git-panel", "Git Panel")
        .accelerator("CmdOrCtrl+G")
        .build(app)?;
    let context_panel = CheckMenuItemBuilder::with_id("view.context-panel", "Context Panel")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let timeline = CheckMenuItemBuilder::with_id("view.timeline", "Execution Timeline")
        .accelerator("CmdOrCtrl+Shift+T")
        .build(app)?;
    let cost_dashboard = MenuItemBuilder::with_id("view.cost-dashboard", "Cost Dashboard")
        .accelerator("CmdOrCtrl+$")
        .build(app)?;
    let shortcuts = MenuItemBuilder::with_id("view.shortcuts", "Keyboard Shortcuts")
        .accelerator("CmdOrCtrl+/")
        .build(app)?;

    // Split submenu
    let split_horizontal = MenuItemBuilder::with_id("view.split-horizontal", "Split Right")
        .accelerator("CmdOrCtrl+D")
        .build(app)?;
    let split_vertical = MenuItemBuilder::with_id("view.split-vertical", "Split Down")
        .accelerator("CmdOrCtrl+Shift+D")
        .build(app)?;

    let split_submenu = SubmenuBuilder::new(app, "Split")
        .item(&split_horizontal)
        .item(&split_vertical)
        .build()?;

    let toggle_flow_mode = CheckMenuItemBuilder::with_id("view.flow-mode", "Flow Mode")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let search_panel = CheckMenuItemBuilder::with_id("view.search-panel", "Search Panel")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;

    let mut view_builder = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .item(&command_palette)
        .item(&prompt_composer)
        .separator()
        .item(&process_panel)
        .item(&git_panel)
        .item(&context_panel)
        .item(&timeline)
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
        .accelerator("CmdOrCtrl+Shift+C")
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
    let id = event.id().0.clone();

    // Skip predefined items (handled by the OS)
    if id.starts_with("__") {
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
        }
    }
    Ok(())
}

fn find_menu_item_recursive(
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
