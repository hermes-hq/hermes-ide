/**
 * MCP section for the right Context Panel.
 *
 * Lists init.mcp_servers with a colored status dot and an expandable
 * detail view that lazy-loads the on-disk spec — transport (stdio /
 * sse / http), command or URL, env / header KEYS (values are redacted
 * server-side because they may carry tokens), and the tools the SDK
 * reports for this server.
 *
 * Actions live inside the expanded body:
 *   - restart  → respawns the bridge so the SDK re-reads the config
 *   - remove   → confirmation step, then `remove_mcp_server` IPC +
 *                respawn so the deleted server actually disappears
 *
 * Visual: docs/internal/v1-tui-parity-plan.md §8.1 + §8.7.
 */
import "../styles/components/McpSection.css";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  classifyMcpStatus,
  describeMcpStatus,
  filterToolsForServer,
  type McpServerSpecView,
  type McpServerSummary,
  type McpStatusKind,
} from "../utils/mcpServers";

interface Props {
  servers: McpServerSummary[];
  tools: string[];
  onRequestAdd: () => void;
  onRequestRemove?: (name: string) => void | Promise<void>;
  onRequestRestart?: (name: string) => void | Promise<void>;
}

export function McpSection({
  servers,
  tools,
  onRequestAdd,
  onRequestRemove,
  onRequestRestart,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="mcp-section">
      {servers.length === 0 ? (
        <div className="mcp-empty">
          <span className="mcp-empty-hint">no MCP servers configured</span>
        </div>
      ) : (
        <ul className="mcp-list">
          {servers.map((s) => {
            const kind = classifyMcpStatus(s.status);
            const { label: statusLabel, tone } = describeMcpStatus(kind);
            const isOpen = expanded === s.name;
            return (
              <li key={s.name} className="mcp-row" data-status={kind} data-tone={tone}>
                <button
                  type="button"
                  className="mcp-row-header"
                  onClick={() => setExpanded(isOpen ? null : s.name)}
                  aria-expanded={isOpen}
                  title={statusLabel}
                >
                  <span
                    className="mcp-status-dot"
                    data-status={kind}
                    aria-hidden="true"
                  />
                  <span className="mcp-name">{s.name}</span>
                  <span className="mcp-status-text">{statusText(kind)}</span>
                  <span className="mcp-row-chevron" aria-hidden="true">
                    {isOpen ? "▾" : "▸"}
                  </span>
                </button>
                {isOpen && (
                  <McpRowDetails
                    name={s.name}
                    statusKind={kind}
                    statusLabel={statusLabel}
                    serverTools={filterToolsForServer(tools, s.name)}
                    onRequestRemove={onRequestRemove}
                    onRequestRestart={onRequestRestart}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="mcp-add-cta" onClick={onRequestAdd}>
        + Add MCP server
      </button>
      <McpStatusLegend />
    </div>
  );
}

function statusText(kind: McpStatusKind): string {
  switch (kind) {
    case "connected": return "connected";
    case "needs-auth": return "needs auth";
    case "failed": return "failed";
    case "unknown":
    default: return "unknown";
  }
}

interface DetailsProps {
  name: string;
  statusKind: McpStatusKind;
  statusLabel: string;
  serverTools: string[];
  onRequestRemove?: (name: string) => void | Promise<void>;
  onRequestRestart?: (name: string) => void | Promise<void>;
}

function McpRowDetails({
  name,
  statusKind,
  statusLabel,
  serverTools,
  onRequestRemove,
  onRequestRestart,
}: DetailsProps) {
  const [spec, setSpec] = useState<McpServerSpecView | null | "loading" | "error">("loading");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<McpServerSpecView | null>("read_mcp_server_spec", { name })
      .then((v) => { if (!cancelled) setSpec(v); })
      .catch(() => { if (!cancelled) setSpec("error"); });
    return () => { cancelled = true; };
  }, [name]);

  return (
    <div className="mcp-row-body">
      {/* Status explanation — always shown, color-coded via [data-status]
         on the row.  Text gives the "why" the dot color implies. */}
      <p className="mcp-status-explain" data-status={statusKind}>{statusLabel}</p>

      {/* Spec details — transport, command / URL, env / header keys.  Lazy-
         loaded from ~/.claude.json on expand. */}
      <McpSpecBody spec={spec} />

      {/* Tools the SDK reported for this server. */}
      <div className="mcp-tools">
        <div className="mcp-tools-label">Tools</div>
        {serverTools.length === 0 ? (
          <div className="mcp-tools-empty">
            {statusKind === "connected"
              ? "no tools listed"
              : "no tools (server isn't connected)"}
          </div>
        ) : (
          <ul className="mcp-tool-list">
            {serverTools.map((t) => (
              <li key={t} className="mcp-tool">{t}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Actions row — restart + remove.  Remove takes a confirmation
         step so a stray click can't nuke a server config. */}
      <div className="mcp-row-actions">
        {onRequestRestart && (
          <button
            type="button"
            className="mcp-action"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await onRequestRestart(name); } finally { setBusy(false); }
            }}
          >
            restart
          </button>
        )}
        {onRequestRemove && !confirmRemove && (
          <button
            type="button"
            className="mcp-action mcp-action-deny"
            disabled={busy}
            onClick={() => {
              console.log(`[mcp-ui] remove button clicked for "${name}"`);
              setConfirmRemove(true);
            }}
          >
            remove
          </button>
        )}
        {onRequestRemove && confirmRemove && (
          <div className="mcp-confirm">
            <span className="mcp-confirm-text">
              Delete <strong>{name}</strong> from <code>~/.claude.json</code>?
            </span>
            <button
              type="button"
              className="mcp-action"
              disabled={busy}
              onClick={() => {
                console.log(`[mcp-ui] remove cancelled for "${name}"`);
                setConfirmRemove(false);
              }}
            >
              cancel
            </button>
            <button
              type="button"
              className="mcp-action mcp-action-deny mcp-action-confirm"
              disabled={busy}
              onClick={async () => {
                console.log(`[mcp-ui] yes-remove confirmed for "${name}" — calling onRequestRemove`);
                setBusy(true);
                try {
                  await onRequestRemove(name);
                  console.log(`[mcp-ui] onRequestRemove resolved for "${name}"`);
                } catch (err) {
                  console.warn(`[mcp-ui] onRequestRemove threw for "${name}":`, err);
                } finally {
                  setBusy(false);
                  setConfirmRemove(false);
                }
              }}
            >
              {busy ? "removing…" : "yes, remove"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function McpSpecBody({ spec }: { spec: McpServerSpecView | null | "loading" | "error" }) {
  if (spec === "loading") {
    return <div className="mcp-spec mcp-spec-loading">loading spec…</div>;
  }
  if (spec === "error") {
    return (
      <div className="mcp-spec mcp-spec-error">
        couldn't read <code>~/.claude.json</code>
      </div>
    );
  }
  if (spec === null) {
    return (
      <div className="mcp-spec mcp-spec-orphan">
        Live in this session but not in <code>~/.claude.json</code> — managed
        elsewhere (a project-scope config or a plugin?).
      </div>
    );
  }

  const isStdio = spec.transport === "stdio";
  const isRemote = spec.transport === "sse" || spec.transport === "http";

  return (
    <div className="mcp-spec">
      <div className="mcp-spec-row">
        <span className="mcp-spec-label">Transport</span>
        <span className="mcp-spec-value mcp-spec-transport" data-transport={spec.transport}>
          {spec.transport}
        </span>
      </div>

      {isStdio && spec.command && (
        <div className="mcp-spec-row">
          <span className="mcp-spec-label">Command</span>
          <code className="mcp-spec-value mcp-spec-code">
            {[spec.command, ...spec.args].join(" ")}
          </code>
        </div>
      )}

      {isRemote && spec.url && (
        <div className="mcp-spec-row">
          <span className="mcp-spec-label">URL</span>
          <code className="mcp-spec-value mcp-spec-code">{spec.url}</code>
        </div>
      )}

      {spec.env_keys.length > 0 && (
        <div className="mcp-spec-row">
          <span className="mcp-spec-label">Env</span>
          <span className="mcp-spec-chips" title="Values are redacted — only key names are shown.">
            {spec.env_keys.map((k) => (
              <span key={k} className="mcp-spec-chip">{k}</span>
            ))}
          </span>
        </div>
      )}

      {spec.header_keys.length > 0 && (
        <div className="mcp-spec-row">
          <span className="mcp-spec-label">Headers</span>
          <span className="mcp-spec-chips" title="Values are redacted — only key names are shown.">
            {spec.header_keys.map((k) => (
              <span key={k} className="mcp-spec-chip">{k}</span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** Tiny legend that decodes the four status dot colors.  Sits at the
 *  bottom of the section so a first-time user can self-orient without
 *  hovering each row. */
function McpStatusLegend() {
  return (
    <details className="mcp-legend">
      <summary>What do the status dots mean?</summary>
      <ul className="mcp-legend-list">
        <li><span className="mcp-status-dot" data-status="connected" /> Connected — tools are live.</li>
        <li><span className="mcp-status-dot" data-status="needs-auth" /> Needs auth — set the env / API key.</li>
        <li><span className="mcp-status-dot" data-status="failed" /> Failed — bridge couldn't connect; check the command / URL.</li>
        <li><span className="mcp-status-dot" data-status="unknown" /> Unknown — live init hasn't reported yet.</li>
      </ul>
    </details>
  );
}
