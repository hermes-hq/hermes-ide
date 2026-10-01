import "../styles/components/AgentDoctor.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { customAgent, getAgent, installCommand } from "../catalog/agentCatalog";
import { shortcutLabel } from "../utils/keymap";
import type { DoctorRow } from "../api/doctor";
import { ensureDoctor, useAgentDoctor } from "../launcher/doctorStore";
import { Badge, Button } from "./ui";

export interface AgentDoctorProps {
  /** Opens a terminal running the agent's CLI, where it signs in. */
  onSignIn: (agentId: string) => void;
  /** Opens the full creator, where a Custom agent is set up. */
  onOpenAdvanced?: () => void;
  /**
   * Show the doctor's own "Check again". Off where the page already has
   * one that checks the doctor too (Settings > Agents).
   */
  showRecheck?: boolean;
}

/** How long "Copied" stays on a copy button. */
export const COPIED_FOR_MS = 2000;

/** Installed agents first, then the rest, each in catalog order. */
export function orderDoctorRows(rows: readonly DoctorRow[]): DoctorRow[] {
  return [...rows.filter((r) => r.installed), ...rows.filter((r) => !r.installed)];
}

/**
 * The name a row shows. An agent whose name starts like the app's own
 * ("Hermes Agent") says whose it is: "Hermes Agent (Nous Research)".
 */
export function doctorAgentName(row: Pick<DoctorRow, "id" | "name">): string {
  const vendor = getAgent(row.id)?.vendor;
  return /^hermes\b/i.test(row.name) && vendor ? `${row.name} (${vendor})` : row.name;
}

/**
 * The agent doctor (F16): one row per catalog agent with installed,
 * version, signed in, how Hermes follows it (status updates) and whether
 * it can resume, plus copy-install and Sign in. The welcome screens and
 * Settings > Agents show the same component over the same shared answer.
 */
export function AgentDoctor({ onSignIn, onOpenAdvanced, showRecheck = true }: AgentDoctorProps) {
  const { t } = useI18n();
  const { rows, loading, error, refresh } = useAgentDoctor();
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const custom = useMemo(() => customAgent(), []);
  const legendId = useId();

  useEffect(() => {
    ensureDoctor();
  }, []);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const ordered = useMemo(() => orderDoctorRows(rows ?? []), [rows]);
  const noneInstalled = !!rows && rows.every((r) => !r.installed);

  const copy = (id: string) => {
    const cmd = installCommand(getAgent(id));
    if (!cmd) return;
    navigator.clipboard
      .writeText(cmd)
      .then(() => {
        setCopied(id);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(null), COPIED_FOR_MS);
      })
      .catch(console.error);
  };

  const yesNo = (v: "yes" | "no" | "unknown") => (v === "yes" ? t("doctor.yes") : v === "no" ? t("doctor.no") : t("doctor.unknown"));

  return (
    <div className="agent-doctor" data-loading={loading ? "true" : "false"}>
      {(showRecheck || loading || error) && (
        <div className="agent-doctor-bar">
          <span className="agent-doctor-status">
            {loading ? t("doctor.checking") : error ? t("doctor.failed", { error }) : ""}
          </span>
          {showRecheck && (
            <Button size="sm" className="agent-doctor-recheck" onClick={refresh} disabled={loading}>
              {t("doctor.recheck")}
            </Button>
          )}
        </div>
      )}
      {rows && (
        <div className="agent-doctor-scroll">
          <table className="agent-doctor-table" aria-describedby={legendId}>
            <thead>
              <tr>
                <th>{t("doctor.col.agent")}</th>
                <th>{t("doctor.col.installed")}</th>
                <th>{t("doctor.col.version")}</th>
                <th>{t("doctor.col.signedIn")}</th>
                <th title={t("doctor.legend.signals")}>{t("doctor.col.signals")}</th>
                <th title={t("doctor.legend.resume")}>{t("doctor.col.resume")}</th>
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {ordered.map((r) => {
                const name = doctorAgentName(r);
                return (
                  <tr
                    key={r.id}
                    className={`agent-doctor-row${r.installed ? " installed" : " missing"}${r.broken ? " broken" : ""}`}
                    data-agent-id={r.id}
                    data-installed={r.installed ? "true" : "false"}
                    data-signed-in={r.signed_in}
                    data-broken={r.broken ? "true" : undefined}
                  >
                    <td className="agent-doctor-name">
                      {name}
                      {r.retired && (
                        <span className="agent-doctor-badge-wrap" title={r.retired_note ?? undefined}>
                          <Badge tone="warning" className="agent-doctor-badge retired">
                            {t("doctor.retired")}
                          </Badge>
                        </span>
                      )}
                      {r.broken && (
                        <span className="agent-doctor-broken" role="note">
                          {t("doctor.broken", { agent: name, reason: r.broken })}
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
                        <Button
                          size="sm"
                          className="agent-doctor-action agent-doctor-copy"
                          aria-label={copied === r.id ? t("doctor.copiedFor", { agent: name }) : t("doctor.copyInstallFor", { agent: name })}
                          onClick={() => copy(r.id)}
                        >
                          {copied === r.id ? t("launcher.copied") : t("doctor.copyInstall")}
                        </Button>
                      )}
                      {r.installed && !r.broken && r.signed_in === "no" && (
                        <Button size="sm" className="agent-doctor-action agent-doctor-sign-in" aria-label={t("doctor.signInTo", { agent: name })} onClick={() => onSignIn(r.id)}>
                          {t("launcher.signIn")}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {custom && (
                <tr className="agent-doctor-row custom" data-agent-id={custom.id}>
                  <td className="agent-doctor-name">{t("doctor.custom")}</td>
                  <td colSpan={5} className="agent-doctor-muted">
                    {t("doctor.customHint", { shortcut: shortcutLabel("file.new-session-advanced") })}
                  </td>
                  <td className="agent-doctor-actions">
                    {onOpenAdvanced && (
                      <Button size="sm" className="agent-doctor-action" onClick={onOpenAdvanced}>
                        {t("doctor.customSetUp")}
                      </Button>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="agent-doctor-legend" id={legendId}>
            {t("doctor.legend.signals")} {t("doctor.legend.resume")}
          </p>
        </div>
      )}
      {noneInstalled && (
        <p className="agent-doctor-none">{t("doctor.noneFound", { shortcut: shortcutLabel("file.new-session-tab") })}</p>
      )}
    </div>
  );
}
