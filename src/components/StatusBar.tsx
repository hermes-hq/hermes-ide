import "../styles/components/StatusBar.css";
import { useState, useEffect, useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { setSetting, getSetting, getSettings } from "../api/settings";
import { useActiveSession, useSessionList, useTotalCost, useTotalTokens, useExecutionMode, useSession, ExecutionMode } from "../state/SessionContext";
import { PLATFORM, OS_VERSION } from "../utils/platform";
import { useContextMenu, menuItem } from "../hooks/useContextMenu";
import { fmt } from "../utils/platform";
import { THEME_OPTIONS, applyTheme } from "../utils/themeManager";

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function formatElapsed(createdAt: string): string {
  const diff = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

interface StatusBarProps {
  onOpenShortcuts?: () => void;
  updateAvailable?: boolean;
  updateVersion?: string;
  updateDownloading?: boolean;
  updateProgress?: number;
  onShowUpdate?: () => void;
}

export function StatusBar({ onOpenShortcuts, updateAvailable, updateVersion, updateDownloading, updateProgress, onShowUpdate }: StatusBarProps) {
  const active = useActiveSession();
  const sessions = useSessionList();
  const totalCost = useTotalCost();
  const totalTokens = useTotalTokens();
  const hasTokens = totalTokens.input + totalTokens.output > 0;
  const { dispatch } = useSession();
  const mode = useExecutionMode(active?.id ?? null);
  const [, setTick] = useState(0);

  const handleStatusBarAction = useCallback((actionId: string) => {
    switch (actionId) {
      case "status.copy-branch":
        if (active?.working_directory) {
          navigator.clipboard.writeText(active.working_directory).catch(console.error);
        }
        break;
      case "status.copy-cost":
        navigator.clipboard.writeText(`$${totalCost.toFixed(2)}`).catch(console.error);
        break;
      case "status.copy-tokens": {
        const total = totalTokens.input + totalTokens.output;
        navigator.clipboard.writeText(String(total)).catch(console.error);
        break;
      }
    }
  }, [active, totalCost, totalTokens]);
  const { showMenu: showStatusMenu } = useContextMenu(handleStatusBarAction);

  // Update elapsed time every 30s
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(interval);
  }, [active?.id]);

  const cycleMode = () => {
    if (!active) return;
    const next: ExecutionMode = mode === "manual" ? "assisted" : mode === "assisted" ? "autonomous" : "manual";
    dispatch({ type: "SET_EXECUTION_MODE", sessionId: active.id, mode: next });
    dispatch({ type: "SET_DEFAULT_MODE", mode: next });
    setSetting("execution_mode", next).catch(console.error);
  };

  const cwdBasename = active && active.working_directory ? active.working_directory.replace(/\\/g, "/").split("/").pop() || active.working_directory : "";

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-bar-item">
          <span className={`status-dot ${sessions.length > 0 ? "status-dot-on" : ""}`} />
          {sessions.length} active
        </span>
        {active && (
          <>
            <span className="status-bar-divider" />
            <button
              className={`status-mode-btn status-mode-${mode}`}
              onClick={cycleMode}
              title={mode === "manual"
                ? "Manual: No automatic suggestions or execution. Click to switch."
                : mode === "assisted"
                ? "Assisted: Shows suggestions and lets you manually apply fixes. Click to switch."
                : "Autonomous: Automatically applies frequent commands and repeated fixes after countdown. Click to switch."}
            >
              <span className="status-mode-dot" />
              {mode === "manual" ? "Manual" : mode === "assisted" ? "Assisted" : "Auto"}
            </button>
          </>
        )}
        {active?.detected_agent && (
          <>
            <span className="status-bar-divider" />
            <span className="status-bar-item">
              {active.detected_agent.name}
              {active.detected_agent.model && <span className="status-bar-model"> ({active.detected_agent.model})</span>}
              {active.phase === "busy" && <span className="status-bar-busy">working</span>}
            </span>
          </>
        )}
      </div>
      <div className="status-bar-right">
        {hasTokens && (
          <>
            <span className="status-bar-item status-bar-tokens" title={`Input: ${totalTokens.input.toLocaleString()} · Output: ${totalTokens.output.toLocaleString()}`}>
              {formatTokens(totalTokens.input + totalTokens.output)} tokens
            </span>
            <span className="status-bar-divider" />
          </>
        )}
        {totalCost > 0 && (
          <>
            <span className="status-bar-item status-bar-cost" onContextMenu={(e) => {
              showStatusMenu(e, [
                menuItem("status.copy-cost", "Copy Cost"),
                menuItem("status.copy-tokens", "Copy Token Count"),
              ]);
            }}>${totalCost.toFixed(2)}</span>
            <span className="status-bar-divider" />
          </>
        )}
        {active && (
          <>
            <span className="status-bar-item status-bar-elapsed">{formatElapsed(active.created_at)}</span>
            <span className="status-bar-divider" />
            <span className="status-bar-item mono" title={active.working_directory} onContextMenu={(e) => {
              showStatusMenu(e, [
                menuItem("status.copy-branch", "Copy Working Directory"),
              ]);
            }}>{cwdBasename}</span>
            <span className="status-bar-divider" />
          </>
        )}
        {updateAvailable && !updateDownloading && (
          <>
            <span className="status-bar-item status-bar-update" onClick={onShowUpdate} title={`Update to v${updateVersion}`}>
              v{updateVersion} available
            </span>
            <span className="status-bar-divider" />
          </>
        )}
        {updateDownloading && (
          <>
            <span className="status-bar-item status-bar-update" title="Downloading update...">
              Updating {updateProgress}%
            </span>
            <span className="status-bar-divider" />
          </>
        )}
        <span className="status-bar-version" title={`HERMES-IDE v${__APP_VERSION__}`}>
          v{__APP_VERSION__}
        </span>
        <ThemePicker />
        <button
          className="status-bug-btn"
          onClick={() => {
            const os = PLATFORM === "mac" ? "macOS" : PLATFORM === "win" ? "Windows" : "Linux";
            const params = new URLSearchParams({
              template: "bug_report.yml",
              version: __APP_VERSION__,
              os,
              "os-version": OS_VERSION,
            });
            open(`https://github.com/Vinci-26/hermes-ide-releases/issues/new?${params}`);
          }}
          title="Report a Bug"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2l1.88 1.88" /><path d="M14.12 3.88L16 2" />
            <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
            <path d="M12 20v-9" /><path d="M6.53 9C4.6 8.8 3 7.1 3 5" /><path d="M6 13H2" /><path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
            <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" /><path d="M22 13h-4" /><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
          </svg>
        </button>
        {onOpenShortcuts && (
          <button
            className="status-shortcuts-btn"
            onClick={onOpenShortcuts}
            title={`Keyboard Shortcuts (${fmt("{mod}/")})`}
          >
            ⌨
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Theme Picker (status bar) ────────────────────────────── */

const THEME_COLORS: Record<string, string> = {
  dark: "#7b93db",
  hacker: "#33ff99",
  designer: "#e07850",
  data: "#22d3ee",
  corporate: "#4a90d9",
  nightowl: "#a78bfa",
  tron: "#00dffc",
  duel: "#ee4444",
  rainbow: "#d6a0ff",
  "80s": "#ffb000",
  solarized: "#268bd2",
};

function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("tron");
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Load current theme on mount
  useEffect(() => {
    getSetting("theme").then((v) => { if (v) setCurrent(v); }).catch(() => {});
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ x: r.right, y: r.top });
    }
    setOpen((o) => !o);
  };

  const select = async (id: string) => {
    setCurrent(id);
    setOpen(false);
    await setSetting("theme", id);
    const all = await getSettings();
    applyTheme(id, { ...all, theme: id });
  };

  return (
    <>
      <button
        ref={btnRef}
        className="status-theme-btn"
        onClick={toggle}
        title="Switch theme"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
        </svg>
      </button>
      {open && pos && (
        <div
          ref={popRef}
          className="status-theme-popover"
          style={{ right: `${window.innerWidth - pos.x}px`, bottom: `${window.innerHeight - pos.y + 4}px` }}
        >
          {THEME_OPTIONS.map((t) => (
            <button
              key={t.id}
              className={`status-theme-option ${current === t.id ? "active" : ""}`}
              onClick={() => select(t.id)}
              title={t.label}
            >
              <span
                className="status-theme-swatch"
                style={{ background: THEME_COLORS[t.id] || "#888" }}
              />
              {t.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
