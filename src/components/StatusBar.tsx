import "../styles/components/StatusBar.css";
import { useState, useEffect, useCallback, useMemo } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { useActiveSession, useSessionList, useTotalCost, useTotalTokens } from "../state/SessionContext";
import { PLATFORM, OS_VERSION } from "../utils/platform";
import { useContextMenu, menuItem } from "../hooks/useContextMenu";
import { fmt } from "../utils/platform";
import { useI18n } from "../i18n/I18nProvider";
import { AgentStatusTag } from "./AgentStatusTag";
import { isAgentStatusEnabled } from "../agent/status/flag";
import { useSessionStatus } from "../agent/status/attentionStore";
import { BLOCKING_STATUS_KINDS } from "../agent/contract/status";
import { isFeatureFlagEnabled } from "../featureFlags";
import { useReportedTotals } from "../fleet/useReportedTotals";
// Theme switching moved to Settings → Appearance in 1.1.15.  The
// status bar is for state, not configuration; keeping the picker
// out of here removes a redundant entry point.

/**
 * The active session's status in the strip. A status that needs a person
 * (approval, question, gate, failed check, error, limit) is announced
 * assertively, like the old needs-input capsule; everything else politely.
 */
function AgentStatusStrip({ sessionId }: { sessionId: string }) {
  const { kind } = useSessionStatus(sessionId);
  const live = BLOCKING_STATUS_KINDS.includes(kind) ? "assertive" : "polite";
  return (
    <span className="status-bar-item status-bar-agent-status" role="status" aria-live={live}>
      <AgentStatusTag sessionId={sessionId} variant="strip" />
    </span>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function formatElapsed(createdAt: string, justNow: string): string {
  const diff = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (diff < 60) return justNow;
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
  onCheckForUpdates?: () => void;
}

export function StatusBar({ onOpenShortcuts, updateAvailable, updateVersion, updateDownloading, updateProgress, onShowUpdate, onCheckForUpdates }: StatusBarProps) {
  const { t } = useI18n();
  const active = useActiveSession();
  // Read once at startup (flags never change while the app runs).
  const agentStatus = isAgentStatusEnabled();
  const sessions = useSessionList();
  const legacyCost = useTotalCost();
  const legacyTokens = useTotalTokens();
  // With the 2.0 fleet controls on, only what the agents themselves
  // reported is added up: no estimated cost, no tokens read off the screen.
  const fleetOn = isFeatureFlagEnabled("fleetControls");
  const reported = useReportedTotals(sessions.map((s) => s.id), fleetOn);
  const totalCost = fleetOn ? reported.costUsd ?? 0 : legacyCost;
  const totalTokens = useMemo(
    () => (fleetOn ? { input: reported.inputTokens ?? 0, output: reported.outputTokens ?? 0 } : legacyTokens),
    [fleetOn, reported.inputTokens, reported.outputTokens, legacyTokens],
  );
  const hasTokens = totalTokens.input + totalTokens.output > 0;
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

  // Version chip state — collapses idle / checking / available / downloading
  // into a single visual element (see docs/design-system/06-components.md).
  const versionState: "idle" | "available" | "downloading" =
    updateDownloading ? "downloading" : updateAvailable ? "available" : "idle";

  const cwdBasename = active && active.working_directory ? active.working_directory.replace(/\\/g, "/").split("/").pop() || active.working_directory : "";
  const cwdTooltip = active?.mode === "agent"
    ? t("status.projectContext", { path: active.working_directory })
    : t("status.workingDirectory", { path: active?.working_directory ?? "" });

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-bar-item">
          <span className={`status-dot ${sessions.length > 0 ? "status-dot-on" : ""}`} />
          {t("status.active", { count: sessions.length })}
        </span>
        {active?.detected_agent && (
          <>
            <span className="status-bar-divider" />
            <span className="status-bar-item">
              {active.detected_agent.name}
              {active.detected_agent.model && <span className="status-bar-model"> ({active.detected_agent.model})</span>}
              {active.permission_mode && active.permission_mode !== "default" && (
                <span className={`status-bar-perm-mode${active.permission_mode === "bypassPermissions" ? " status-bar-perm-mode-danger" : ""}`}>
                  {active.permission_mode === "acceptEdits" ? t("permission.acceptEdits.shortLabel") :
                   active.permission_mode === "plan" ? t("permission.plan.shortLabel") :
                   active.permission_mode === "auto" ? t("permission.auto.shortLabel") :
                   active.permission_mode === "bypassPermissions" ? t("permission.bypassPermissions.shortLabel") : ""}
                </span>
              )}
              {!agentStatus && active.phase === "busy" && (
                <span className="status-capsule status-capsule-busy" role="status" aria-live="polite">
                  <span className="status-capsule-pulse" aria-hidden="true" />
                  <span className="status-capsule-label">{t("status.working")}</span>
                </span>
              )}
              {/* With the attention inbox on, its title-bar badge says this. */}
              {!agentStatus && active.phase === "needs_input" && !isFeatureFlagEnabled("attentionInbox") && (
                <span className="status-capsule status-capsule-needs" role="status" aria-live="assertive">
                  <span className="status-capsule-pulse" aria-hidden="true" />
                  <span className="status-capsule-label">{t("status.needsInput")}</span>
                </span>
              )}
            </span>
          </>
        )}
        {agentStatus && active && active.phase !== "disconnected" && (
          <>
            <span className="status-bar-divider" />
            <AgentStatusStrip sessionId={active.id} />
          </>
        )}
      </div>
      <div className="status-bar-right">
        {hasTokens && (
          <>
            <span className="status-bar-item status-bar-tokens" title={t("statusbar.ioTitle", { input: totalTokens.input.toLocaleString(), output: totalTokens.output.toLocaleString() })}>
              {t("status.tokens", { count: formatTokens(totalTokens.input + totalTokens.output) })}
            </span>
            <span className="status-bar-divider" />
          </>
        )}
        {totalCost > 0 && (
          <>
            <span className="status-bar-item status-bar-cost" title={fleetOn ? t("fleet.spendReported") : undefined} onContextMenu={(e) => {
              showStatusMenu(e, [
                menuItem("status.copy-cost", t("status.copyCost")),
                menuItem("status.copy-tokens", t("status.copyTokenCount")),
              ]);
            }}>${totalCost.toFixed(2)}</span>
            <span className="status-bar-divider" />
          </>
        )}
        {active && (
          <>
            <span className="status-bar-item status-bar-elapsed">{formatElapsed(active.created_at, t("time.justNow"))}</span>
            <span className="status-bar-divider" />
            <span className="status-bar-item mono" title={cwdTooltip} onContextMenu={(e) => {
              showStatusMenu(e, [
                menuItem("status.copy-branch", t("status.copyWorkingDirectory")),
              ]);
            }}>{cwdBasename}</span>
            <span className="status-bar-divider" />
          </>
        )}
        {/* Unified version chip — one element, four states:
            idle / available / downloading. (See docs/design-system/06-components.md.) */}
        <button
          className="status-version-chip"
          data-state={versionState}
          style={versionState === "downloading"
            ? { ["--progress" as string]: String(updateProgress ?? 0) }
            : undefined}
          title={
            versionState === "downloading"
              ? `${t("statusbar.update.downloading", { version: updateVersion ?? "" })} ${updateProgress ?? 0}%`
              : versionState === "available"
              ? t("statusbar.update.available", { version: updateVersion ?? "" })
              : t("statusbar.update.check")
          }
          onClick={
            versionState === "available" ? onShowUpdate :
            versionState === "downloading" ? onShowUpdate :
            onCheckForUpdates
          }
        >
          {versionState === "downloading" && (
            <span className="status-version-arc" aria-hidden="true" />
          )}
          <span className="status-version-label">
            {versionState === "idle" && `v${__APP_VERSION__}`}
            {versionState === "available" && t("statusbar.update.ready", { version: updateVersion ?? "" })}
            {versionState === "downloading" && t("statusbar.update.downloading", { version: updateVersion ?? "" })}
          </span>
          {versionState === "downloading" && (
            <span className="status-version-pct">{updateProgress ?? 0}%</span>
          )}
          {versionState === "idle" && (
            <svg className="status-version-icon" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2v9M4.5 7.5L8 11l3.5-3.5" />
              <path d="M2.5 13.5h11" />
            </svg>
          )}
        </button>
        {/* ThemePicker removed in 1.1.15 — theme switching now lives
            in Settings → Appearance, the single source of truth.  The
            status bar should communicate state, not configuration. */}
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
            open(`https://github.com/hermes-hq/hermes-ide/issues/new?${params}`);
          }}
          title={t("status.reportBug")}
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
            title={t("status.keyboardShortcuts", { shortcut: fmt("{mod}/") })}
          >
            ⌨
          </button>
        )}
      </div>
    </div>
  );
}
