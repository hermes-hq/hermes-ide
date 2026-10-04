import { useCallback, useEffect, useMemo, useState } from "react";
import "../styles/components/StorageSettings.css";
import { Badge, Button, NativeSelect, Toggle } from "./ui";
import type { BadgeTone } from "./ui/Badge";
import { useI18n } from "../i18n/I18nProvider";
import { translatePlural } from "../i18n/plural";
import {
  cleanUpStorage, daysSince, formatStorageBytes, getStorageReport, groupByRepo, listStorageBackups,
  removeStorageBuildOutput, removeStorageWorktree,
  SETTING_AUTO_CLEANUP, SETTING_IDLE_DAYS, SETTING_LOW_DISK_GB,
  type BackupRecord, type LifeState, type StorageReport, type StorageWorktree,
} from "../api/worktreeStorage";

const IDLE_DAY_CHOICES = [3, 7, 14, 30];
const LOW_DISK_GB_CHOICES = [10, 20, 50];

const STATE_TONE: Record<LifeState, BadgeTone> = {
  open: "success",
  active: "info",
  idle: "neutral",
  landed: "info",
  orphaned: "warning",
};

interface StorageSettingsProps {
  /** Stored settings (strings), from the Settings panel. */
  settings: Record<string, string | undefined>;
  onChange: (key: string, value: string) => void;
}

/**
 * Settings > Storage: what Hermes' worktrees take on disk, per repo, what
 * can be freed without losing work, and the automatic cleanup settings.
 * The rules live in src-tauri/src/git/hygiene.rs.
 */
export function StorageSettings({ settings, onChange }: StorageSettingsProps) {
  const { t } = useI18n();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [r, b] = await Promise.all([getStorageReport(), listStorageBackups().catch(() => [])]);
      setReport(r);
      setBackups(b);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupByRepo(report?.worktrees ?? []), [report]);
  const size = formatStorageBytes;

  const fail = (e: unknown) => setNote({ text: t("storage.failed", { error: String(e) }), error: true });

  const handleCleanUp = async () => {
    setBusy("cleanup");
    setNote(null);
    try {
      const out = await cleanUpStorage();
      setReport(out.report);
      if (out.removedWorktrees.length === 0 && out.clearedBuildOutput.length === 0) {
        setNote({ text: t("storage.nothingToClean") });
      } else {
        setNote({
          text: t("storage.cleaned", {
            size: size(out.freedBytes),
            removed: out.removedWorktrees.length,
            cleared: out.clearedBuildOutput.length,
          }),
        });
      }
      if (out.backups.length > 0) setBackups(await listStorageBackups().catch(() => backups));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (w: StorageWorktree) => {
    setBusy(w.path);
    setConfirming(null);
    try {
      const out = await removeStorageWorktree(w.path, w.needs === "repo_gone");
      if (!out.removed) {
        fail(out.error ?? "");
      } else {
        const name = w.branch ?? w.repoName;
        setNote({
          text: out.backup
            ? t("storage.removedWithBackup", { name, size: size(out.freedBytes), ref: out.backup.refName })
            : t("storage.removed", { name, size: size(out.freedBytes) }),
        });
      }
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const handleBuildOutput = async (w: StorageWorktree) => {
    setBusy(w.path);
    try {
      const out = await removeStorageBuildOutput(w.path);
      setNote({ text: t("storage.buildOutputRemoved", { size: size(out.freed_bytes) }) });
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const changeSetting = (key: string, value: string) => {
    onChange(key, value);
    // The states depend on the idle period: measure again with it.
    window.setTimeout(() => void load(), 300);
  };

  const copyRestore = (b: BackupRecord) => {
    void navigator.clipboard?.writeText(`git -C "${b.repoPath}" ${b.restoreCommand.replace(/^git /, "")}`)
      .then(() => setCopied(b.refName))
      .catch(() => {});
  };

  const autoOn = (settings[SETTING_AUTO_CLEANUP] ?? "true") !== "false";
  const idleDays = settings[SETTING_IDLE_DAYS] ?? String(report?.settings.idleDays ?? 7);
  const lowGb = settings[SETTING_LOW_DISK_GB] ?? String(Math.round((report?.settings.lowDiskBytes ?? 20e9) / 1e9));

  const free = report?.freeBytes ?? null;
  const total = report?.diskTotalBytes ?? null;
  const low = free !== null && report !== null && free < report.settings.lowDiskBytes;

  return (
    <div className="settings-section storage-settings">
      <h3 className="settings-section-title">{t("storage.disk")}</h3>
      <div className="storage-card" data-testid="storage-disk">
        <div className="storage-disk-line">
          <span className={`storage-free${low ? " storage-free--low" : ""}`} data-testid="storage-free">
            {free === null ? t("storage.freeUnknown") : t("storage.free", { size: size(free) })}
          </span>
          {total !== null && report && (
            <span className="storage-meta">
              {t("storage.ofTotal", { total: size(total), threshold: size(report.settings.lowDiskBytes) })}
            </span>
          )}
        </div>
        {total !== null && free !== null && report && (
          <div className="storage-bar" aria-hidden="true">
            <span className="storage-bar-other" style={{ width: `${pct(total - free - report.totalBytes, total)}%` }} />
            <span
              className="storage-bar-worktrees"
              style={{ left: `${pct(total - free - report.totalBytes, total)}%`, width: `${pct(report.totalBytes, total)}%` }}
            />
            <span className="storage-bar-warn" style={{ left: `${pct(total - report.settings.lowDiskBytes, total)}%` }} />
          </div>
        )}
        {report && (
          <div className="storage-legend">
            <span><i className="storage-dot storage-dot--worktrees" />{t("storage.worktreesUse")} <b data-testid="storage-total">{size(report.totalBytes)}</b></span>
            <span><i className="storage-dot storage-dot--other" />{t("storage.everythingElse")}</span>
          </div>
        )}
        <div className="storage-summary">
          {report && (
            <>
              <span className="storage-stat" data-testid="storage-auto">{t("storage.autoBytes", { size: size(report.autoBytes) })}</span>
              {report.needsBytes > 0 && (
                <span className="storage-stat storage-stat--needs" data-testid="storage-needs">· {t("storage.needsBytes", { size: size(report.needsBytes) })}</span>
              )}
            </>
          )}
          <span className="storage-spacer" />
          <Button size="sm" variant="quiet" onClick={() => void load()} disabled={busy !== null}>{t("storage.refresh")}</Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void handleCleanUp()}
            disabled={!report || report.autoBytes === 0 || busy !== null}
            loading={busy === "cleanup"}
            data-testid="storage-clean-up"
          >
            {busy === "cleanup" ? t("storage.cleaning") : t("storage.cleanUpNow")}
          </Button>
        </div>
      </div>
      {note && (
        <div className={`storage-note${note.error ? " storage-note--error" : ""}`} role="status" data-testid="storage-note">{note.text}</div>
      )}

      <h3 className="settings-section-title">{t("storage.worktrees")}</h3>
      {loadError && <div className="storage-note storage-note--error" role="alert">{t("storage.loadFailed", { error: loadError })}</div>}
      {!report && !loadError && <div className="storage-meta">{t("storage.measuring")}</div>}
      {report && groups.length === 0 && <div className="storage-meta">{t("storage.empty")}</div>}
      {groups.map((g) => (
        <div className="storage-repo" key={g.repoPath ?? g.name} data-testid="storage-repo">
          <div className="storage-repo-head">
            <span className="storage-repo-name">{g.name}</span>
            <span className="storage-repo-nums">
              {translatePlural("storage.repoCount", g.worktrees.length)} · {size(g.totalBytes)}
              {g.autoBytes > 0 && <> · {t("storage.reclaimable", { size: size(g.autoBytes) })}</>}
            </span>
          </div>
          {g.worktrees.map((w) => (
            <WorktreeRow
              key={w.path}
              w={w}
              busy={busy}
              confirming={confirming === w.path}
              onConfirm={() => setConfirming(w.path)}
              onCancel={() => setConfirming(null)}
              onRemove={() => void handleRemove(w)}
              onBuildOutput={() => void handleBuildOutput(w)}
            />
          ))}
        </div>
      ))}

      <h3 className="settings-section-title">{t("storage.auto.title")}</h3>
      <div className="storage-card">
        <Toggle
          checked={autoOn}
          onChange={(v) => changeSetting(SETTING_AUTO_CLEANUP, v ? "true" : "false")}
          label={t("storage.auto.toggle")}
          description={t("storage.auto.hint")}
        />
        <div className="storage-setting-row">
          <label htmlFor="storage-idle-days">{t("storage.idleAfter")}</label>
          <NativeSelect id="storage-idle-days" size="sm" value={idleDays} onChange={(e) => changeSetting(SETTING_IDLE_DAYS, e.target.value)}>
            {withCurrent(IDLE_DAY_CHOICES, idleDays).map((d) => (
              <option key={d} value={String(d)}>{translatePlural("storage.days", d)}</option>
            ))}
          </NativeSelect>
        </div>
        <div className="storage-setting-row">
          <label htmlFor="storage-low-disk">{t("storage.lowDiskWarn")}</label>
          <NativeSelect id="storage-low-disk" size="sm" value={lowGb} onChange={(e) => changeSetting(SETTING_LOW_DISK_GB, e.target.value)}>
            {withCurrent(LOW_DISK_GB_CHOICES, lowGb).map((g) => (
              <option key={g} value={String(g)}>{`${g} GB`}</option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <h3 className="settings-section-title">{t("storage.backups")}</h3>
      <div className="storage-card" data-testid="storage-backups">
        {backups.length === 0 && <div className="storage-meta">{t("storage.noBackups")}</div>}
        {backups.map((b) => (
          <div className="storage-backup" key={b.refName}>
            <code title={b.repoPath}>{b.refName}</code>
            <Button size="sm" variant="quiet" onClick={() => copyRestore(b)}>
              {copied === b.refName ? t("storage.copied") : t("storage.copyRestore")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/** The choices, plus the stored value when it is not one of them. */
function withCurrent(choices: number[], current: string): number[] {
  const n = Number(current);
  return Number.isFinite(n) && !choices.includes(n) ? [...choices, n].sort((a, b) => a - b) : choices;
}

interface RowProps {
  w: StorageWorktree;
  busy: string | null;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onBuildOutput: () => void;
}

function WorktreeRow({ w, busy, confirming, onConfirm, onCancel, onRemove, onBuildOutput }: RowProps) {
  const { t } = useI18n();
  const size = formatStorageBytes;
  const days = daysSince(w.lastUsed);
  const isOpen = w.state === "open";
  const disabled = busy !== null;

  const meta: string[] = [];
  if (isOpen) meta.push(t("storage.usedNow"));
  else if (days !== null) meta.push(days === 0 ? t("storage.lastUsedToday") : translatePlural("storage.lastUsedDays", days));
  if (!isOpen && w.sessionIds.length === 0) meta.push(t("storage.noSession"));

  const facts: { text: string; warn: boolean }[] = [];
  if (!isOpen) {
    if (!w.repoExists) facts.push({ text: t("storage.repoGone"), warn: true });
    else if (!w.facts.gitKnows) facts.push({ text: t("storage.gitForgot"), warn: false });
    else {
      if (w.facts.changedFiles > 0) facts.push({ text: translatePlural("storage.changedFiles", w.facts.changedFiles), warn: true });
      if (w.facts.unpushedCommits > 0) facts.push({ text: translatePlural("storage.unpushed", w.facts.unpushedCommits), warn: true });
      if (facts.length === 0) facts.push({ text: w.state === "landed" ? t("storage.nothingToLose") : t("storage.clean"), warn: false });
    }
  }

  const hasWork = !w.repoExists || w.backupBeforeRemoval;
  return (
    <div className="storage-row" data-testid="storage-row" data-path={w.path} data-state={w.state}>
      <div className="storage-row-main">
        <div className="storage-row-line">
          <span className="storage-branch">{w.branch ?? w.repoName}</span>
          <Badge tone={STATE_TONE[w.state]} data-testid="storage-state">{t(`storage.state.${w.state}`)}</Badge>
        </div>
        {meta.length > 0 && <div className="storage-meta">{meta.join(" · ")}</div>}
        {facts.length > 0 && (
          <div className="storage-facts">
            {facts.map((f) => (
              <span key={f.text} className={f.warn ? "storage-fact storage-fact--warn" : "storage-fact"}>{f.text}</span>
            ))}
          </div>
        )}
        {confirming && (
          <div className="storage-confirm" role="alertdialog" aria-label={t("storage.removeWorktree")}>
            <div>{w.repoExists ? t("storage.confirmBackup") : t("storage.confirmUnrecoverable")}</div>
            <div className="storage-confirm-btns">
              <Button size="sm" variant="quiet" onClick={onCancel}>{t("common.cancel")}</Button>
              <Button size="sm" variant="danger" onClick={onRemove} data-testid="storage-confirm-remove">
                {w.repoExists ? t("storage.backUpAndRemove") : t("storage.deleteForGood")}
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="storage-row-side">
        <span className="storage-size">
          {size(w.totalBytes)}
          <small>{w.buildOutputBytes > 0 ? t("storage.buildOutput", { size: size(w.buildOutputBytes) }) : t("storage.noBuildOutput")}</small>
        </span>
        {!isOpen && w.buildOutputBytes > 0 && (
          <Button size="sm" onClick={onBuildOutput} disabled={disabled} loading={busy === w.path} data-testid="storage-remove-build-output">
            {t("storage.removeBuildOutput")}
          </Button>
        )}
        {!isOpen && !hasWork && (
          <Button size="sm" onClick={onRemove} disabled={disabled} data-testid="storage-remove">{t("storage.removeWorktree")}</Button>
        )}
        {!isOpen && hasWork && !confirming && (
          <Button size="sm" variant="danger" onClick={onConfirm} disabled={disabled} data-testid="storage-remove">
            {w.repoExists ? t("storage.removeWithBackup") : t("storage.deleteFolder")}
          </Button>
        )}
      </div>
    </div>
  );
}
