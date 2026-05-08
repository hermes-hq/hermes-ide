/**
 * MCP section for the right Context Panel.  Lists init.mcp_servers
 * with status dots; click to expand and see the server's tools.
 *
 * Visual: docs/internal/v1-tui-parity-plan.md §8.1 + §8.7.
 */
import "../styles/components/McpSection.css";
import { useState } from "react";
import {
  filterToolsForServer,
  type McpServerSummary,
} from "../utils/mcpServers";

interface Props {
  servers: McpServerSummary[];
  tools: string[];
  onRequestAdd: () => void;
  onRequestRemove?: (name: string) => void;
  onRequestRestart?: (name: string) => void;
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
          {servers.map((s) => (
            <li key={s.name} className="mcp-row" data-status={s.status}>
              <button
                type="button"
                className="mcp-row-header"
                onClick={() => setExpanded(expanded === s.name ? null : s.name)}
                aria-expanded={expanded === s.name}
              >
                <span className="mcp-status-dot" data-status={s.status} aria-hidden="true" />
                <span className="mcp-name">{s.name}</span>
                <span className="mcp-status-text">{s.status}</span>
              </button>
              {expanded === s.name && (
                <div className="mcp-row-body">
                  <ul className="mcp-tool-list">
                    {filterToolsForServer(tools, s.name).map((t) => (
                      <li key={t} className="mcp-tool">{t}</li>
                    ))}
                    {filterToolsForServer(tools, s.name).length === 0 && (
                      <li className="mcp-tool-empty">no tools listed</li>
                    )}
                  </ul>
                  <div className="mcp-row-actions">
                    {onRequestRestart && (
                      <button
                        type="button"
                        className="mcp-action"
                        onClick={() => onRequestRestart(s.name)}
                      >
                        restart
                      </button>
                    )}
                    {onRequestRemove && (
                      <button
                        type="button"
                        className="mcp-action mcp-action-deny"
                        onClick={() => onRequestRemove(s.name)}
                      >
                        remove
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="mcp-add-cta"
        onClick={onRequestAdd}
      >
        + Add MCP server
      </button>
    </div>
  );
}
