import "../styles/components/Settings.css";
import { useState, useEffect, useCallback, useRef } from "react";
import { useTextContextMenu } from "../hooks/useTextContextMenu";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { applyTheme, THEME_OPTIONS, UI_SCALE_OPTIONS } from "../utils/themeManager";
import { fmt } from "../utils/platform";
import { useSession } from "../state/SessionContext";
import { invoke } from "@tauri-apps/api/core";
import {
  getSettings, setSetting, exportSettings, importSettings,
  type SettingsMap,
} from "../api/settings";
import { setAnalyticsEnabled } from "../utils/analytics";
import { SHORTCUT_GROUPS } from "./ShortcutsPanel";
import { PluginManager } from "./PluginManager";

interface SettingsProps {
  onClose: () => void;
  initialTab?: string;
  pluginRuntime?: import("../plugins/PluginRuntime").PluginRuntime;
  onConfirmPluginUpdate?: (plugin: import("../plugins/types").RegistryPlugin) => void;
}

const THEMES = THEME_OPTIONS;

export function Settings({ onClose, initialTab, pluginRuntime, onConfirmPluginUpdate }: SettingsProps) {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [shells, setShells] = useState<{ name: string; path: string }[]>([]);
  const [activeTab, setActiveTab] = useState(initialTab || "general");
  const { dispatch } = useSession();
  const { onContextMenu: textContextMenu } = useTextContextMenu();

  // Live window size state (separate from DB settings)
  const [winWidth, setWinWidth] = useState("");
  const [winHeight, setWinHeight] = useState("");
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
      applyTheme(next.theme || "tron", next);
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
    { id: "git", label: "Git" },
    { id: "autonomous", label: "Autonomous" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "plugins", label: "Plugins" },
    { id: "privacy", label: "Privacy" },
  ];

  return (
    <div className="settings-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
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
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label">Theme</label>
                  <select
                    className="settings-select"
                    value={settings.theme || "tron"}
                    onChange={(e) => updateSetting("theme", e.target.value)}
                  >
                    {THEMES.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
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
                <PluginManager runtime={pluginRuntime} onConfirmUpdate={onConfirmPluginUpdate} />
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
                exportSettings(path).catch(console.error);
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
                  applyTheme(newSettings.theme || "dark", newSettings);
                } catch (e) {
                  console.error(e);
                }
              }
            }}
          >
            Import Settings
          </button>
        </div>
      </div>
    </div>
  );
}
