// "Install into project": the entry compiled by @hermes-hq/hodios-core for
// the agent the person picks, every file shown before anything is written,
// recorded in .hodios.lock. Nothing runs; a file someone edited is never
// overwritten (the new version goes next to it).

import { useEffect, useMemo, useState } from "react";
import { Button, Chip, CloseButton } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { listAgents } from "../../catalog/agentCatalog";
import { libraryInstallApply, libraryInstallPreview } from "../../library/api";
import { loadCore } from "../../library/render";
import { agentName, installTarget, invocation } from "../../library/targets";
import type { CompiledFileForInstall, EntryDetail, InstallPlan } from "../../library/types";

/** The lock file every install updates (same as the hodios CLI's). */
const LOCK_FILE = ".hodios.lock";

/** Lines only in `next` (+) and only in `prev` (−): enough to read a change. */
export function lineDiff(prev: string | null, next: string): { sign: "+" | "-" | " "; text: string }[] {
  const a = (prev ?? "").split("\n");
  const b = next.split("\n");
  const inA = new Set(a);
  const inB = new Set(b);
  const out: { sign: "+" | "-" | " "; text: string }[] = [];
  for (const line of a) if (!inB.has(line) && line.trim()) out.push({ sign: "-", text: line });
  for (const line of b) if (!inA.has(line) && line.trim()) out.push({ sign: "+", text: line });
  return out;
}

export function LibraryInstall({
  entry,
  projectPath,
  installedAgentIds,
  initialAgentId,
  catalog,
  onClose,
  onInstalled,
}: {
  entry: EntryDetail;
  /** The catalog version the entry comes from (recorded in the lock). */
  catalog: string;
  projectPath: string;
  installedAgentIds: readonly string[];
  initialAgentId: string;
  onClose: () => void;
  onInstalled: (message: string) => void;
}) {
  const { t } = useI18n();
  const [agentId, setAgentId] = useState(initialAgentId);
  const [files, setFiles] = useState<CompiledFileForInstall[]>([]);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = entry.row.kind;
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
  const agents = useMemo(() => listAgents(false).filter((a) => a.id !== "custom" && installTarget(a.id, kind) !== null), [kind]);

  useEffect(() => {
    let live = true;
    setPlan(null);
    setError(null);
    const target = installTarget(agentId, kind);
    if (!target || !entry.body) {
      setError(t("library.install.cannot", { kind: t(`library.kind.${kind}`) }));
      return;
    }
    (async () => {
      const core = await loadCore();
      const result = core.compileFor(entry.body as never, target, { scope: "project", catalog });
      const compiled: CompiledFileForInstall[] = result.files
        .filter((f) => !!f.path)
        .map((f) => ({
          id: entry.id,
          version: entry.row.v,
          kind,
          target: result.target,
          format: result.adapter,
          path: String(f.path),
          content: f.content,
          section: f.mode === "section",
          catalog,
        }));
      if (compiled.length === 0) throw new Error(t("library.install.cannot", { kind: t(`library.kind.${kind}`) }));
      const p = await libraryInstallPreview(projectPath, compiled);
      if (!live) return;
      setFiles(compiled);
      setPlan(p);
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [agentId, entry, kind, projectPath, catalog, t]);

  const install = async () => {
    setBusy(true);
    try {
      const r = await libraryInstallApply(projectPath, agentId, files);
      const how = invocation(agentId, entry.id, kind);
      onInstalled(
        r.sideFiles.length > 0
          ? t("library.install.doneSide", { project: projectName, agent: agentName(agentId), count: r.sideFiles.length })
          : how
            ? t("library.install.doneInvoke", { project: projectName, agent: agentName(agentId), command: how })
            : t("library.install.done", { project: projectName, agent: agentName(agentId) }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changed = plan?.files.filter((f) => f.status !== "unchanged") ?? [];
  return (
    <div className="lib-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="lib-sheet" role="dialog" aria-modal="true" aria-label={t("library.install.title", { title: entry.row.title, project: projectName })} onClick={(e) => e.stopPropagation()}>
        <div className="lib-sheet-head">
          <div>
            <h2 className="lib-sheet-title">{t("library.install.title", { title: entry.row.title, project: projectName })}</h2>
            <p className="lib-muted">{t("library.install.subtitle")}</p>
          </div>
          <CloseButton label={t("library.close")} onClick={onClose} />
        </div>
        <div className="lib-sheet-body">
          <div className="lib-detail-label">
            <span>{t("library.install.for")}</span>
          </div>
          <div className="lib-chip-wrap" role="group" aria-label={t("library.install.for")}>
            {agents.map((a) => (
              <Chip key={a.id} selected={a.id === agentId} onToggle={() => setAgentId(a.id)} buttonAttrs={{ className: "lib-install-agent", "data-agent": a.id }}>
                {a.name}
                {!installedAgentIds.includes(a.id) ? ` · ${t("library.install.notInstalled")}` : ""}
              </Chip>
            ))}
          </div>
          {error && <p className="lib-blocked" role="alert">{error}</p>}
          {plan && (
            <>
              <div className="lib-detail-label">
                <span>{t("library.install.files")}</span>
                <span>{t("library.install.filesCount", { count: plan.files.length })}</span>
              </div>
              <div className="lib-files">
                {plan.files.map((f) => (
                  <div key={f.path} className="lib-file" data-path={f.path} data-status={f.status}>
                    <span className={`lib-file-op lib-file-op--${f.status}`}>{f.status === "add" ? "+" : f.status === "unchanged" ? "=" : "~"}</span>
                    <span className="lib-file-path">{f.path}</span>
                    <span className="lib-muted">{t(`library.install.status.${f.status}`)}</span>
                  </div>
                ))}
                <div className="lib-file" data-path={LOCK_FILE}>
                  <span className="lib-file-op lib-file-op--update">~</span>
                  <span className="lib-file-path">{LOCK_FILE}</span>
                  <span className="lib-muted">{t("library.install.lockEntry")}</span>
                </div>
              </div>
              {changed
                .filter((f) => f.status !== "add")
                .map((f) => (
                  <pre key={f.path} className="lib-diff" aria-label={f.path}>
                    {lineDiff(f.current, f.next).map((l, i) => (
                      <span key={i} className={l.sign === "+" ? "lib-diff-add" : "lib-diff-del"}>
                        {l.sign} {l.text}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                ))}
              <div className="lib-detail-label">
                <span>{LOCK_FILE}</span>
              </div>
              <pre className="lib-diff" data-testid="library-lock-diff">
                {lineDiff(plan.lockBefore, plan.lockAfter).map((l, i) => (
                  <span key={i} className={l.sign === "+" ? "lib-diff-add" : "lib-diff-del"}>
                    {l.sign} {l.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </>
          )}
        </div>
        <div className="lib-sheet-foot">
          <span className="lib-muted">{t("library.install.note")}</span>
          <Button onClick={onClose}>{t("library.cancel")}</Button>
          <Button variant="primary" className="lib-install-confirm" disabled={!plan || busy || changed.length === 0} loading={busy} onClick={() => void install()}>
            {t("library.install.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
