// The open entry: what it is, why it is here, its arguments as a form with
// a live preview of exactly what the agent receives, and the actions that
// work for every agent (use in a session, start a task, install).

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Input, NativeSelect, Textarea, Toggle } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { listAgents } from "../../catalog/agentCatalog";
import { personaDelivery, systemPromptFlag } from "../../library/delivery";
import { argsOf, defaultValues, loadCore, missingRequired, renderWith } from "../../library/render";
import { agentName, installTarget } from "../../library/targets";
import type { LegacyItem } from "../../library/legacy";
import type { EntryArg, EntryDetail, Reason } from "../../library/types";
import { KindTag, reasonText } from "./LibraryParts";

type Core = Awaited<ReturnType<typeof loadCore>>;

export interface SessionChoice {
  id: string;
  label: string;
  mode: "terminal" | "agent";
  agentId: string | null;
}

export interface DetailActions {
  use(text: string, sessionId: string): void;
  startTask(task: string, persona: { text: string } | null): void;
  install(): void;
  copy(text: string): void;
  pin(next: boolean): void;
  hide(next: boolean): void;
  duplicate(text: string): void;
}

function ArgField({ arg, value, onChange }: { arg: EntryArg; value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const id = `lib-arg-${arg.name}`;
  const enumValues = Array.isArray(arg.enum) ? arg.enum : null;
  return (
    <div className="lib-field" data-arg={arg.name}>
      <label htmlFor={id} className="lib-field-label">
        <span className="lib-field-name">{arg.name}</span>
        {arg.required && arg.default === undefined && <span className="lib-field-required">{t("library.detail.required")}</span>}
      </label>
      {enumValues ? (
        <NativeSelect id={id} size="sm" value={value} onChange={(e) => onChange(e.target.value)}>
          {!arg.required && <option value="">{t("library.detail.notSet")}</option>}
          {enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </NativeSelect>
      ) : arg.type === "boolean" ? (
        <Toggle id={id} checked={value === "true"} onChange={(c) => onChange(c ? "true" : "")} label={arg.description} />
      ) : (arg.description?.length ?? 0) > 60 || arg.type === "text" ? (
        <Textarea id={id} rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={arg.default !== undefined ? String(arg.default) : ""} />
      ) : (
        <Input id={id} size="sm" value={value} onChange={(e) => onChange(e.target.value)} placeholder={arg.default !== undefined ? String(arg.default) : ""} />
      )}
      {arg.description && arg.type !== "boolean" && <span className="lib-field-help">{arg.description}</span>}
    </div>
  );
}

export function LibraryDetail({
  entry,
  legacy,
  reasons,
  sessions,
  defaultSessionId,
  installAgentId,
  pinned,
  hidden,
  actions,
}: {
  entry: EntryDetail | null;
  legacy: LegacyItem | null;
  reasons: Reason[];
  sessions: SessionChoice[];
  defaultSessionId: string | null;
  installAgentId: string | null;
  pinned: boolean;
  hidden: boolean;
  actions: DetailActions;
}) {
  const { t } = useI18n();
  const [core, setCore] = useState<Core | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [level, setLevel] = useState(3);
  const [sessionId, setSessionId] = useState<string | null>(defaultSessionId);
  const [tab, setTab] = useState<"about" | "changelog">("about");
  const body = entry?.body ?? null;
  const kind = legacy ? (legacy.group === "mine" ? "mine" : "classic") : (entry?.row.kind ?? "prompt");

  useEffect(() => {
    let live = true;
    loadCore()
      .then((c) => live && setCore(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setValues(defaultValues(body));
    setLevel(3);
    setTab("about");
  }, [body, legacy?.key]);

  useEffect(() => {
    if (!sessionId || !sessions.some((s) => s.id === sessionId)) setSessionId(defaultSessionId ?? sessions[0]?.id ?? null);
  }, [sessions, sessionId, defaultSessionId]);

  const text = useMemo(() => {
    if (legacy) return legacy.text;
    if (!body || !core) return "";
    try {
      return renderWith(core, body, values, body.fm.kind === "style" ? level : undefined);
    } catch (e) {
      console.warn("[library] could not render", e);
      return body.body;
    }
  }, [legacy, body, core, values, level]);

  const missing = legacy ? [] : missingRequired(body, values);
  const args = legacy ? [] : argsOf(body);
  const title = legacy?.title ?? entry?.row.title ?? "";
  const description = legacy?.description ?? entry?.row.desc ?? "";
  const target = sessions.find((s) => s.id === sessionId) ?? null;
  const isPersona = kind === "persona";
  const isRule = kind === "rule";
  const canInstall = !legacy && !!entry && !!installAgentId && installTarget(installAgentId, entry.row.kind) !== null;
  const blocked = missing.length > 0 ? t("library.detail.fillFirst", { name: missing.join(", ") }) : null;
  const versionLabel = legacy ? null : entry ? `v${entry.row.v}` : null;
  const changelog = (body?.fm.changelog ?? []) as { version: string; note: string }[];

  if (!entry && !legacy) {
    return (
      <aside className="lib-detail lib-detail--empty" aria-label={t("library.detail.label")}>
        <p className="lib-muted">{t("library.detail.loading")}</p>
      </aside>
    );
  }

  return (
    <aside className="lib-detail" aria-label={t("library.detail.label")} data-entry={entry?.id ?? legacy?.key}>
      <div className="lib-detail-scroll">
        <div className="lib-detail-crumb">
          <KindTag kind={kind} />
          {entry && (
            <span>
              {String(entry.row.dom)} › {String(entry.row.cat)}
            </span>
          )}
          {legacy && <span>{legacy.group === "mine" ? t("library.nav.mine") : t("library.nav.classics")}</span>}
        </div>
        <h2 className="lib-detail-title">{title}</h2>
        {description && <p className="lib-detail-desc">{description}</p>}
        <div className="lib-detail-meta">
          {versionLabel && <Badge>{versionLabel}</Badge>}
          {entry && <Badge>{t("library.detail.tierStatus", { tier: String(entry.row.tier), status: String(entry.row.status) })}</Badge>}
          {entry?.body && <Badge tone="success">{t("library.badge.offline")}</Badge>}
          {pinned && <Badge tone="warning">{t("library.badge.pinned")}</Badge>}
          {entry?.isNew && <Badge tone="info">{t("library.badge.updated")}</Badge>}
          {entry?.resolvedFrom && <Badge>{t("library.detail.aliasOf", { id: entry.resolvedFrom })}</Badge>}
        </div>

        {reasons.length > 0 && (
          <section className="lib-detail-section">
            <div className="lib-detail-label">
              <span>{t("library.detail.why")}</span>
              {!legacy && (
                <Button variant="link" size="sm" className="lib-hide" onClick={() => actions.hide(!hidden)}>
                  {hidden ? t("library.detail.unhide") : t("library.detail.notRelevant")}
                </Button>
              )}
            </div>
            <div className="lib-whybox">
              {reasons.map((r, i) => (
                <div key={i}>{reasonText(t, r)}</div>
              ))}
              <span className="lib-muted">{t("library.detail.onDevice")}</span>
            </div>
          </section>
        )}

        {!legacy && entry && (
          <div className="lib-detail-tabs" role="group" aria-label={t("library.detail.label")}>
            <Button variant={tab === "about" ? "secondary" : "quiet"} size="sm" onClick={() => setTab("about")} aria-pressed={tab === "about"}>
              {t("library.detail.aboutTab")}
            </Button>
            <Button variant={tab === "changelog" ? "secondary" : "quiet"} size="sm" onClick={() => setTab("changelog")} aria-pressed={tab === "changelog"}>
              {t("library.detail.changelog")}
            </Button>
          </div>
        )}

        {tab === "changelog" && !legacy ? (
          <ol className="lib-changelog">
            {changelog.length === 0 && <li className="lib-muted">{t("library.detail.noChangelog")}</li>}
            {changelog.map((c) => (
              <li key={c.version}>
                <b>{c.version}</b> {c.note}
              </li>
            ))}
          </ol>
        ) : (
          <>
            {isPersona && entry && (
              <section className="lib-detail-section">
                <div className="lib-detail-label">
                  <span>{t("library.detail.personaHow")}</span>
                </div>
                <table className="lib-deliv">
                  <thead>
                    <tr>
                      <th>{t("library.detail.agent")}</th>
                      <th>{t("library.detail.deliveredAs")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listAgents(false)
                      .filter((a) => a.id !== "custom")
                      .map((a) => {
                        const how = personaDelivery(a.id, "terminal");
                        return (
                          <tr key={a.id} data-agent={a.id} data-delivery={how}>
                            <td>{a.name}</td>
                            <td>
                              {how === "system"
                                ? t("library.delivery.system", { flag: systemPromptFlag(a.id) ?? "" })
                                : how === "first-message"
                                  ? t("library.delivery.firstMessage")
                                  : t("library.delivery.clipboard")}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </section>
            )}

            {args.length > 0 && (
              <section className="lib-detail-section lib-args">
                <div className="lib-detail-label">
                  <span>{t("library.detail.arguments")}</span>
                </div>
                {args.map((a) => (
                  <ArgField key={a.name} arg={a} value={values[a.name] ?? ""} onChange={(v) => setValues((cur) => ({ ...cur, [a.name]: v }))} />
                ))}
              </section>
            )}

            {body?.fm.kind === "style" && Array.isArray(body.fm.levels) && (
              <section className="lib-detail-section">
                <div className="lib-detail-label">
                  <span>{t("library.detail.level")}</span>
                </div>
                <NativeSelect size="sm" value={String(level)} onChange={(e) => setLevel(Number(e.target.value))} aria-label={t("library.detail.level")}>
                  {body.fm.levels.map((l, i) => (
                    <option key={i} value={String(i + 1)}>
                      {i + 1} · {l.label}
                    </option>
                  ))}
                </NativeSelect>
              </section>
            )}

            {body && body.steps.length > 0 && (
              <section className="lib-detail-section">
                <div className="lib-detail-label">
                  <span>{t("library.detail.steps")}</span>
                </div>
                <ol className="lib-steps">
                  {body.steps.map((s) => (
                    <li key={s.id}>
                      {s.id}
                      {s.gate === "approve" ? ` · ${t("library.detail.gate")}` : ""}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section className="lib-detail-section">
              <div className="lib-detail-label">
                <span>{isPersona ? t("library.detail.personaText") : t("library.detail.preview")}</span>
                <span>{t("library.detail.previewHint")}</span>
              </div>
              <pre className="lib-preview" data-testid="library-preview">
                {text || (core ? "" : t("library.detail.loading"))}
              </pre>
            </section>

            <section className="lib-detail-section">
              <div className="lib-detail-label">
                <span>{t("library.detail.also")}</span>
              </div>
              <div className="lib-detail-row">
                <Button size="sm" onClick={() => actions.copy(text)} disabled={!text}>
                  {t("library.detail.copy")}
                </Button>
                {!legacy && (
                  <Button size="sm" onClick={() => actions.duplicate(text)} disabled={!text}>
                    {t("library.detail.duplicate")}
                  </Button>
                )}
                {!legacy && (
                  <Button size="sm" className="lib-pin" onClick={() => actions.pin(!pinned)}>
                    {pinned ? t("library.detail.unpin") : t("library.detail.pin")}
                  </Button>
                )}
              </div>
            </section>
          </>
        )}
      </div>

      <div className="lib-detail-actions">
        {!isRule && (
          <div className="lib-detail-target">
            <label htmlFor="lib-use-target">{t("library.detail.into")}</label>
            {sessions.length > 0 ? (
              <NativeSelect id="lib-use-target" size="sm" value={sessionId ?? ""} onChange={(e) => setSessionId(e.target.value)}>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} · {s.agentId ? agentName(s.agentId) : t("library.detail.shell")} · {s.mode === "agent" ? t("library.detail.agentView") : t("library.detail.terminal")}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <span className="lib-muted">{t("library.detail.noSession")}</span>
            )}
            <span className="lib-muted">{t("library.detail.notSent")}</span>
          </div>
        )}
        {blocked && <p className="lib-blocked" role="status">{blocked}</p>}
        <div className="lib-detail-row">
          {!isRule && (
            <Button
              variant="primary"
              className="lib-use"
              disabled={!text || !target || !!blocked}
              onClick={() => target && actions.use(text, target.id)}
            >
              {isPersona ? t("library.detail.useAsMessage") : t("library.detail.use")}
            </Button>
          )}
          {!isRule && (
            <Button
              className="lib-start"
              disabled={!text || !!blocked}
              onClick={() => (isPersona ? actions.startTask("", { text }) : actions.startTask(text, null))}
            >
              {isPersona ? t("library.detail.startAs", { name: title }) : t("library.detail.startTask")}
            </Button>
          )}
          {canInstall && installAgentId && (
            <Button className="lib-install" onClick={actions.install}>
              {t("library.detail.install", { agent: agentName(installAgentId) })}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
