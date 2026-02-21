import "../styles/components/Settings.css";
import { useState, useEffect, useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { updateSettings as applyTerminalSettings } from "../terminal/TerminalPool";
import { useSession } from "../state/SessionContext";
import {
  getSettings, setSetting, exportSettings, importSettings,
  type SettingsMap,
} from "../api/settings";

interface SettingsProps {
  onClose: () => void;
}

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic (Claude)", keyName: "api_key_anthropic", models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"] },
  { id: "openai", name: "OpenAI", keyName: "api_key_openai", models: ["gpt-4o", "gpt-4", "o1-preview", "o1-mini"] },
  { id: "google", name: "Google (Gemini)", keyName: "api_key_google", models: ["gemini-2.0-flash", "gemini-2.0-pro"] },
];

const THEMES = [
  { id: "dark", label: "Dark (Default)" },
  { id: "dimmed", label: "Dark Dimmed" },
];

export function Settings({ onClose }: SettingsProps) {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [activeTab, setActiveTab] = useState("general");
  const { dispatch } = useSession();
  useEffect(() => {
    getSettings()
      .then((s) => setSettings(s))
      .catch(console.error);
  }, []);

  const AUTONOMOUS_KEYS: Record<string, string> = {
    auto_error_min_occurrences: "errorMinOccurrences",
    auto_command_min_frequency: "commandMinFrequency",
    auto_cancel_delay_ms: "cancelDelayMs",
  };

  const updateSetting = useCallback((key: string, value: string) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      if (["font_size", "font_family", "scrollback", "theme"].includes(key)) {
        applyTerminalSettings(next);
      }
      return next;
    });
    setSetting(key, value).catch(console.error);
    // Sync autonomous settings to live state
    if (key in AUTONOMOUS_KEYS) {
      dispatch({
        type: "SET_AUTONOMOUS_SETTINGS",
        settings: { [AUTONOMOUS_KEYS[key]]: parseInt(value, 10) || 0 },
      });
    }
  }, [dispatch]);

  const maskKey = (key: string | undefined) => {
    if (!key) return "";
    if (key.length <= 8) return "****";
    return key.slice(0, 4) + "..." + key.slice(-4);
  };

  const tabs = [
    { id: "general", label: "General" },
    { id: "appearance", label: "Appearance" },
    { id: "providers", label: "Providers" },
    { id: "autonomous", label: "Autonomous" },
  ];

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="close-btn settings-close" onClick={onClose}>&times;</button>
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
                    <option value="/bin/zsh">zsh</option>
                    <option value="/bin/bash">bash</option>
                    <option value="/usr/local/bin/fish">fish</option>
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
                  />
                </div>
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label">Theme</label>
                  <select
                    className="settings-select"
                    value={settings.theme || "dark"}
                    onChange={(e) => updateSetting("theme", e.target.value)}
                  >
                    {THEMES.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Font Size</label>
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
              </div>
            )}

            {activeTab === "providers" && (
              <div className="settings-section">
                <p className="settings-hint">
                  API keys are stored locally and never sent to HERMES-IDE servers.
                </p>
                {PROVIDERS.map((provider) => (
                  <div key={provider.id} className="settings-provider">
                    <div className="settings-provider-header">
                      <span className="settings-provider-name">{provider.name}</span>
                      {settings[provider.keyName] && (
                        <span className="settings-provider-status">Configured</span>
                      )}
                    </div>
                    <div className="settings-group">
                      <label className="settings-label">API Key</label>
                      <div className="settings-key-row">
                        <input
                          className="settings-input settings-key-input"
                          type="password"
                          placeholder={settings[provider.keyName] ? maskKey(settings[provider.keyName]) : "sk-..."}
                          onBlur={(e) => {
                            if (e.target.value) updateSetting(provider.keyName, e.target.value);
                          }}
                        />
                        {settings[provider.keyName] && (
                          <button
                            className="settings-key-clear"
                            onClick={() => updateSetting(provider.keyName, "")}
                          >Clear</button>
                        )}
                      </div>
                    </div>
                    <div className="settings-group">
                      <label className="settings-label">Default Model</label>
                      <select
                        className="settings-select"
                        value={settings[`model_${provider.id}`] || ""}
                        onChange={(e) => updateSetting(`model_${provider.id}`, e.target.value)}
                      >
                        <option value="">Auto-detect</option>
                        {provider.models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
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
                    Min error occurrences for auto-fix: {settings.auto_error_min_occurrences || "3"}
                  </label>
                  <input
                    type="range"
                    className="settings-range"
                    min="1" max="10" step="1"
                    value={settings.auto_error_min_occurrences || "3"}
                    onChange={(e) => updateSetting("auto_error_min_occurrences", e.target.value)}
                  />
                </div>
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
                  applyTerminalSettings(newSettings);
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
