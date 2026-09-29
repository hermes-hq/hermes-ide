import "../styles/components/AgentDoctor.css";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { customAgent, getAgent, installCommand } from "../catalog/agentCatalog";
import { shortcutLabel } from "../utils/keymap";
import type { DoctorRow } from "../api/doctor";
import { ensureDoctor, useAgentDoctor } from "../launcher/doctorStore";

export interface AgentDoctorProps {
  /** Opens a terminal running the agent's CLI, where it signs in. */
  onSignIn: (agentId: string) => void;
  /** Opens the full creator, where a Custom agent is set up. */
  onOpenAdvanced?: () => void;
}

/** Installed agents first, then the rest, each in catalog order. */
export function orderDoctorRows(rows: readonly DoctorRow[]): DoctorRow[] {
  return [...rows.filter((r) => r.installed), ...rows.filter((r) => !r.installed)];
}

/**
 * The agent doctor (F16): one row per catalog agent with installed,
 * version, signed in, how Hermes follows it (signals) and resume, plus
 * copy-install and Sign in. The welcome screens and Settings > Agents show
 * the same component over the same shared answer.
 */
export function AgentDoctor({ onSignIn, onOpenAdvanced }: AgentDoctorProps) {
  const { t } = useI18n();
  const { rows, loading, error, refresh } = useAgentDoctor();
  const [copied, setCopied] = useState<string | null>(null);
  const custom = useMemo(() => customAgent(), []);

  useEffect(() => {
    ensureDoctor();
  }, []);

  const ordered = useMemo(() => orderDoctorRows(rows ?? []), [rows]);
  const noneInstalled = !!rows && rows.every((r) => !r.installed);

  const copy = (id: string) => {
    const cmd = installCommand(getAgent(id));
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => setCopied(id)).catch(console.error);
  };

  const yesNo = (v: "yes" | "no" | "unknown") => (v === "yes" ? t("doctor.yes") : v === "no" ? t("doctor.no") : t("doctor.unknown"));

  return (
    <div className="agent-doctor" data-loading={loading ? "true" : "false"}>
      <div className="agent-doctor-bar">
        <span className="agent-doctor-status">
          {loading ? t("doctor.checking") : error ? t("doctor.failed", { error }) : ""}
        </span>
        <button type="button" className="agent-doctor-recheck" onClick={refresh} disabled={loading}>
          {t("doctor.recheck")}
        </button>
      </div>
      {rows && (
        <table className="agent-doctor-table">
          <thead>
            <tr>
              <th>{t("doctor.col.agent")}</th>
              <th>{t("doctor.col.installed")}</th>
              <th>{t("doctor.col.version")}</th>
              <th>{t("doctor.col.signedIn")}</th>
              <th>{t("doctor.col.signals")}</th>
              <th>{t("doctor.col.resume")}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {ordered.map((r) => (
              <tr
                key={r.id}
                className={`agent-doctor-row${r.installed ? " installed" : " missing"}`}
                data-agent-id={r.id}
                data-installed={r.installed ? "true" : "false"}
                data-signed-in={r.signed_in}
              >
                <td className="agent-doctor-name">
                  {r.name}
                  {r.retired && (
                    <span className="agent-doctor-badge retired" title={r.retired_note ?? undefined}>
                      {t("doctor.retired")}
                    </span>
                  )}
                </td>
                <td data-col="installed">{r.installed ? t("doctor.yes") : t("doctor.notInstalled")}</td>
                <td data-col="version">
                  {r.installed ? r.version ?? t("doctor.unknown") : "—"}
                  {r.version_ok === false && r.min_version && (
                    <span className="agent-doctor-warn">{t("doctor.minVersion", { version: r.min_version })}</span>
                  )}
                </td>
                <td data-col="signed-in">{r.installed ? yesNo(r.signed_in) : "—"}</td>
                <td data-col="signals">{t(`doctor.signals.${r.signals}`)}</td>
                <td data-col="resume">{r.resume ? t("doctor.yes") : t("doctor.no")}</td>
                <td className="agent-doctor-actions">
                  {!r.installed && installCommand(getAgent(r.id)) && (
                    <button type="button" className="agent-doctor-action agent-doctor-copy" onClick={() => copy(r.id)}>
                      {copied === r.id ? t("launcher.copied") : t("doctor.copyInstall")}
                    </button>
                  )}
                  {r.installed && r.signed_in === "no" && (
                    <button type="button" className="agent-doctor-action agent-doctor-sign-in" onClick={() => onSignIn(r.id)}>
                      {t("launcher.signIn")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {custom && (
              <tr className="agent-doctor-row custom" data-agent-id={custom.id}>
                <td className="agent-doctor-name">{t("doctor.custom")}</td>
                <td colSpan={5} className="agent-doctor-muted">
                  {t("doctor.customHint", { shortcut: shortcutLabel("file.new-session-advanced") })}
                </td>
                <td className="agent-doctor-actions">
                  {onOpenAdvanced && (
                    <button type="button" className="agent-doctor-action" onClick={onOpenAdvanced}>
                      {t("doctor.customSetUp")}
                    </button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {noneInstalled && (
        <p className="agent-doctor-none">{t("doctor.noneFound", { shortcut: shortcutLabel("file.new-session-tab") })}</p>
      )}
    </div>
  );
}
