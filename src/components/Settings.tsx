import "../styles/components/Settings.css";
import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { createPortal } from "react-dom";
import { Button, CloseButton, IconButton } from "./ui/Button";
import { Chip } from "./ui/Chip";
import { Toggle } from "./ui/Choice";
import { Input } from "./ui/Input";
import { NativeSelect } from "./ui/Select";
import { TabPanel, Tabs } from "./ui/Tabs";
import { lazyView } from "../utils/lazyView";
import { useResizablePanel } from "../hooks/useResizablePanel";
import { useTextContextMenu } from "../hooks/useTextContextMenu";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { applyTheme, applyAgentTimelineStyle, DARK_THEMES, LIGHT_THEMES, UI_SCALE_OPTIONS } from "../utils/themeManager";
import { fmt, PLATFORM } from "../utils/platform";
import { shortcutLabel } from "../utils/keymap";
import {
  AI_AGENT_PREFIXES_KEY,
  PREFIX_EXAMPLES,
  parseAgentPrefixes,
  serializeAgentPrefixes,
  getPrefixPlaceholder,
  type AgentPrefixMap,
} from "../utils/aiProviders";
import { buildLaunchPreview, listAgents } from "../catalog/agentCatalog";
import { useSession } from "../state/SessionContext";
import { invoke } from "@tauri-apps/api/core";
import {
  getSettings, setSetting, exportSettings, importSettings,
  type SettingsMap,
} from "../api/settings";
import { listSshSavedHosts, upsertSshSavedHost, deleteSshSavedHost, type SshSavedHost } from "../api/ssh";
import { setAnalyticsEnabled } from "../utils/analytics";
import { normalizeUpdateChannel } from "../api/updater";
import { GENERATED_SHORTCUT_GROUPS } from "../generated/shortcuts";
import { visibleShortcutGroups } from "../utils/shortcuts";
import { AgentDoctor } from "./AgentDoctor";
import { ensureDoctor, useAgentDoctor } from "../launcher/doctorStore";
import { useI18n } from "../i18n/I18nProvider";
import { setStatusStripEnabled } from "../statusStrip/preference";
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_OVERRIDES_KEY,
  parseFeatureFlagOverrides,
  getReleaseChannel,
  isFeatureFlagEnabled,
  type FeatureFlagId,
} from "../featureFlags";
import { AwayNotifySetting } from "./AwayNotifySetting";
import { FleetSettingsTab } from "../fleet/FleetSettingsTab";
import { AgentsSettings } from "./AgentsSettings";

/** Id prefix of the Settings tabs and their panel. */
const SETTINGS_TABS_ID = "settings";

// The plugin manager loads when its tab is first opened.
const PluginManager = lazyView("PluginManager", () => import("./PluginManager").then((m) => m.PluginManager));
// The hidden controls preview (Flags tab) loads only when opened.
const UiKitScreen = lazyView("UiKitScreen", () => import("./ui/UiKitScreen").then((m) => m.UiKitScreen));
// Settings > Storage (diskGuard flag) loads when its tab is first opened.
const StorageSettings = lazyView("StorageSettings", () => import("./StorageSettings").then((m) => m.StorageSettings));

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
  /** Agents tab (flag taskLauncher): open a terminal running an agent's CLI to sign in. */
  onSignInAgent?: (agentId: string) => void;
  /** 2.0: sign an agent account in (its CLI's own sign-in, in that account's profile). */
  onSignInAccount?: (agentId: string, accountId: string) => void;
  /** Agents tab: open the full creator, where a Custom agent is set up. */
  onOpenAdvancedCreator?: () => void;
}

export function Settings({ onClose, initialTab, pluginRuntime, onConfirmPluginUpdate, onConfirmPluginUpdateAll, pluginRefreshTrigger, onSignInAgent, onSignInAccount, onOpenAdvancedCreator }: SettingsProps) {
  const { t } = useI18n();
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

  // Hidden "Flags" tab: unlocked by clicking the panel title 7 times within
  // 1.5s of each other, like Android's build-number developer-options
  // gesture. Not persisted — resets every time Settings is reopened.
  const [flagsUnlocked, setFlagsUnlocked] = useState(false);
  const [uiKitOpen, setUiKitOpen] = useState(false);
  const titleClicks = useRef(0);
  const titleClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTitleClick = useCallback(() => {
    titleClicks.current += 1;
    if (titleClickTimer.current) clearTimeout(titleClickTimer.current);
    titleClickTimer.current = setTimeout(() => { titleClicks.current = 0; }, 1500);
    if (titleClicks.current >= 7) {
      titleClicks.current = 0;
      setFlagsUnlocked(true);
    }
  }, []);
  useEffect(() => () => {
    if (titleClickTimer.current) clearTimeout(titleClickTimer.current);
  }, []);

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

  // The keyboard is Settings' while it is open (not the terminal behind
  // it); Esc closes it unless a field inside handled that Esc first.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, { onEscape: onClose, initialFocus: '.settings-tab[aria-selected="true"]' });

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

  const updateSetting = useCallback((key: string, value: string) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    if (key === "theme") {
      applyTheme(value, next);
    } else if (["font_size", "font_family", "scrollback", "ui_scale", "shell_suggestions"].includes(key)) {
      applyTheme(next.theme || "frosted-dark", next);
    } else if (key === "agent_timeline_style") {
      applyAgentTimelineStyle(value);
    }
    return setSetting(key, value).catch(console.error);
  }, [settings]);

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
    { id: "general", label: t("settings.general") },
    { id: "appearance", label: t("settings.appearance") },
    { id: "ssh", label: t("settings.ssh") },
    { id: "git", label: t("settings.git") },
    { id: "ai-agent", label: t("settings.aiAgent") },
    // 2.0 fleet controls: spend caps and the running-agents cap.
    ...(isFeatureFlagEnabled("fleetControls") ? [{ id: "limits", label: t("settings.limits") }] : []),
    // The agent doctor (F16), the same one the welcome screens show.
    // 2.0 (agentCatalog): accounts, models and presets per agent.
    ...(isFeatureFlagEnabled("taskLauncher") || isFeatureFlagEnabled("agentCatalog") ? [{ id: "agents", label: t("settings.agents") }] : []),
    // Old worktrees and the disk they take (disk guard).
    ...(isFeatureFlagEnabled("diskGuard") ? [{ id: "storage", label: t("storage.title") }] : []),
    { id: "shortcuts", label: t("settings.shortcuts") },
    { id: "plugins", label: t("app.plugins") },
    { id: "privacy", label: t("settings.privacy") },
    // Hidden developer section, unlocked by handleTitleClick.
    ...(flagsUnlocked ? [{ id: "flags", label: t("settings.flags") }] : []),
  ];

  return (
    <div
      className="settings-overlay"
      onClick={() => handleOverlayClick(onClose)}
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
    >
      <div ref={panelRef} className="settings-panel" onClick={(e) => e.stopPropagation()} style={{ width: panelWidth, height: panelHeight }}>
        <div className="settings-resize-handle" onMouseDown={onResizeWidthStart} />
        <div className="settings-resize-handle-bottom" onMouseDown={onResizeHeightStart} />
        <div className="settings-header">
          <span className="settings-title" onClick={handleTitleClick}>{t("settings.title")}</span>
          <CloseButton className="settings-close" onClick={onClose} label={t("common.close")} />
        </div>

        <div className="settings-body">
          <Tabs
            idPrefix={SETTINGS_TABS_ID}
            orientation="vertical"
            className="settings-tabs"
            tabClassName="settings-tab"
            label={t("settings.title")}
            value={activeTab}
            onChange={setActiveTab}
            tabs={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
          />

          <TabPanel idPrefix={SETTINGS_TABS_ID} value={activeTab} className="settings-content">
            {activeTab === "general" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-default-shell">{t("settings.defaultShell")}</label>
                  <NativeSelect
                    id="settings-default-shell"
                    value={settings.default_shell || ""}
                    onChange={(e) => updateSetting("default_shell", e.target.value)}
                  >
                    <option value="">{t("settings.systemDefault")}</option>
                    {shells.map((s) => (
                      <option key={s.path} value={s.path}>{s.name}</option>
                    ))}
                  </NativeSelect>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-scrollback">{t("settings.terminalScrollback")}</label>
                  <NativeSelect
                    id="settings-scrollback"
                    value={settings.scrollback || "10000"}
                    onChange={(e) => updateSetting("scrollback", e.target.value)}
                  >
                    <option value="5000">{t("settings.lines", { count: "5,000" })}</option>
                    <option value="10000">{t("settings.lines", { count: "10,000" })}</option>
                    <option value="25000">{t("settings.lines", { count: "25,000" })}</option>
                    <option value="50000">{t("settings.lines", { count: "50,000" })}</option>
                  </NativeSelect>
                </div>

                <div className="settings-group" data-setting="shell_suggestions">
                  <Toggle
                    checked={settings.shell_suggestions !== "native"}
                    onChange={(on) => updateSetting("shell_suggestions", on ? "hermes" : "native")}
                    label={t("settings.shellSuggestions")}
                    description={t("settings.shellSuggestionsHint")}
                  />
                </div>

                <div className="settings-group" data-setting="status_strip">
                  <Toggle
                    checked={settings.status_strip !== "off"}
                    onChange={(on) => {
                      updateSetting("status_strip", on ? "on" : "off");
                      void setStatusStripEnabled(on);
                    }}
                    label={t("settings.statusStrip")}
                    description={t("settings.statusStripHint")}
                  />
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-update-channel">{t("settings.updateChannel")}</label>
                  <NativeSelect
                    id="settings-update-channel"
                    data-setting="update_channel"
                    value={normalizeUpdateChannel(settings.update_channel)}
                    onChange={(e) => updateSetting("update_channel", normalizeUpdateChannel(e.target.value))}
                  >
                    <option value="stable">{t("settings.updateChannelStable")}</option>
                    <option value="beta">{t("settings.updateChannelBeta")}</option>
                  </NativeSelect>
                  <span className="settings-hint-inline">{t("settings.updateChannelHint")}</span>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-default-cwd">{t("settings.defaultWorkingDirectory")}</label>
                  <Input
                    id="settings-default-cwd"
                    code
                    placeholder={t("settings.homeDirectoryPlaceholder")}
                    value={settings.default_cwd || ""}
                    onChange={(e) => updateSetting("default_cwd", e.target.value)}
                    onContextMenu={textContextMenu}
                  />
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-palette-shortcut">{t("settings.commandPaletteShortcut")}</label>
                  <NativeSelect
                    id="settings-palette-shortcut"
                    value={settings.command_palette_shortcut || "cmd_k"}
                    onChange={(e) => updateSetting("command_palette_shortcut", e.target.value)}
                  >
                    <option value="cmd_k">{shortcutLabel("view.command-palette")} ({t("settings.defaultOption")})</option>
                    <option value="cmd_shift_p">{fmt("{mod}{shift}P")} ({t("settings.freesShortcut", { shortcut: shortcutLabel("view.command-palette") })})</option>
                  </NativeSelect>
                  <span className="settings-hint-inline">{t("settings.requiresRestartMenu")}</span>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-preferred-editor">{t("settings.preferredEditor")}</label>
                  <NativeSelect
                    id="settings-preferred-editor"
                    value={settings.preferred_editor || ""}
                    onChange={(e) => updateSetting("preferred_editor", e.target.value)}
                  >
                    <option value="">{t("settings.systemDefault")}</option>
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
                  </NativeSelect>
                  <span className="settings-hint-inline">{t("settings.editorHint")}</span>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-restore-sessions">{t("settings.restoreSessions")}</label>
                  <NativeSelect
                    id="settings-restore-sessions"
                    value={settings.restore_sessions || "always"}
                    onChange={(e) => updateSetting("restore_sessions", e.target.value)}
                  >
                    <option value="always">{t("settings.always")}</option>
                    <option value="never">{t("settings.never")}</option>
                  </NativeSelect>
                  <span className="settings-hint-inline">{t("settings.restoreHint")}</span>
                </div>

                <div className="settings-group" data-setting="skip_close_confirm">
                  <Toggle
                    checked={settings.skip_close_confirm !== "true"}
                    onChange={(on) => {
                      const skip = !on;
                      updateSetting("skip_close_confirm", skip ? "true" : "false");
                      dispatch({ type: "SET_SKIP_CLOSE_CONFIRM", skip });
                    }}
                    label={t("settings.confirmBeforeClosing")}
                    description={t("settings.confirmBeforeClosingHint")}
                  />
                </div>

                {isFeatureFlagEnabled("attentionInbox") && (
                  <AwayNotifySetting value={settings.away_notify_url || ""} onSave={updateSetting} />
                )}
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label">{t("settings.theme")}</label>
                  <div
                    className="settings-theme-grid"
                    onMouseLeave={() => {
                      const saved = settings.theme || "frosted-dark";
                      applyTheme(saved, settings);
                    }}
                  >
                    <span className="settings-theme-group-label">{t("settings.dark")}</span>
                    {DARK_THEMES.map((theme) => (
                      <span key={theme.id} className="settings-theme-item" data-theme-id={theme.id} onMouseEnter={() => applyTheme(theme.id, { ...settings, theme: theme.id })}>
                        <Chip size="sm" selected={(settings.theme || "frosted-dark") === theme.id} onToggle={() => updateSetting("theme", theme.id)}>
                          {theme.label}
                        </Chip>
                      </span>
                    ))}
                    <div className="settings-theme-separator" />
                    <span className="settings-theme-group-label">{t("settings.light")}</span>
                    {LIGHT_THEMES.map((theme) => (
                      <span key={theme.id} className="settings-theme-item" data-theme-id={theme.id} onMouseEnter={() => applyTheme(theme.id, { ...settings, theme: theme.id })}>
                        <Chip size="sm" selected={(settings.theme || "frosted-dark") === theme.id} onToggle={() => updateSetting("theme", theme.id)}>
                          {theme.label}
                        </Chip>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-timeline-style">{t("settings.agentTimelineStyle")}</label>
                  <span className="settings-hint-inline">
                    {t("settings.agentTimelineHint")}
                  </span>
                  <NativeSelect
                    id="settings-timeline-style"
                    value={settings.agent_timeline_style || "modern"}
                    onChange={(e) => updateSetting("agent_timeline_style", e.target.value)}
                  >
                    <option value="modern">{t("settings.modernDefault")}</option>
                    <option value="classic">{t("settings.classicCompact")}</option>
                  </NativeSelect>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-ui-scale">{t("settings.uiScale")}</label>
                  <span className="settings-hint-inline">{t("settings.uiScaleHint")}</span>
                  <NativeSelect
                    id="settings-ui-scale"
                    value={settings.ui_scale || "default"}
                    onChange={(e) => updateSetting("ui_scale", e.target.value)}
                  >
                    {UI_SCALE_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </NativeSelect>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-font-size">{t("settings.terminalFontSize")}</label>
                  <NativeSelect
                    id="settings-font-size"
                    value={settings.font_size || "14"}
                    onChange={(e) => updateSetting("font_size", e.target.value)}
                  >
                    {[12, 13, 14, 15, 16, 18].map((s) => (
                      <option key={s} value={String(s)}>{s}px</option>
                    ))}
                  </NativeSelect>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-font-family">{t("settings.fontFamily")}</label>
                  <NativeSelect
                    id="settings-font-family"
                    value={settings.font_family || "default"}
                    onChange={(e) => updateSetting("font_family", e.target.value)}
                  >
                    <option value="default">SF Mono ({t("settings.defaultOption")})</option>
                    <option value="fira">Fira Code</option>
                    <option value="jetbrains">JetBrains Mono</option>
                    <option value="cascadia">Cascadia Code</option>
                    <option value="menlo">Menlo</option>
                  </NativeSelect>
                </div>

                <div className="settings-group">
                  <label className="settings-label">{t("settings.windowSize")}</label>
                  <div className="settings-size-row">
                    <div className="settings-stepper">
                      <IconButton
                        size="sm"
                        className="settings-stepper-btn"
                        icon={"\u2212"}
                        label={t("settings.decreaseWidth")}
                        onPointerDown={() => startRepeat("w", -10)}
                        onPointerUp={stopRepeat}
                        onPointerLeave={stopRepeat}
                      />
                      <Input
                        size="sm"
                        code
                        className="settings-stepper-input"
                        aria-label={t("settings.windowWidth")}
                        type="text"
                        inputMode="numeric"
                        placeholder="1200"
                        value={winWidth}
                        onChange={(e) => { setWinWidth(e.target.value); applyWindowSize(e.target.value, latestH.current); }}
                        onContextMenu={textContextMenu}
                      />
                      <IconButton
                        size="sm"
                        className="settings-stepper-btn"
                        icon="+"
                        label={t("settings.increaseWidth")}
                        onPointerDown={() => startRepeat("w", 10)}
                        onPointerUp={stopRepeat}
                        onPointerLeave={stopRepeat}
                      />
                    </div>
                    <span className="settings-size-separator">&times;</span>
                    <div className="settings-stepper">
                      <IconButton
                        size="sm"
                        className="settings-stepper-btn"
                        icon={"\u2212"}
                        label={t("settings.decreaseHeight")}
                        onPointerDown={() => startRepeat("h", -10)}
                        onPointerUp={stopRepeat}
                        onPointerLeave={stopRepeat}
                      />
                      <Input
                        size="sm"
                        code
                        className="settings-stepper-input"
                        aria-label={t("settings.windowHeight")}
                        type="text"
                        inputMode="numeric"
                        placeholder="800"
                        value={winHeight}
                        onChange={(e) => { setWinHeight(e.target.value); applyWindowSize(latestW.current, e.target.value); }}
                        onContextMenu={textContextMenu}
                      />
                      <IconButton
                        size="sm"
                        className="settings-stepper-btn"
                        icon="+"
                        label={t("settings.increaseHeight")}
                        onPointerDown={() => startRepeat("h", 10)}
                        onPointerUp={stopRepeat}
                        onPointerLeave={stopRepeat}
                      />
                    </div>
                    <span className="settings-size-unit">px</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "shortcuts" && (
              <div className="settings-section">
                <p className="settings-hint">
                  {t("settings.shortcutsHint")}
                </p>
                {visibleShortcutGroups(GENERATED_SHORTCUT_GROUPS).map((group) => (
                  <div key={group.group} className="settings-shortcut-group">
                    <div className="settings-shortcut-group-label">{t(group.groupKey)}</div>
                    {group.shortcuts.map((s) => (
                      <div key={s.id} className="settings-shortcut-row">
                        <span className="settings-shortcut-action">{t(s.labelKey)}</span>
                        <kbd className="settings-shortcut-kbd">{fmt(s.keys)}</kbd>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {activeTab === "ssh" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-ssh-editor">{t("settings.sshFileEditor")}</label>
                  <NativeSelect
                    id="settings-ssh-editor"
                    value={settings.preferred_ssh_editor || "vim"}
                    onChange={(e) => updateSetting("preferred_ssh_editor", e.target.value)}
                  >
                    <optgroup label={t("settings.terminalEditors")}>
                      <option value="vim">Vim</option>
                      <option value="nvim">Neovim</option>
                      <option value="nano">Nano</option>
                      <option value="emacs">Emacs</option>
                      <option value="vi">Vi</option>
                    </optgroup>
                    <optgroup label={t("settings.guiEditors")}>
                      <option value="code">VS Code (Remote SSH)</option>
                      <option value="cursor">Cursor (Remote SSH)</option>
                      <option value="zed">Zed (Remote SSH)</option>
                    </optgroup>
                  </NativeSelect>
                  <span className="settings-hint-inline">{t("settings.sshEditorHint")}</span>
                </div>

                <h3 className="settings-section-title" style={{ marginTop: 16 }}>{t("settings.savedHosts")}</h3>

                {sshHosts.length > 0 && (
                  <div className="settings-ssh-hosts-list">
                    {sshHosts.map((h) => (
                      <div key={h.id} className="settings-ssh-host-item">
                        <div className="settings-ssh-host-info">
                          <span className="settings-ssh-host-label">{h.label}</span>
                          <span className="settings-ssh-host-detail">{h.user ? `${h.user}@` : ""}{h.host}{h.port !== 22 ? `:${h.port}` : ""}</span>
                        </div>
                        <div className="settings-ssh-host-actions">
                          <Button size="sm" onClick={() => setEditingHost({ ...h })}>
                            {t("settings.edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={async () => {
                              await deleteSshSavedHost(h.id);
                              setSshHosts((prev) => prev.filter((x) => x.id !== h.id));
                            }}
                          >
                            {t("common.delete")}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {sshHosts.length === 0 && !editingHost && (
                  <p className="settings-hint">{t("settings.noSshHosts")}</p>
                )}

                {editingHost ? (
                  <div className="settings-ssh-host-form">
                    <div className="settings-group">
                      <label className="settings-label" htmlFor="settings-ssh-label">{t("settings.label")}</label>
                      <Input
                        id="settings-ssh-label"
                        placeholder={t("settings.serverLabelPlaceholder")}
                        value={editingHost.label}
                        onChange={(e) => setEditingHost({ ...editingHost, label: e.target.value })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label" htmlFor="settings-ssh-host">{t("settings.host")}</label>
                      <Input
                        id="settings-ssh-host"
                        code
                        placeholder={t("settings.hostPlaceholder")}
                        value={editingHost.host}
                        onChange={(e) => setEditingHost({ ...editingHost, host: e.target.value })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label" htmlFor="settings-ssh-user">{t("settings.user")}</label>
                      <Input
                        id="settings-ssh-user"
                        code
                        placeholder={t("settings.userPlaceholder")}
                        value={editingHost.user}
                        onChange={(e) => setEditingHost({ ...editingHost, user: e.target.value })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label" htmlFor="settings-ssh-port">{t("settings.port")}</label>
                      <Input
                        id="settings-ssh-port"
                        code
                        type="number"
                        placeholder="22"
                        value={editingHost.port}
                        onChange={(e) => setEditingHost({ ...editingHost, port: parseInt(e.target.value) || 22 })}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label" htmlFor="settings-ssh-identity">{t("settings.identityFile")}</label>
                      <Input
                        id="settings-ssh-identity"
                        code
                        placeholder={t("settings.identityFilePlaceholder")}
                        value={editingHost.identity_file || ""}
                        onChange={(e) => setEditingHost({ ...editingHost, identity_file: e.target.value || null })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-group">
                      <label className="settings-label" htmlFor="settings-ssh-jump">{t("settings.jumpHost")}</label>
                      <Input
                        id="settings-ssh-jump"
                        code
                        placeholder={t("settings.jumpHostPlaceholder")}
                        value={editingHost.jump_host || ""}
                        onChange={(e) => setEditingHost({ ...editingHost, jump_host: e.target.value || null })}
                        onContextMenu={textContextMenu}
                      />
                    </div>
                    <div className="settings-ssh-host-form-actions">
                      <Button onClick={() => setEditingHost(null)}>{t("common.cancel")}</Button>
                      <Button
                        variant="primary"
                        onClick={async () => {
                          if (!editingHost.label.trim() || !editingHost.host.trim() || !editingHost.user.trim()) return;
                          await upsertSshSavedHost(editingHost);
                          const hosts = await listSshSavedHosts();
                          setSshHosts(hosts);
                          setEditingHost(null);
                        }}
                      >
                        {t("settings.save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    className="settings-add-host"
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
                  >
                    {t("settings.addHost")}
                  </Button>
                )}
              </div>
            )}

            {activeTab === "git" && (
              <div className="settings-section">
                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-git-poll">{t("settings.autoRefreshInterval")}</label>
                  <NativeSelect
                    id="settings-git-poll"
                    value={settings.git_poll_interval || "3000"}
                    onChange={(e) => updateSetting("git_poll_interval", e.target.value)}
                  >
                    <option value="1000">{t("settings.oneSecond")}</option>
                    <option value="3000">{t("settings.seconds", { count: "3" })}</option>
                    <option value="5000">{t("settings.seconds", { count: "5" })}</option>
                    <option value="10000">{t("settings.seconds", { count: "10" })}</option>
                    <option value="0">{t("settings.off")}</option>
                  </NativeSelect>
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-git-author-name">{t("settings.authorNameOverride")}</label>
                  <Input
                    id="settings-git-author-name"
                    placeholder={t("settings.useGitConfig")}
                    value={settings.git_author_name || ""}
                    onChange={(e) => updateSetting("git_author_name", e.target.value)}
                    onContextMenu={textContextMenu}
                  />
                </div>

                <div className="settings-group">
                  <label className="settings-label" htmlFor="settings-git-author-email">{t("settings.authorEmailOverride")}</label>
                  <Input
                    id="settings-git-author-email"
                    placeholder={t("settings.useGitConfig")}
                    value={settings.git_author_email || ""}
                    onChange={(e) => updateSetting("git_author_email", e.target.value)}
                    onContextMenu={textContextMenu}
                  />
                </div>

                <div className="settings-group" data-setting="git_auto_stage">
                  <Toggle
                    checked={settings.git_auto_stage === "true"}
                    onChange={(on) => updateSetting("git_auto_stage", on ? "true" : "false")}
                    label={t("settings.autoStageCommit")}
                  />
                </div>

                <div className="settings-group" data-setting="git_show_untracked">
                  <Toggle
                    checked={settings.git_show_untracked !== "false"}
                    onChange={(on) => updateSetting("git_show_untracked", on ? "true" : "false")}
                    label={t("settings.showUntracked")}
                  />
                </div>

                {/* F20 turn ledger kill switch: only shown while the flag is on. */}
                {isFeatureFlagEnabled("turnLedger") && (
                  <div className="settings-group" data-setting="turn_ledger">
                    <Toggle
                      checked={settings.turn_ledger !== "off"}
                      onChange={(on) => updateSetting("turn_ledger", on ? "on" : "off")}
                      label={t("settings.turnLedger")}
                      description={<span data-setting-hint="turn_ledger">{t("settings.turnLedgerHint")}</span>}
                    />
                  </div>
                )}
              </div>
            )}


            {activeTab === "limits" && isFeatureFlagEnabled("fleetControls") && <FleetSettingsTab />}

            {activeTab === "ai-agent" && (
              <AiAgentSettingsTab
                settings={settings}
                updateSetting={updateSetting}
              />
            )}

            {activeTab === "plugins" && (
              <>
                <div className="settings-section">
                  <h3 className="settings-section-title">{t("settings.pluginUpdates")}</h3>
                  <div className="settings-group">
                    <label className="settings-label" htmlFor="settings-plugin-update-check">{t("settings.checkPluginUpdates")}</label>
                    <NativeSelect
                      id="settings-plugin-update-check"
                      value={settings.plugin_update_check || "startup"}
                      onChange={(e) => updateSetting("plugin_update_check", e.target.value)}
                    >
                      <option value="startup">{t("settings.onStartup")}</option>
                      <option value="daily">{t("settings.daily")}</option>
                      <option value="weekly">{t("settings.weekly")}</option>
                      <option value="never">{t("settings.never")}</option>
                    </NativeSelect>
                  </div>
                  <div className="settings-group" data-setting="plugin_auto_update">
                    <Toggle
                      checked={settings.plugin_auto_update === "true"}
                      onChange={(on) => updateSetting("plugin_auto_update", on ? "true" : "false")}
                      label={t("settings.autoUpdatePlugins")}
                      description={t("settings.autoUpdatePluginsHint")}
                    />
                  </div>
                </div>
                <Suspense fallback={null}><PluginManager runtime={pluginRuntime} onConfirmUpdate={onConfirmPluginUpdate} onConfirmUpdateAll={onConfirmPluginUpdateAll} refreshTrigger={pluginRefreshTrigger} /></Suspense>
              </>
            )}

            {activeTab === "agents" && isFeatureFlagEnabled("agentCatalog") && (
              <div className="settings-section settings-agents-capabilities">
                <AgentsSettings
                  onSignInAccount={(agentId, accountId) => {
                    onSignInAccount?.(agentId, accountId);
                    onClose();
                  }}
                />
              </div>
            )}
            {activeTab === "agents" && isFeatureFlagEnabled("taskLauncher") && (
              <div className="settings-section settings-agents-doctor">
                <p className="settings-hint">{t("settings.agentsDoctorHint")}</p>
                <AgentDoctor
                  // Settings > Agents has one "Check again" (above the cards), which checks this too.
                  showRecheck={!isFeatureFlagEnabled("agentCatalog")}
                  onSignIn={(agentId) => {
                    onSignInAgent?.(agentId);
                    onClose();
                  }}
                  onOpenAdvanced={
                    onOpenAdvancedCreator
                      ? () => {
                          // The creator first: Settings closing must not bring
                          // back a launcher it was opened from.
                          onOpenAdvancedCreator();
                          onClose();
                        }
                      : undefined
                  }
                />
              </div>
            )}

            {activeTab === "storage" && (
              <Suspense fallback={null}><StorageSettings settings={settings} onChange={updateSetting} /></Suspense>
            )}

            {activeTab === "privacy" && (
              <div className="settings-section">
                <div className="settings-group" data-setting="telemetry_enabled">
                  <Toggle
                    checked={settings.telemetry_enabled === "true"}
                    onChange={(on) => {
                      updateSetting("telemetry_enabled", on ? "true" : "false");
                      void setAnalyticsEnabled(on);
                    }}
                    label={t("settings.analytics")}
                    description={t("settings.analyticsHint")}
                  />
                </div>
              </div>
            )}

            {activeTab === "flags" && flagsUnlocked && (
              <div className="settings-section">
                <p className="settings-hint">{t("settings.flags.hint", { channel: getReleaseChannel() })}</p>
                <div className="settings-group">
                  <Button data-testid="ui-kit-open" onClick={() => setUiKitOpen(true)}>
                    {t("settings.flags.uiKit")}
                  </Button>
                  <span className="settings-hint-inline">{t("settings.flags.uiKitHint")}</span>
                </div>
                {FEATURE_FLAGS.map((flag) => {
                  const overrides = parseFeatureFlagOverrides(settings[FEATURE_FLAG_OVERRIDES_KEY]);
                  const current = overrides[flag.id];
                  const selectValue = current === undefined ? "default" : current ? "on" : "off";
                  return (
                    <div className="settings-group" key={flag.id}>
                      <label className="settings-label" htmlFor={`settings-flag-${flag.id}`}>{flag.label}</label>
                      <span className="settings-hint-inline">{flag.description}</span>
                      <NativeSelect
                        id={`settings-flag-${flag.id}`}
                        data-flag-id={flag.id}
                        value={selectValue}
                        onChange={(e) => {
                          const next: Partial<Record<FeatureFlagId, boolean>> = { ...overrides };
                          if (e.target.value === "default") delete next[flag.id];
                          else next[flag.id] = e.target.value === "on";
                          updateSetting(FEATURE_FLAG_OVERRIDES_KEY, JSON.stringify(next));
                        }}
                      >
                        <option value="default">{t("settings.flags.default")}</option>
                        <option value="on">{t("settings.flags.forceOn")}</option>
                        <option value="off">{t("settings.flags.forceOff")}</option>
                      </NativeSelect>
                    </div>
                  );
                })}
              </div>
            )}
          </TabPanel>
        </div>

        <div className="settings-footer">
          <Button
            className="settings-export"
            onClick={async () => {
              const path = await save({
                defaultPath: "settings.json",
                filters: [{ name: "JSON", extensions: ["json"] }],
              });
              if (path) {
                try {
                  await exportSettings(path);
                  setFooterStatus(t("settings.exported"));
                } catch (e) {
                  setFooterStatus(t("settings.exportFailed", { error: String(e) }));
                }
              }
            }}
          >
            {t("settings.export")}
          </Button>
          <Button
            className="settings-import"
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
                  applyTheme(newSettings.theme || "frosted-dark", newSettings);
                  // Sync analytics state
                  void setAnalyticsEnabled(newSettings.telemetry_enabled === "true");
                  setFooterStatus(t("settings.imported"));
                } catch (e) {
                  setFooterStatus(t("settings.importFailed", { error: String(e) }));
                }
              }
            }}
          >
            {t("settings.import")}
          </Button>
          {footerStatus && <span className="settings-footer-status">{footerStatus}</span>}
        </div>
        {/* Inside the panel, whose click handler keeps clicks from closing Settings. */}
        {uiKitOpen &&
          createPortal(
            <Suspense fallback={null}>
              <UiKitScreen onClose={() => setUiKitOpen(false)} uiScale={settings.ui_scale} />
            </Suspense>,
            document.body,
          )}
      </div>
    </div>
  );
}

// ─── AI Agent Settings Tab ──────────────────────────────────────────
//
// Displays per-agent prefix + suffix configuration. The prefix is stored as a
// single JSON blob under `ai_agent_prefixes`, so adding a new provider to
// the agent catalog (src/catalog/agents.json) never requires a DB schema or settings-whitelist change.

interface AiAgentSettingsTabProps {
  settings: SettingsMap;
  updateSetting: (key: string, value: string) => void;
}

function AiAgentSettingsTab({ settings, updateSetting }: AiAgentSettingsTabProps) {
  const { t } = useI18n();
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

  // A row per installed agent (and per agent that has a prefix already);
  // the rest of the catalog behind "Show all agents". Until the doctor has
  // answered, every agent is listed.
  const { rows: doctorRows } = useAgentDoctor();
  useEffect(() => {
    ensureDoctor();
  }, []);
  const [showAll, setShowAll] = useState(false);
  const allAgents = listAgents();
  const installedIds = doctorRows ? new Set(doctorRows.filter((r) => r.installed).map((r) => r.id)) : null;
  const shownAgents =
    showAll || !installedIds ? allAgents : allAgents.filter((p) => installedIds.has(p.id) || (prefixes[p.id] ?? "").trim() !== "");
  const hiddenCount = allAgents.length - shownAgents.length;

  return (
    <div className="settings-section">
      <p className="settings-hint">
        {t("settings.aiAgentHint")}
      </p>

      <div className="settings-group">
        <label className="settings-label" htmlFor="settings-default-permission-mode">{t("settings.defaultPermissionMode")}</label>
        <NativeSelect
          id="settings-default-permission-mode"
          value={settings.default_permission_mode || "default"}
          onChange={(e) => updateSetting("default_permission_mode", e.target.value)}
        >
          <option value="default">{t("settings.askPermissions")}</option>
          <option value="acceptEdits">{t("settings.acceptEdits")}</option>
          <option value="plan">{t("settings.planMode")}</option>
          <option value="auto">{t("settings.autoMode")}</option>
          <option value="bypassPermissions">{t("settings.bypassPermissions")}</option>
        </NativeSelect>
      </div>

      <div className="settings-group">
        <label className="settings-label" htmlFor="settings-command-suffix">{t("settings.customCommandSuffix")}</label>
        <Input
          id="settings-command-suffix"
          code
          value={settings.custom_command_suffix || ""}
          onChange={(e) => updateSetting("custom_command_suffix", e.target.value)}
          placeholder={t("settings.customCommandSuffixPlaceholder")}
        />
        <p className="settings-hint">
          {t("settings.customCommandSuffixHint")}
        </p>
      </div>

      <h3 className="settings-section-title" style={{ marginTop: 16 }}>{t("settings.perAgentPrefix")}</h3>
      <p className="settings-hint">
        {t("settings.perAgentPrefixHint", { example1: "caffeinate -i claude", example2: "wsl claude" })}
      </p>

      <fieldset className="settings-agent-prefix-grid">
        <legend className="settings-agent-prefix-legend">{t("settings.agents")}</legend>
        {shownAgents.map((p) => {
          const value = prefixes[p.id] ?? "";
          const inputId = `agent-prefix-${p.id}`;
          const hintId = `agent-prefix-hint-${p.id}`;
          const preview = buildLaunchPreview(p.id, defaultMode, value, globalSuffix);
          return (
            <div key={p.id} className="settings-agent-prefix-row">
              <label htmlFor={inputId} className="settings-agent-prefix-label">
                {p.name}
              </label>
              <Input
                id={inputId}
                code
                value={value}
                onChange={(e) => setPrefix(p.id, e.target.value)}
                placeholder={placeholder}
                aria-describedby={hintId}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              {examples.length > 0 && (
                <div className="settings-agent-prefix-chips" role="group" aria-label={t("settings.prefixExamples", { agent: p.name })}>
                  {examples.map((ex) => (
                    <Button
                      key={ex.value}
                      size="sm"
                      className="settings-agent-prefix-chip"
                      title={ex.hint}
                      onClick={() => setPrefix(p.id, ex.value)}
                    >
                      {ex.label}
                    </Button>
                  ))}
                </div>
              )}
              <div
                id={hintId}
                className="settings-agent-prefix-preview"
                aria-live="polite"
              >
                <span className="settings-agent-prefix-preview-label">{t("settings.preview")}</span>
                <code className="settings-agent-prefix-preview-cmd">{preview || p.name}</code>
              </div>
            </div>
          );
        })}
        {shownAgents.length === 0 && <p className="settings-hint">{t("settings.noAgentsInstalled")}</p>}
        {hiddenCount > 0 && (
          <Button size="sm" variant="link" className="settings-agent-prefix-show-all" onClick={() => setShowAll(true)}>
            {t("settings.showAllAgents", { count: hiddenCount })}
          </Button>
        )}
      </fieldset>
    </div>
  );
}
