/**
 * Pane-header chips for a terminal session running an agent (2.0, behind
 * the agentCatalog flag):
 *
 *  - Instruction files (F30): the files the agent loads when started in the
 *    session's folder ("CLAUDE.md + AGENTS.md"). Clicking it opens a
 *    read-only view of those files, the agent's settings files and skills,
 *    and the MCP servers every agent sees here, including what is in the
 *    session's attached folders (listed, not loaded). The one action,
 *    "Link CLAUDE.md to AGENTS.md", adds `@AGENTS.md` to the agent's own
 *    instruction file so every agent follows one set of project rules.
 *  - Safety (F35): "Looser than default" when the agent's command line holds
 *    a flag that runs it looser than Hermes's default, or when the agent has
 *    no flag that can hold it to the default. The command line is read from
 *    the processes under the session's shell, so it also covers an agent the
 *    user started by hand.
 *
 * Hermes only observes here: nothing is typed into the terminal. Nothing
 * is shown for an SSH session (the agent runs on the other machine), and
 * polling pauses while the window is hidden.
 */
import "../styles/components/AgentSetupChips.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { getAgent, CUSTOM_AGENT_ID } from "../catalog/agentCatalog";
import { findAgentInvocation, isSafetyDefaultEnabled, judgeSafety } from "../catalog/agentSafety";
import { getSessionProjects } from "../api/projects";
import {
  getAgentSetupOverview,
  getSessionProcessArgv,
  linkInstructionsToAgentsMd,
  type AgentSetupOverview,
  type SetupItem,
} from "../api/agentSetup";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Chip } from "./ui/Chip";

/** How often the processes under the shell are read. */
export const ARGV_POLL_MS = 2_000;
/** How often the files are re-read while nothing else changes. */
export const FILES_POLL_MS = 10_000;

interface Props {
  session: {
    id: string;
    mode?: string;
    ai_provider?: string | null;
    working_directory: string;
    workspace_paths: string[];
    ssh_info?: unknown;
  };
}

/** Whether the window is hidden (minimised, another space): polling pauses then. */
const windowHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** Distinct names of the files the agent loads, in load order. */
export function loadedInstructionNames(items: readonly SetupItem[]): string[] {
  const names: string[] = [];
  for (const i of items) if (i.loaded && !names.includes(i.name)) names.push(i.name);
  return names;
}

export function AgentSetupChips({ session }: Props) {
  const { t } = useI18n();
  // An SSH session's agent runs remotely: the local processes and files say nothing about it.
  const enabled = isSafetyDefaultEnabled() && session.mode !== "agent" && !session.ssh_info;
  const [argvs, setArgvs] = useState<string[][] | null>(null);
  const [overview, setOverview] = useState<AgentSetupOverview | null>(null);
  // Whether `overview` holds the MCP servers (read only while the view is open).
  const [mcpLoaded, setMcpLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const tick = () => {
      if (windowHidden()) return;
      getSessionProcessArgv(session.id)
        .then((a) => { if (!stopped) setArgvs(a); })
        .catch(() => { if (!stopped) setArgvs([]); });
    };
    tick();
    const h = setInterval(tick, ARGV_POLL_MS);
    return () => { stopped = true; clearInterval(h); };
  }, [enabled, session.id]);

  const invocation = useMemo(
    () => (argvs ? findAgentInvocation(argvs, session.ai_provider) : null),
    [argvs, session.ai_provider],
  );
  const chosen = session.ai_provider && session.ai_provider !== CUSTOM_AGENT_ID && getAgent(session.ai_provider)
    ? session.ai_provider
    : null;
  const agentId = invocation?.agentId ?? chosen;

  const cwd = session.working_directory;
  const attachedKey = session.workspace_paths.join("\n");
  useEffect(() => {
    if (!enabled || !agentId || !cwd) { setOverview(null); return; }
    let stopped = false;
    const load = async (initial = false) => {
      if (!initial && windowHidden()) return;
      // Attached folders: the session's extra workspace folders plus the
      // projects attached to it (the backend drops the session's own folder).
      const projects = await getSessionProjects(session.id).catch(() => []);
      const attached = [...new Set([
        ...(attachedKey ? attachedKey.split("\n") : []),
        ...projects.map((p) => p.path).filter(Boolean),
      ])];
      try {
        // The MCP servers are only shown in the open view.
        const o = await getAgentSetupOverview(agentId, cwd, attached, open);
        if (!stopped) { setOverview(o); setMcpLoaded(open); }
      } catch {
        if (!stopped) { setOverview(null); setMcpLoaded(false); }
      }
    };
    void load(true);
    const h = setInterval(() => void load(), FILES_POLL_MS);
    return () => { stopped = true; clearInterval(h); };
  }, [enabled, agentId, cwd, attachedKey, reload, session.id, open]);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const link = useCallback(async () => {
    if (!overview?.link || !agentId) return;
    setLinking(true);
    setLinkError(null);
    try {
      await linkInstructionsToAgentsMd(agentId, overview.link.folder);
      setReload((n) => n + 1);
    } catch (e) {
      setLinkError(String(e));
    } finally {
      setLinking(false);
    }
  }, [overview, agentId]);

  if (!enabled || !agentId) return null;

  const verdict = invocation ? judgeSafety(invocation.agentId, invocation.args) : null;
  const safetyState = verdict ? (verdict.level === "looser" ? "looser" : "default") : "unknown";
  const agentName = getAgent(agentId)?.name ?? agentId;
  const names = overview ? loadedInstructionNames(overview.instructions) : [];
  const label = overview ? (names.length ? names.join(" + ") : t("agentSetup.noInstructions")) : "…";
  const looserTitle = verdict?.level === "looser"
    ? verdict.reason === "flag"
      ? t("safety.looserFlag", { flag: verdict.flag })
      : t("safety.looserVendor", { agent: agentName, note: verdict.note })
    : undefined;

  return (
    <span
      ref={rootRef}
      className="agent-setup-chips"
      data-agent-id={agentId}
      data-safety={safetyState}
      data-files={names.join(",")}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Chip
        size="sm"
        className="agent-rules-chip"
        expanded={open}
        haspopup="dialog"
        title={t("agentSetup.chipTitle")}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </Chip>
      {verdict?.level === "looser" && (
        <Badge tone="warning" className="agent-safety-chip" role="status" title={looserTitle}>
          {t("safety.looser")}
        </Badge>
      )}
      {open && overview && (
        <div className="agent-setup-popover" role="dialog" aria-label={t("agentSetup.title", { agent: agentName })}>
          <div className="agent-setup-title">{t("agentSetup.title", { agent: agentName })}</div>
          {!overview.known && <p className="agent-setup-note">{t("agentSetup.unknown")}</p>}
          {looserTitle && <p className="agent-setup-note agent-setup-warning">{looserTitle}</p>}

          <Section title={t("agentSetup.instructions")} items={overview.instructions} emptyText={t("agentSetup.none")} />
          {overview.link && (
            <div className="agent-setup-link">
              <Button size="sm" className="agent-setup-link-btn" loading={linking} onClick={link}>
                {t("agentSetup.link", { file: overview.link.file })}
              </Button>
              <span className="agent-setup-note">{t("agentSetup.linkHint", { file: overview.link.file })}</span>
              {linkError && <span className="agent-setup-error">{t("agentSetup.linkFailed", { error: linkError })}</span>}
            </div>
          )}
          <Section title={t("agentSetup.settings")} items={overview.settings} emptyText={t("agentSetup.none")} />
          <Section title={t("agentSetup.skills")} items={overview.skills} emptyText={t("agentSetup.none")} />

          <div className="agent-setup-section agent-setup-mcp" data-loaded={mcpLoaded ? "true" : "false"}>
            <div className="agent-setup-section-title">{t("agentSetup.mcp")}</div>
            {!mcpLoaded && <div className="agent-setup-empty">…</div>}
            {mcpLoaded && overview.mcp.map((m) => (
              <div key={m.agentId} className="agent-setup-mcp-agent" data-agent-id={m.agentId}>
                <div className="agent-setup-mcp-agent-name">{m.agentName}</div>
                {m.servers.length === 0 ? (
                  <div className="agent-setup-empty">{t("agentSetup.none")}</div>
                ) : (
                  <ul className="agent-setup-list">
                    {m.servers.map((s) => (
                      <li key={`${s.source}:${s.name}`} className={s.loaded ? "" : "agent-setup-not-loaded"} data-scope={s.scope}>
                        <span className="agent-setup-name">{s.name}</span>
                        <span className="agent-setup-meta">{s.source}</span>
                        {!s.loaded && <span className="agent-setup-badge">{t("agentSetup.notLoaded")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <p className="agent-setup-note agent-setup-footer">{t("agentSetup.readOnly")}</p>
        </div>
      )}
    </span>
  );
}

function Section({ title, items, emptyText }: { title: string; items: SetupItem[]; emptyText: string }) {
  const { t } = useI18n();
  return (
    <div className="agent-setup-section">
      <div className="agent-setup-section-title">{title}</div>
      {items.length === 0 ? (
        <div className="agent-setup-empty">{emptyText}</div>
      ) : (
        <ul className="agent-setup-list">
          {items.map((i) => (
            <li key={i.path} className={i.loaded ? "" : "agent-setup-not-loaded"} data-scope={i.scope} title={i.path}>
              <span className="agent-setup-name">{i.display}</span>
              {i.scope === "global" && <span className="agent-setup-badge">{t("agentSetup.global")}</span>}
              {i.scope === "attached" && <span className="agent-setup-badge">{t("agentSetup.attached")}</span>}
              {i.via && <span className="agent-setup-badge agent-setup-linked">{t("agentSetup.linkedFrom", { file: i.via })}</span>}
              {!i.loaded && <span className="agent-setup-badge">{t("agentSetup.notLoaded")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
