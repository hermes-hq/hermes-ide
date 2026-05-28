import { useEffect, useState } from "react";
import "../styles/components/UsagePanel.css";
import type { SessionData } from "../types/session";
import { useAgentUsage } from "../agent/useAgentUsage";
import type { RateLimitInfo } from "../agent/types";
import { useI18n } from "../i18n/I18nProvider";

interface UsagePanelProps {
  session: SessionData;
}

// Match Claude.ai Settings → Usage labels.  The SDK's `rateLimitType`
// strings vary across plans / model tiers; we map the known ones to the
// website's wording and fall through to a humanized fallback otherwise.
const RATE_LIMIT_LABEL_KEYS: Record<string, string> = {
  five_hour: "usage.currentSession",
  five_hour_limit: "usage.currentSession",
  weekly: "usage.weeklyAllModels",
  weekly_all_models: "usage.weeklyAllModels",
  weekly_sonnet: "usage.weeklySonnet",
  weekly_opus: "usage.weeklyOpus",
  weekly_haiku: "usage.weeklyHaiku",
  daily: "usage.dailyWindow",
  default: "usage.activeWindow",
};

const RATE_LIMIT_ORDER = [
  "five_hour",
  "five_hour_limit",
  "weekly",
  "weekly_all_models",
  "weekly_sonnet",
  "weekly_opus",
  "weekly_haiku",
  "daily",
];

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Render `resetsAt` as a relative countdown.  SDK gives epoch milliseconds
 * (or ISO string) — we accept either.  Returns a human string like
 * "resets in 2h 14m" or "resets in 4d 2h", and "now" once the deadline
 * has passed.
 */
type Translate = (key: string, values?: Record<string, string | number>) => string;

function formatCountdown(target: number | string | undefined, now: number, t: Translate): string {
  if (target === undefined) return "—";
  let ts: number;
  if (typeof target === "number") ts = target;
  else {
    const parsed = Date.parse(target);
    if (Number.isNaN(parsed)) return "—";
    ts = parsed;
  }
  const ms = ts - now;
  // SDK occasionally hands back a `resetsAt` already in the past — that
  // means the previous window already expired and we're in a clean one
  // until the next limit check.  "fresh window" reads accurately;
  // "resets now" implied the user was about to be unlocked, which was
  // the wrong mental model.
  if (ms <= 0) return t("usage.freshWindow");
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return t("usage.resetsInDaysHours", { days, hours });
  if (hours > 0) return t("usage.resetsInHoursMinutes", { hours, minutes: mins });
  if (mins > 0) return t("usage.resetsInMinutes", { minutes: mins });
  return t("usage.resetsInSeconds", { seconds: sec });
}

function formatAbsolute(target: number | string | undefined): string {
  if (target === undefined) return "";
  let ts: number;
  if (typeof target === "number") ts = target;
  else {
    const parsed = Date.parse(target);
    if (Number.isNaN(parsed)) return "";
    ts = parsed;
  }
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/** Pull a numeric utilization (0..1 or 0..100) out of a rate-limit blob.
 *  SDKs vary; we look at common keys and normalize to a 0..100 percent. */
function extractUtilizationPct(info: RateLimitInfo): number | null {
  const candidates: unknown[] = [
    (info as Record<string, unknown>).utilization,
    (info as Record<string, unknown>).utilizationPct,
    (info as Record<string, unknown>).usagePercent,
    (info as Record<string, unknown>).percentUsed,
  ];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v)) {
      const pct = v <= 1 ? v * 100 : v;
      return Math.max(0, Math.min(100, pct));
    }
  }
  // Some SDKs report a status string like "approaching_limit" / "exceeded";
  // we infer a coarse fill so the bar isn't blank.
  if (typeof info.status === "string") {
    if (/exceeded|over/i.test(info.status)) return 100;
    if (/approaching|warning/i.test(info.status)) return 80;
  }
  return null;
}

function formatStatus(status: string | undefined): string {
  if (!status) return "";
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function RateLimitRow({ kind, info, now }: { kind: string; info: RateLimitInfo; now: number }) {
  const { t } = useI18n();
  const labelKey = RATE_LIMIT_LABEL_KEYS[kind];
  const label = labelKey ? t(labelKey) : formatStatus(kind);
  const pct = extractUtilizationPct(info);
  const tone = pct === null ? "neutral" : pct >= 95 ? "danger" : pct >= 80 ? "warn" : "ok";
  const countdown = formatCountdown(info.resetsAt, now, t);
  const absolute = formatAbsolute(info.resetsAt);
  const overage = info.isUsingOverage === true;

  return (
    <div className="usage-window">
      <div className="usage-window-head">
        <span className="usage-window-label">{label}</span>
        {pct !== null && (
          <span className={`usage-window-pct usage-window-pct-${tone}`}>
            {Math.round(pct)}%
          </span>
        )}
      </div>
      {pct !== null && (
        <div className="usage-bar">
          <div
            className={`usage-bar-fill usage-bar-fill-${tone}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="usage-window-meta">
        <span className="usage-window-reset" title={absolute}>
          {countdown}
        </span>
        {info.status && (
          <span className={`usage-status usage-status-${tone}`}>
            {formatStatus(info.status)}
          </span>
        )}
      </div>
      {overage && (
        <div className="usage-overage">
          <span className="usage-overage-glyph" aria-hidden="true">⟳</span>
          <span>
            {t("usage.extraActive")}
            {info.overageResetsAt !== undefined &&
              ` · ${formatCountdown(info.overageResetsAt, now, t)}`}
          </span>
        </div>
      )}
    </div>
  );
}

export function UsagePanel({ session }: UsagePanelProps) {
  const { t } = useI18n();
  const isAgent = session.mode === "agent";
  const { accountInfo, rateLimits, cumulativeCostUsd, cumulativeInputTokens, cumulativeOutputTokens } =
    useAgentUsage(isAgent ? session.id : null);

  // Tick every 30s so countdowns drift in real time without re-rendering
  // the rest of the app.  Hour-resolution would be too coarse for the
  // "resets in 14m" case; second-resolution is wasteful.  30s is the
  // sweet spot for this read-only panel.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const sortedKinds = Object.keys(rateLimits).sort((a, b) => {
    const ai = RATE_LIMIT_ORDER.indexOf(a);
    const bi = RATE_LIMIT_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  // Per-session totals come from the SDK's `result` events (real spend),
  // accumulated in useAgentUsage.  The terminal-mode token tracker on
  // session.metrics doesn't run for agent-mode sessions — it'd always
  // read $0 / 0 tokens here.
  const totalCost = cumulativeCostUsd;
  const totalIn = cumulativeInputTokens;
  const totalOut = cumulativeOutputTokens;

  return (
    <div className="usage-panel">
      <div className="usage-panel-header">
        <span className="usage-panel-title">{t("usage.title")}</span>
        <span className="usage-panel-subtitle">claude · {t("usage.live")}</span>
      </div>

      <div className="usage-panel-body">
        {!isAgent && (
          <div className="usage-empty">
            <span className="usage-empty-glyph" aria-hidden="true">∅</span>
            <span className="usage-empty-text">
              {t("usage.agentOnly")}
            </span>
          </div>
        )}

        {isAgent && (
          <>
            <section className="usage-section">
              <div className="usage-section-title">{t("usage.account")}</div>
              {accountInfo ? (
                <dl className="usage-kv">
                  {accountInfo.subscriptionType && (
                    <>
                      <dt>{t("usage.plan")}</dt>
                      <dd className="usage-plan">
                        {formatStatus(accountInfo.subscriptionType)}
                      </dd>
                    </>
                  )}
                  {accountInfo.email && (
                    <>
                      <dt>{t("usage.email")}</dt>
                      <dd className="mono">{accountInfo.email}</dd>
                    </>
                  )}
                  {accountInfo.organization && (
                    <>
                      <dt>{t("usage.org")}</dt>
                      <dd>{accountInfo.organization}</dd>
                    </>
                  )}
                  {accountInfo.apiProvider && (
                    <>
                      <dt>{t("usage.provider")}</dt>
                      <dd className="mono">{accountInfo.apiProvider}</dd>
                    </>
                  )}
                  {accountInfo.tokenSource && (
                    <>
                      <dt>{t("usage.auth")}</dt>
                      <dd className="mono">{accountInfo.tokenSource}</dd>
                    </>
                  )}
                </dl>
              ) : (
                <div className="usage-pending">
                  <span className="usage-pending-glyph" aria-hidden="true">⠿</span>
                  <span>{t("usage.waitingAccount")}</span>
                </div>
              )}
            </section>

            <section className="usage-section">
              <div className="usage-section-title">{t("usage.rateLimits")}</div>
              {sortedKinds.length === 0 ? (
                <div className="usage-pending">
                  <span className="usage-pending-glyph" aria-hidden="true">·</span>
                  <span>{t("usage.noLimits")}</span>
                </div>
              ) : (
                <div className="usage-windows">
                  {sortedKinds.map((kind) => (
                    <RateLimitRow
                      key={kind}
                      kind={kind}
                      info={rateLimits[kind]}
                      now={now}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="usage-section">
              <div className="usage-section-title">{t("usage.thisSession")}</div>
              <dl className="usage-kv">
                <dt>{t("usage.cost")}</dt>
                <dd className="usage-cost-value">{formatCost(totalCost)}</dd>
                <dt>{t("usage.input")}</dt>
                <dd className="mono">{formatNumber(totalIn)}</dd>
                <dt>{t("usage.output")}</dt>
                <dd className="mono">{formatNumber(totalOut)}</dd>
              </dl>
            </section>

            <div className="usage-footnote">
              {t("usage.footnote")}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
