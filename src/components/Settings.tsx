import "../styles/components/Settings.css";
import { useState, useEffect, useCallback, useRef } from "react";
import { useResizablePanel } from "../hooks/useResizablePanel";
import { useTextContextMenu } from "../hooks/useTextContextMenu";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { applyTheme, DARK_THEMES, LIGHT_THEMES, UI_SCALE_OPTIONS } from "../utils/themeManager";
import { fmt, PLATFORM } from "../utils/platform";
import {
  AI_PROVIDERS,
  AI_AGENT_PREFIXES_KEY,
  PREFIX_EXAMPLES,
  parseAgentPrefixes,
  serializeAgentPrefixes,
  getPrefixPlaceholder,
  buildLaunchPreview,
  type AgentPrefixMap,
} from "../utils/aiProviders";
import { useSession } from "../state/SessionContext";
import { invoke } from "@tauri-apps/api/core";
import {
  getSettings, setSetting, exportSettings, importSettings,
  type SettingsMap,
} from "../api/settings";
import { listSshSavedHosts, upsertSshSavedHost, deleteSshSavedHost, type SshSavedHost } from "../api/ssh";
import { setAnalyticsEnabled } from "../utils/analytics";
import { SHORTCUT_GROUPS } from "./ShortcutsPanel";
import { PluginManager } from "./PluginManager";

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SETTINGS PAGE — EXPORT / IMPORT CONTRACT                              ║
// ║                                                                        ║
// ║  Every setting displayed here is persisted via setSetting(key, value)   ║
// ║  and automatically included in settings export/import.                 ║
// ║                                                                        ║
// ║  When adding a new setting:                                            ║
// ║  1. Add the key to VALID_SETTING_KEYS in src-tauri/src/db/mod.rs       ║
// ║  2. If it's machine-specific (paths, geometry, timestamps), also add   ║
// ║     it to EXPORT_EXCLUDED_KEYS in the same file so it won't export.    ║
// ║  3. Add the UI control in the appropriate tab below.                   ║
// ║                                                                        ║
// ║  When renaming or removing a setting:                                  ║
// ║  1. Update VALID_SETTING_KEYS (remove old, add new).                   ║
// ║  2. Consider whether imported files from older versions need the old   ║
// ║     key mapped to the new one (add migration logic in import_settings  ║
// ║     in db/mod.rs).                                                     ║
// ║                                                                        ║
// ║  Plugin settings are stored separately (plugin_storage table) and are  ║
// ║  NOT included in app settings export. Plugins manage their own data.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

interface SettingsProps {
  onClose: () => void;
  initialTab?: string;
  pluginRuntime?: import("../plugins/PluginRuntime").PluginRuntime;
  onConfirmPluginUpdate?: (plugin: import("../plugins/types").RegistryPlugin) => void;
  onConfirmPluginUpdateAll?: (plugins: import("../plugins/types").RegistryPlugin[]) => void;
  pluginRefreshTrigger?: number;
}

export function Settings({ onClose, initialTab, pluginRuntime, onConfirmPluginUpdate, onConfirmPluginUpdateAll, pluginRefreshTrigger }: SettingsProps) {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [shells, setShells] = useState<{ name: string; path: string }[]>([]);
  const [activeTab, setActiveTab] = useState(initialTab || "general");
  const [sshHosts, setSshHosts] = useState<SshSavedHost[]>([]);
  const [editingHost, setEditingHost] = useState<SshSavedHost | null>(null);
  const [footerStatus, setFooterStatusRaw] = useState<string | null>(null);
  const footerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setFooterStatus = useCallback((msg: string) => {
    if (footerTimer.current) clearTimeout(footerTimer.current);
    setFooterStatusRaw(msg);
    footerTimer.current = setTimeout(() => setFooterStatusRaw(null), 4000);
  }, []);
  const { dispatch } = useSession();
  const { onContextMenu: textContextMenu } = useTextContextMenu();

  // Live window size state (separate from DB settings)
  const [winWidth, setWinWidth] = useState("");
  const [winHeight, setWinHeight] = useState("");
  const { panelWidth, panelHeight, onResizeWidthStart, onResizeHeightStart, handleOverlayClick } = useResizablePanel({
    defaultWidth: 560,
    defaultHeight: 520,
    minWidth: 420,
    minHeight: 360,
    maxWidthRatio: 0.9,
    maxHeightRatio: 0.7,
    widthKey: "settings_panel_width",
    heightKey: "settings_panel_height",
  });
  const resizeUnlisten = useRef<(() => void) | null>(null);
  const programmaticResize = useRef(false);
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    getSettings()
      .then((s) => setSettings(s))
      .catch(console.error);

    invoke<{ name: string; path: string }[]>("get_available_shells")
      .then(setShells)
      .catch(console.error);

    listSshSavedHosts().then(setSshHosts).catch(console.error);

    // Read live window size
    const win = getCurrentWindow();
    const readSize = async () => {
      if (programmaticResize.current) return;
      const size = await win.innerSize();
      const factor = await win.scaleFactor();
      setWinWidth(String(Math.round(size.width / factor)));
      setWinHeight(String(Math.round(size.height / factor)));
    };
    readSize();

    // Track live resizes while Settings is open
    win.onResized(() => { readSize(); }).then((unlisten) => {
      resizeUnlisten.current = unlisten;
    });

    return () => {
      resizeUnlisten.current?.();
      if (applyTimer.current) clearTimeout(applyTimer.current);
      if (footerTimer.current) clearTimeout(footerTimer.current);
    };
  }, []);

  const AUTONOMOUS_KEYS: Record<string, string> = {
    auto_command_min_frequency: "commandMinFrequency",
    auto_cancel_delay_ms: "cancelDelayMs",
  };

  const updateSetting = useCallback((key: string, value: string) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    if (key === "theme") {
      applyTheme(value, next);
    } else if (["font_size", "font_family", "scrollback", "ui_scale"].includes(key)) {
      applyTheme(next.theme || "frosted-dark", next);
    }
    setSetting(key, value).catch(console.error);
    // Sync autonomous settings to live state
    if (key in AUTONOMOUS_KEYS) {
      dispatch({
        type: "SET_AUTONOMOUS_SETTINGS",
        settings: { [AUTONOMOUS_KEYS[key]]: parseInt(value, 10) || 0 },
      });
    }
  }, [settings, dispatch]);

  const applyWindowSize = useCallback((widthStr: string, heightStr: string, immediate = false) => {
    if (applyTimer.current) clearTimeout(applyTimer.current);
    const delay = immediate ? 0 : 400;
    applyTimer.current = setTimeout(async () => {
      const w = Math.max(parseInt(widthStr, 10) || 0, 600);
      const h = Math.max(parseInt(heightStr, 10) || 0, 400);
      if (w > 0 && h > 0) {
        programmaticResize.current = true;
        try {
          await getCurrentWindow().setSize(new LogicalSize(w, h));
          setSetting("window_width", String(w)).catch(console.error);
          setSetting("window_height", String(h)).catch(console.error);
        } catch {
          /* ignore */
        } finally {
          setTimeout(() => { programmaticResize.current = false; }, 300);
        }
      }
    }, delay);
  }, []);

  const latestW = useRef(winWidth);
  const latestH = useRef(winHeight);
  latestW.current = winWidth;
  latestH.current = winHeight;

  const stepValue = useCallback((field: "w" | "h", delta: number) => {
    const current = parseInt(field === "w" ? latestW.current : latestH.current, 10) || 0;
    const min = field === "w" ? 600 : 400;
    const newVal = String(Math.max(current + delta, min));
    if (field === "w") {
      setWinWidth(newVal);
      applyWindowSize(newVal, latestH.current, true);
    } else {
      setWinHeight(newVal);
      applyWindowSize(latestW.current, newVal, true);
    }
  }, [applyWindowSize]);

  // Hold-to-repeat for arrow buttons
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRepeat = useCallback((field: "w" | "h", delta: number) => {
    stepValue(field, delta);
    const timeout = setTimeout(() => {
      repeatTimer.current = setInterval(() => stepValue(field, delta), 60);
    }, 350);
    repeatTimer.current = timeout as unknown as ReturnType<typeof setInterval>;
  }, [stepValue]);
  const stopRepeat = useCallback(() => {
    if (repeatTimer.current) { clearInterval(repeatTimer.current); clearTimeout(repeatTimer.current as unknown as ReturnType<typeof setTimeout>); repeatTimer.current = null; }
  }, []);

  const tabs = [
    { id: "general", label: "General" },
    { id: "appearance", label: "Appearance" },
    { id: "ssh", label: "SSH" },
    { id: "git", label: "Git" },
    { id: "autonomous", label: "Autonomous" },
    { id: "ai-agent", label: "AI Agent" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "plugins", label: "Plugins" },
    { id: "privacy", label: "Privacy" },
  ];

  return (
    <div
      className="settings-overlay"
      onClick={() => handleOverlayClick(onClose)}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="settings-panel" onClick={(e) => e.stopPropagation()} style={{ width: panelWidth, height: panelHeight }}>
        <div className="settings-resize-handle" onMouseDown={onResizeWidthStart} />
        <div className="settings-resize-handle-bottom" onMouseDown={onResizeHeightStart} />
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="close-btn settings-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="settings-body">
          <div className="settings-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`settings-tab ${activeTab === tab.id ? "settings-tab-active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="settings-content">
            {activeTab === "general" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label">Default Shell</label>
                  <select
                    className="settings-select"
                    value={settings.default_shell || ""}
                    onChange={(e) => updateSetting("default_shell", e.target.value)}
                  >
                    <option value="">System default</option>
                    {shells.map((s) => (
                      <option key={s.path} value={s.path}>{s.name}</option>
                    ))}
                  </select>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Terminal Scrollback</label>
                  <select
                    className="settings-select"
                    value={settings.scrollback || "10000"}
                    onChange={(e) => updateSetting("scrollback", e.target.value)}
                  >
                    <option value="5000">5,000 lines</option>
                    <option value="10000">10,000 lines</option>
                    <option value="25000">25,000 lines</option>
                    <option value="50000">50,000 lines</option>
                  </select>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Default Working Directory</label>
                  <input
                    className="settings-input"
                    placeholder="~ (home directory)"
                    value={settings.default_cwd || ""}
                    onChange={(e) => updateSetting("default_cwd", e.target.value)}
                    onContextMenu={textContextMenu}
                  />
                </div>

                <div className="settings-group">
                  <label className="settings-label">Command Palette Shortcut</label>
                  <select
                    className="settings-select"
                    value={settings.command_palette_shortcut || "cmd_k"}
                    onChange={(e) => updateSetting("command_palette_shortcut", e.target.value)}
                  >
                    <option value="cmd_k">{fmt("{mod}K")} (default)</option>
                    <option value="cmd_shift_p">{fmt("{mod}{shift}P")} (frees {fmt("{mod}K")} for Clear Terminal)</option>
                  </select>
                  <span className="settings-hint-inline">Requires restart to update the native menu</span>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Preferred External Editor</label>
                  <select
                    className="settings-select"
                    value={settings.preferred_editor || ""}
                    onChange={(e) => updateSetting("preferred_editor", e.target.value)}
                  >
                    <option value="">System Default</option>
                    <option value="code">VS Code</option>
                    <option value="cursor">Cursor</option>
                    <option value="zed">Zed</option>
                    <option value="subl">Sublime Text</option>
                    <option value="idea">IntelliJ IDEA</option>
                    <option value="webstorm">WebStorm</option>
                    <option value="atom">Atom</option>
                    <option value="vim">Vim</option>
                    <option value="nvim">Neovim</option>
                    <option value="emacs">Emacs</option>
                  </select>
                  <span className="settings-hint-inline">Editor used when opening files from the file browser</span>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Restore Sessions on Launch</label>
                  <select
                    className="settings-select"
                    value={settings.restore_sessions || "always"}
                    onChange={(e) => updateSetting("restore_sessions", e.target.value)}
                  >
                    <option value="always">Always</option>
                    <option value="never">Never</option>
                  </select>
                  <span className="settings-hint-inline">Re-open previous sessions and layout when the app restarts</span>
                </div>

                <div className="settings-group">
                  <label className="settings-label">
                    <input
                      type="checkbox"
                      checked={settings.skip_close_confirm !== "true"}
                      onChange={(e) => {
                        const skip = !e.target.checked;
                        updateSetting("skip_close_confirm", skip ? "true" : "false");
                        dispatch({ type: "SET_SKIP_CLOSE_CONFIRM", skip });
                      }}
                    />
                    {" "}Confirm before closing sessions
                  </label>
                  <span className="settings-hint-inline">Show a confirmation dialog when closing a terminal session</span>
                </div>
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label">Theme</label>
                  <div
                    className="settings-theme-grid"
                    onMouseLeave={() => {
                      const saved = settings.theme || "frosted-dark";
                      applyTheme(saved, settings);
                    }}
                  >
                    <span className="settings-theme-group-label">Dark</span>
                    {DARK_THEMES.map((t) => (
                      <button
                        key={t.id}
                        className={`settings-theme-item${(settings.theme || "frosted-dark") === t.id ? " settings-theme-item-active" : ""}`}
                        onClick={() => updateSetting("theme", t.id)}
                        onMouseEnter={() => applyTheme(t.id, { ...settings, theme: t.id })}
                      >
                        {t.label}
                      </button>
                    ))}
                    <div className="settings-theme-separator" />
                    <span className="settings-theme-group-label">Light</span>
                    {LIGHT_THEMES.map((t) => (
                      <button
                        key={t.id}
                        className={`settings-theme-item${(settings.theme || "frosted-dark") === t.id ? " settings-theme-item-active" : ""}`}
                        onClick={() => updateSetting("theme", t.id)}
                        onMouseEnter={() => applyTheme(t.id, { ...settings, theme: t.id })}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-group">
                  <label className="settings-label">UI Scale</label>
                  <span className="settings-hint-inline">Scales icons, text and spacing (not terminal)</span>
                  <select
                    className="settings-select"
                    value={settings.ui_scale || "default"}
                    onChange={(e) => updateSetting("ui_scale", e.target.value)}
                  >
                    {UI_SCALE_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Terminal Font Size</label>
                  <select
                    className="settings-select"
                    value={settings.font_size || "14"}
                    onChange={(e) => updateSetting("font_size", e.target.value)}
                  >
                    {[12, 13, 14, 15, 16, 18].map((s) => (
                      <option key={s} value={String(s)}>{s}px</option>
                    ))}
                  </select>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Font Family</label>
                  <select
                    className="settings-select"
                    value={settings.font_family || "default"}
                    onChange={(e) => updateSetting("font_family", e.target.value)}
                  >
                    <option value="default">SF Mono (default)</option>
                    <option value="fira">Fira Code</option>
                    <option value="jetbrains">JetBrains Mono</option>
                    <option value="cascadia">Cascadia Code</option>
                    <option value="menlo">Menlo</option>
                  </select>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Window Size</label>
                  <div className="settings-size-row">
                    <div className="settings-stepper">
                      <button
                        className="settings-stepper-btn"
                        onPointerDown={() => startRepeat("w", -10)}
                        onPointerUp={stopRepeat}
                        onPointerLeave={stopRepeat}
                        title="Decrease width"
                      >&#9666;</button>
                      <input
                        className="settings-stepper-input"
                        type="text"
                        inputMode="numeric"
                        placeholder="1200"
                        value={winWidth}
                        onChange={(e) => { setWinWidth(e.target.value); applyWindowSize(e.target.value, latestH.current); }}
                        onContextMenu={textContextMenu}
                      />
                      <button
                        className="settings-stepper-btn"
                        onPointerDown={() => startRepeat("w", 10)}
                        onPointerUp={stopRepeat}
                        onPointerLeave={stopRepeat}
                        title="Increase width"
                      >&#9656;</button>
                    </div>
                    <span className="settings-size-separator">&times;</span>
                    <div className="settings-stepper">
                      <button
                        className="settings-stepper-btn"
                        onPointerDown={() => startRepeat("h", -10)}
                        onPointerUp={stopRepeat}
                        onPointerLeave={stopRepeat}
                        title="Decrease height"
                      >&#9666;</button>
                      <input
                        className="settings-stepper-input"
                        type="text"
                        inputMode="numeric"
                        placeholder="800"
                        value={winHeight}
                        onChange={(e) => { setWinHeight(e.target.value); applyWindowSize(latestW.current, e.target.value); }}
                        onContextMenu={textContextMenu}
                      />
                      <button
                        className="settings-stepper-btn"
                        onPointerDown={() => startRepeat("h", 10)}
                        onPointerUp={stopRepeat}
                        onPointerLeave={stopRepeat}
                        title="Increase height"
                      >&#9656;</button>
                    </div>
                    <span className="settings-size-unit">px</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "shortcuts" && (
              <div className="settings-section">
                <p className="settings-hint">
                  All available keyboard shortcuts. Customization coming soon.
                </p>
                {SHORTCUT_GROUPS.map((group) => (
                  <div key={group.label} className="settings-shortcut-group">
                    <div className="settings-shortcut-group-label">{group.label}</div>
                    {group.shortcuts.map((s) => (
                      <div key={s.keys} className="settings-shortcut-row">
                        <span className="settings-shortcut-action">{s.action}</span>
                        <kbd className="settings-shortcut-kbd">{s.keys}</kbd>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {activeTab === "ssh" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label">SSH File Editor</label>
                  <select
                    className="settings-select"
                    value={settings.preferred_ssh_editor || "vim"}
                    onChange={(e) => updateSetting("preferred_ssh_editor", e.target.value)}
                  >
                    <optgroup label="Terminal editors (run in PTY)">
                      <option value="vim">Vim</option>
                      <option value="nvim">Neovim</option>
                      <option value="nano">Nano</option>
                      <option value="emacs">Emacs</option>
                      <option value="vi">Vi</option>
                    </optgroup>
                    <optgroup label="GUI editors (open locally via SSH remote)">
                      <option value="code">VS Code (Remote SSH)</option>
                      <option value="cursor">Cursor (Remote SSH)</option>
                      <option value="zed">Zed (Remote SSH)</option>
                    </optgroup>
                  </select>
                  <span className="settings-hint-inline">Editor used when opening files on SSH sessions</span>
                </div>

                <h3 className="settings-section-title" style={{ marginTop: 16 }}>Saved Hosts</h3>

                {sshHosts.length > 0 && (
                  <div className="settings-ssh-hosts-list">
                    {sshHosts.map((h) => (
                      <div key={h.id} className="settings-ssh-host-item">
                        <div className="settings-ssh-host-info">
                          <span className="settings-ssh-host-label">{h.label}</span>
                          <span className="settings-ssh-host-detail">{h.user}@{h.host}{h.port !== 22 ? `:${h.port}` : ""}</span>
                        </div>
                        <div className="settings-ssh-host-actions">
                          <button
                            className="settings-btn-sm"
                            onClick={() => setEditingHost({ ...h })}
                          >Edit</button>
                          <button
                            className="settings-btn-sm settings-btn-danger"
                            onClick={async () => {
                              await deleteSshSavedHost(h.id);
                              setSshHosts((prev) => prev.filter((x) => x.id !== h.id));
                            }}
                          >Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {sshHosts.length === 0 && !editingHost && (
                  <p className="settings-hint">No saved SSH hosts yet.</p>
                )}

                {editingHost ? (
                  <div className="settings-ssh-host-form">
                    <div className="settings-group">
                      <label className="settings-label">Label</label>
                      <input
                        className="settings-input"
                        placeholder="My Server"
                        value={editingHost.label}
                        onChange={(e) => setEditingHost({ ...editingHost, label: e.target.value })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label">Host</label>
                      <input
                        className="settings-input"
                        placeholder="example.com"
                        value={editingHost.host}
                        onChange={(e) => setEditingHost({ ...editingHost, host: e.target.value })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label">User</label>
                      <input
                        className="settings-input"
                        placeholder="root"
                        value={editingHost.user}
                        onChange={(e) => setEditingHost({ ...editingHost, user: e.target.value })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label">Port</label>
                      <input
                        className="settings-input"
                        type="number"
                        placeholder="22"
                        value={editingHost.port}
                        onChange={(e) => setEditingHost({ ...editingHost, port: parseInt(e.target.value) || 22 })}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label">Identity File (optional)</label>
                      <input
                        className="settings-input"
                        placeholder="~/.ssh/id_rsa"
                        value={editingHost.identity_file || ""}
                        onChange={(e) => setEditingHost({ ...editingHost, identity_file: e.target.value || null })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label">Jump Host (optional)</label>
                      <input
                        className="settings-input"
                        placeholder="bastion.example.com"
                        value={editingHost.jump_host || ""}
                        onChange={(e) => setEditingHost({ ...editingHost, jump_host: e.target.value || null })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-ssh-host-form-actions">
                      <button
                        className="settings-btn"
                        onClick={async () => {
                          if (!editingHost.label.trim() || !editingHost.host.trim() || !editingHost.user.trim()) return;
                          await upsertSshSavedHost(editingHost);
                          const hosts = await listSshSavedHosts();
                          setSshHosts(hosts);
                          setEditingHost(null);
                        }}
                      >Save</button>
                      <button className="settings-btn" onClick={() => setEditingHost(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="settings-btn"
                    style={{ marginTop: 8 }}
                    onClick={() => setEditingHost({
                      id: crypto.randomUUID(),
                      label: "",
                      host: "",
                      port: 22,
                      user: "",
                      identity_file: null,
                      jump_host: null,
                      port_forwards: "[]",
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    })}
                  >Add Host</button>
                )}
              </div>
            )}

            {activeTab === "git" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label">Auto-refresh Interval</label>
                  <select
                    className="settings-select"
                    value={settings.git_poll_interval || "3000"}
                    onChange={(e) => updateSetting("git_poll_interval", e.target.value)}
                  >
                    <option value="1000">1 second</option>
                    <option value="3000">3 seconds</option>
                    <option value="5000">5 seconds</option>
                    <option value="10000">10 seconds</option>
                    <option value="0">Off</option>
                  </select>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Author Name Override</label>
                  <input
                    className="settings-input"
                    placeholder="Use git config (default)"
                    value={settings.git_author_name || ""}
                    onChange={(e) => updateSetting("git_author_name", e.target.value)}
                    onContextMenu={textContextMenu}
                  />
                </div>

                <div className="settings-group">
                  <label className="settings-label">Author Email Override</label>
                  <input
                    className="settings-input"
                    placeholder="Use git config (default)"
                    value={settings.git_author_email || ""}
                    onChange={(e) => updateSetting("git_author_email", e.target.value)}
                    onContextMenu={textContextMenu}
                  />
                </div>

                <div className="settings-group">
                  <label className="settings-label settings-label-row">
                    <input
                      type="checkbox"
                      checked={settings.git_auto_stage === "true"}
                      onChange={(e) => updateSetting("git_auto_stage", e.target.checked ? "true" : "false")}
                    />
                    Auto-stage all changes on commit
                  </label>
                </div>

                <div className="settings-group">
                  <label className="settings-label settings-label-row">
                    <input
                      type="checkbox"
                      checked={settings.git_show_untracked !== "false"}
                      onChange={(e) => updateSetting("git_show_untracked", e.target.checked ? "true" : "false")}
                    />
                    Show untracked files
                  </label>
                </div>
              </div>
            )}


            {activeTab === "autonomous" && (
              <div className="settings-section">
                <p className="settings-hint">
                  Autonomous mode auto-executes frequent commands and repeated error fixes
                  after a countdown. Adjust thresholds below.
                </p>
                <div className="settings-group">
                  <label className="settings-label">
                    Min command frequency for auto-predict: {settings.auto_command_min_frequency || "5"}
                  </label>
                  <input
                    type="range"
                    className="settings-range"
                    min="2" max="20" step="1"
                    value={settings.auto_command_min_frequency || "5"}
                    onChange={(e) => updateSetting("auto_command_min_frequency", e.target.value)}
                  />
                </div>
                <div className="settings-group">
                  <label className="settings-label">
                    Cancel delay: {settings.auto_cancel_delay_ms ? `${parseInt(settings.auto_cancel_delay_ms) / 1000}s` : "3s"}
                  </label>
                  <input
                    type="range"
                    className="settings-range"
                    min="1000" max="10000" step="1000"
                    value={settings.auto_cancel_delay_ms || "3000"}
                    onChange={(e) => updateSetting("auto_cancel_delay_ms", e.target.value)}
                  />
                </div>
              </div>
            )}

            {activeTab === "ai-agent" && (
              <AiAgentSettingsTab
                settings={settings}
                updateSetting={updateSetting}
              />
            )}

            {activeTab === "plugins" && (
              <>
                <div className="settings-section">
                  <h3 className="settings-section-title">Plugin Updates</h3>
                  <div className="settings-group">
                    <label className="settings-label">Check for plugin updates</label>
                    <select
                      className="settings-select"
                      value={settings.plugin_update_check || "startup"}
                      onChange={(e) => updateSetting("plugin_update_check", e.target.value)}
                    >
                      <option value="startup">On startup</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="never">Never</option>
                    </select>
                  </div>
                  <div className="settings-group">
                    <label className="settings-label-row">
                      <input
                        type="checkbox"
                        checked={settings.plugin_auto_update === "true"}
                        onChange={(e) =>
                          updateSetting("plugin_auto_update", e.target.checked ? "true" : "false")
                        }
                      />
                      Auto-update plugins
                    </label>
                    <p className="settings-hint">
                      Automatically install plugin updates when they become available.
                    </p>
                  </div>
                </div>
                <PluginManager runtime={pluginRuntime} onConfirmUpdate={onConfirmPluginUpdate} onConfirmUpdateAll={onConfirmPluginUpdateAll} refreshTrigger={pluginRefreshTrigger} />
              </>
            )}

            {activeTab === "privacy" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label-row">
                    <input
                      type="checkbox"
                      checked={settings.telemetry_enabled === "true"}
                      onChange={(e) => {
                        const val = e.target.checked;
                        updateSetting("telemetry_enabled", val ? "true" : "false");
                        setAnalyticsEnabled(val);
                      }}
                    />
                    Send anonymous usage analytics
                  </label>
                  <p className="settings-hint">
                    Help improve Hermes IDE by sending anonymous usage data. No personal information, terminal content, or file paths are collected.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="settings-footer">
          <button
            className="settings-btn"
            onClick={async () => {
              const path = await save({
                defaultPath: "settings.json",
                filters: [{ name: "JSON", extensions: ["json"] }],
              });
              if (path) {
                try {
                  await exportSettings(path);
                  setFooterStatus("Settings exported");
                } catch (e) {
                  setFooterStatus(`Export failed: ${e}`);
                }
              }
            }}
          >
            Export Settings
          </button>
          <button
            className="settings-btn"
            onClick={async () => {
              const path = await open({
                filters: [{ name: "JSON", extensions: ["json"] }],
                multiple: false,
              });
              if (path) {
                try {
                  const newSettings = await importSettings(path);
                  setSettings(newSettings);
                  // Apply theme + UI scale
                  applyTheme(newSettings.theme || "dark", newSettings);
                  // Sync analytics state
                  setAnalyticsEnabled(newSettings.telemetry_enabled === "true");
                  // Sync autonomous settings to live state
                  for (const [settingKey, stateKey] of Object.entries(AUTONOMOUS_KEYS)) {
                    if (newSettings[settingKey]) {
                      dispatch({
                        type: "SET_AUTONOMOUS_SETTINGS",
                        settings: { [stateKey]: parseInt(newSettings[settingKey], 10) || 0 },
                      });
                    }
                  }
                  setFooterStatus("Settings imported");
                } catch (e) {
                  setFooterStatus(`Import failed: ${e}`);
                }
              }
            }}
          >
            Import Settings
          </button>
          {footerStatus && <span className="settings-footer-status">{footerStatus}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── AI Agent Settings Tab ──────────────────────────────────────────
//
// Displays per-agent prefix + suffix configuration. The prefix is stored as a
// single JSON blob under `ai_agent_prefixes`, so adding a new provider to
// AI_PROVIDERS never requires a DB schema or settings-whitelist change.

interface AiAgentSettingsTabProps {
  settings: SettingsMap;
  updateSetting: (key: string, value: string) => void;
}

function AiAgentSettingsTab({ settings, updateSetting }: AiAgentSettingsTabProps) {
  const prefixes = parseAgentPrefixes(settings[AI_AGENT_PREFIXES_KEY]);
  const examples = PREFIX_EXAMPLES[PLATFORM];
  const placeholder = getPrefixPlaceholder(PLATFORM);
  const globalSuffix = settings.custom_command_suffix || "";
  const defaultMode = (settings.default_permission_mode || "default") as import("../types/session").PermissionMode;

  const setPrefix = (providerId: string, value: string) => {
    const next: AgentPrefixMap = { ...prefixes, [providerId]: value };
    // Drop empty entries so serialized blob stays compact.
    if (!value.trim()) delete next[providerId];
    updateSetting(AI_AGENT_PREFIXES_KEY, serializeAgentPrefixes(next));
  };

  return (
    <div className="settings-section">
      <p className="settings-hint">
        Default permission mode and launch-command customization for new AI agent sessions.
        All values can be overridden per session in the session creator.
      </p>

      <div className="settings-group">
        <label className="settings-label">Default permission mode</label>
        <select
          className="settings-select"
          value={settings.default_permission_mode || "default"}
          onChange={(e) => updateSetting("default_permission_mode", e.target.value)}
        >
          <option value="default">Ask Permissions</option>
          <option value="acceptEdits">Accept Edits</option>
          <option value="plan">Plan Mode</option>
          <option value="auto">Auto Mode</option>
          <option value="bypassPermissions">Bypass Permissions</option>
        </select>
      </div>

      <div className="settings-group">
        <label className="settings-label">Custom command suffix (applies to every agent)</label>
        <input
          type="text"
          className="settings-input"
          value={settings.custom_command_suffix || ""}
          onChange={(e) => updateSetting("custom_command_suffix", e.target.value)}
          placeholder="e.g. --model opus --max-tokens 4096"
        />
        <p className="settings-hint">
          Text appended to AI agent launch commands in every new session.
        </p>
      </div>

      <h3 className="settings-section-title" style={{ marginTop: 16 }}>Per-agent launch prefix</h3>
      <p className="settings-hint">
        Prepended to the launch command for the matching agent — e.g. {" "}
        <code>caffeinate -i claude</code> on macOS or <code>wsl claude</code> on Windows.
        Runs on your local machine. Ignored for SSH sessions.
      </p>

      <fieldset className="settings-agent-prefix-grid">
        <legend className="settings-agent-prefix-legend">Agents</legend>
        {AI_PROVIDERS.map((p) => {
          const value = prefixes[p.id] ?? "";
          const inputId = `agent-prefix-${p.id}`;
          const hintId = `agent-prefix-hint-${p.id}`;
          const preview = buildLaunchPreview(p.id, defaultMode, value, globalSuffix);
          return (
            <div key={p.id} className="settings-agent-prefix-row">
              <label htmlFor={inputId} className="settings-agent-prefix-label">
                {p.label}
              </label>
              <input
                id={inputId}
                type="text"
                className="settings-input"
                value={value}
                onChange={(e) => setPrefix(p.id, e.target.value)}
                placeholder={placeholder}
                aria-describedby={hintId}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              {examples.length > 0 && (
                <div className="settings-agent-prefix-chips" role="group" aria-label={`${p.label} prefix examples`}>
                  {examples.map((ex) => (
                    <button
                      key={ex.value}
                      type="button"
                      className="settings-agent-prefix-chip"
                      title={ex.hint}
                      onClick={() => setPrefix(p.id, ex.value)}
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
              )}
              <div
                id={hintId}
                className="settings-agent-prefix-preview"
                aria-live="polite"
              >
                <span className="settings-agent-prefix-preview-label">Preview</span>
                <code className="settings-agent-prefix-preview-cmd">{preview || p.label}</code>
              </div>
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}
