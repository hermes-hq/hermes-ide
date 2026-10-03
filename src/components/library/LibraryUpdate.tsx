// The library's version and updates: the badge in the Library header and
// the same panel in Settings > Library. Signed catalog updates change
// library content only; files installed into projects never change here.

import { useCallback, useState } from "react";
import { Button, Segmented } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { setSetting } from "../../api/settings";
import { libraryCheckUpdate, libraryRollback } from "../../library/api";
import type { LibraryStatus, UpdateOutcome } from "../../library/types";

type T = (key: string, values?: Record<string, string | number>) => string;

export function ago(t: T, seconds: number | null | undefined, now = Date.now() / 1000): string {
  if (!seconds) return t("library.update.never");
  const d = Math.max(0, now - seconds);
  if (d < 60) return t("library.update.justNow");
  if (d < 3600) return t("library.update.minutesAgo", { count: Math.round(d / 60) });
  if (d < 86400) return t("library.update.hoursAgo", { count: Math.round(d / 3600) });
  return t("library.update.daysAgo", { count: Math.round(d / 86400) });
}

export function outcomeText(t: T, o: UpdateOutcome | null | undefined): string | null {
  if (!o) return null;
  switch (o.outcome) {
    case "upToDate":
      return t("library.update.upToDate");
    case "available":
      return t("library.update.available", { catalog: o.catalog });
    case "applied":
      return t("library.update.applied", {
        catalog: o.summary.catalog,
        added: o.summary.added.length,
        changed: o.summary.changed.length,
        removed: o.summary.removed.length,
      });
    case "refused":
      return o.code === "unsigned"
        ? t("library.update.refusedUnsigned")
        : o.code === "signature"
          ? t("library.update.refusedSignature")
          : o.code === "key"
            ? t("library.update.refusedKey")
            : o.code === "older"
              ? t("library.update.refusedOlder")
              : t("library.update.refused", { reason: o.reason });
    case "failed":
      return t("library.update.failed");
    case "off":
      return t("library.update.isOff");
  }
}

/** The mirror has no signed release yet: not an error, the bundled catalog stays. */
export function awaitingSignedRelease(o: UpdateOutcome | null | undefined): boolean {
  return o?.outcome === "refused" && o.code === "unsigned";
}

export function LibraryUpdatePanel({ status, onChanged }: { status: LibraryStatus; onChanged: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<null | "check" | "rollback" | "apply">(null);
  const [message, setMessage] = useState<string | null>(null);
  const mode = (["auto", "notify", "off"].includes(status.updates) ? status.updates : "auto") as "auto" | "notify" | "off";
  const pending = status.lastOutcome?.outcome === "available" ? status.lastOutcome : null;

  const run = useCallback(
    async (what: "check" | "rollback" | "apply") => {
      setBusy(what);
      setMessage(null);
      try {
        if (what === "rollback") {
          const s = await libraryRollback();
          setMessage(t("library.update.rolledBack", { catalog: s.catalog }));
        } else {
          const o = await libraryCheckUpdate(what === "apply" ? true : undefined);
          setMessage(outcomeText(t, o));
        }
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        onChanged();
      }
    },
    [t, onChanged],
  );

  const setMode = (next: "auto" | "notify" | "off") => {
    void setSetting("library_updates", next).then(onChanged);
  };

  const c = status.catalog;
  return (
    <div className="lib-update" data-testid="library-update-panel">
      <div className="lib-update-head">
        <b>{c ? t("library.update.version", { catalog: c.catalog }) : t("library.update.noCatalog")}</b>
        {c && <span className="lib-muted">{c.source === "bundled" ? t("library.update.fromBundle") : t("library.update.fromUpdate", { when: ago(t, c.appliedAt) })}</span>}
      </div>
      <dl className="lib-kv">
        <dt>{t("library.update.offline")}</dt>
        <dd>{t("library.update.offlineCount", { count: status.offlineBodies })}</dd>
        <dt>{t("library.update.lastCheck")}</dt>
        <dd>{ago(t, status.lastCheck)}</dd>
        <dt>{t("library.update.schedule")}</dt>
        <dd>{mode === "off" ? t("library.update.isOff") : t("library.update.every12h")}</dd>
      </dl>
      {status.lastError && <p className="lib-blocked" role="status">{outcomeText(t, status.lastOutcome) ?? status.lastError}</p>}
      {status.trustedKeys === 0 && <p className="lib-muted">{t("library.update.noKeyNote")}</p>}
      {status.trustedKeys > 0 && !status.lastError && !message && awaitingSignedRelease(status.lastOutcome) && (
        <p className="lib-muted" data-testid="library-update-waiting">
          {t("library.update.refusedUnsigned")}
        </p>
      )}
      <div className="lib-update-row">
        <span className="lib-muted">{t("library.update.updates")}</span>
        <Segmented
          size="sm"
          label={t("library.update.updates")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "auto", label: t("library.update.auto"), attrs: { "data-mode": "auto" } },
            { value: "notify", label: t("library.update.notify"), attrs: { "data-mode": "notify" } },
            { value: "off", label: t("library.update.off"), attrs: { "data-mode": "off" } },
          ]}
        />
      </div>
      <div className="lib-update-row">
        <Button size="sm" className="lib-check-now" loading={busy === "check"} disabled={!!busy || status.checking} onClick={() => void run("check")}>
          {busy === "check" || status.checking ? t("library.update.checking") : t("library.update.checkNow")}
        </Button>
        {pending && (
          <Button size="sm" variant="primary" loading={busy === "apply"} disabled={!!busy} onClick={() => void run("apply")}>
            {t("library.update.apply", { catalog: pending.catalog })}
          </Button>
        )}
        {c && c.source !== "bundled" && (
          <Button size="sm" variant="quiet" className="lib-rollback" loading={busy === "rollback"} disabled={!!busy} onClick={() => void run("rollback")}>
            {t("library.update.rollback")}
          </Button>
        )}
      </div>
      {message && (
        <p className="lib-update-message" role="status">
          {message}
        </p>
      )}
      <p className="lib-muted">{t("library.update.projectsNote")}</p>
    </div>
  );
}

export function LibraryUpdateBadge({ status, fresh, open, onToggle }: { status: LibraryStatus | null; fresh: boolean; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const c = status?.catalog;
  const label = !status
    ? t("library.update.preparing")
    : !c
      ? t("library.update.noCatalog")
      : fresh
        ? t("library.update.badgeUpdated", { catalog: c.catalog })
        : t("library.update.badge", { catalog: c.catalog, when: ago(t, status.lastCheck ?? c.appliedAt) });
  return (
    <Button
      size="sm"
      variant="quiet"
      className="lib-badge-btn"
      aria-expanded={open}
      aria-haspopup="dialog"
      data-catalog={c?.catalog ?? ""}
      data-fresh={fresh || undefined}
      onClick={onToggle}
      icon={<span className={fresh ? "lib-dot lib-dot--fresh" : "lib-dot"} aria-hidden="true" />}
    >
      {label}
    </Button>
  );
}
