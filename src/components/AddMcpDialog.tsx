/**
 * Add-MCP-server dialog.  Visual: docs/internal/v1-tui-parity-plan.md §8.7.
 *
 * Trust + show status dot — no probe-on-save (locked decision §0.7).
 * Writes directly to ~/.claude.json via `write_mcp_server` IPC; SDK
 * picks up the new server on the next agent respawn.
 */
import "../styles/components/AddMcpDialog.css";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  buildMcpSpec,
  validateAddMcpForm,
  type AddMcpForm,
} from "../utils/mcpServers";

interface Props {
  existingNames: string[];
  onClose: () => void;
}

export function AddMcpDialog({ existingNames, onClose }: Props) {
  const [form, setForm] = useState<AddMcpForm>({
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    headers: "",
    env: [],
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof AddMcpForm>(key: K, value: AddMcpForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit() {
    const errs = validateAddMcpForm(form, existingNames);
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setSubmitting(true);
    try {
      await invoke("write_mcp_server", {
        name: form.name.trim(),
        spec: buildMcpSpec(form),
      });
      onClose();
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      setSubmitting(false);
    }
  }

  // Show explicit errors from a failed submit OR live validation
  // errors once the user has tried to submit (errors.length set).
  const visibleErrors = errors.length > 0 ? errors : [];

  return (
    <div className="add-mcp-dialog" role="dialog" aria-label="Add MCP server">
      <div className="add-mcp-overlay" onClick={onClose} aria-hidden="true" />
      <div className="add-mcp-card">
        <div className="add-mcp-card-header">ADD MCP SERVER</div>
        <div className="add-mcp-card-body">
          <Field label="name">
            <input
              id="add-mcp-name"
              type="text"
              className="add-mcp-input"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="transport">
            <fieldset className="add-mcp-radio-row">
              {(["stdio", "sse", "http"] as const).map((t) => (
                <label key={t} className="add-mcp-radio">
                  <input
                    type="radio"
                    name="transport"
                    checked={form.transport === t}
                    onChange={() => set("transport", t)}
                  />
                  <span>{t}</span>
                </label>
              ))}
            </fieldset>
          </Field>
          {form.transport === "stdio" ? (
            <>
              <Field label="command">
                <input
                  id="add-mcp-command"
                  type="text"
                  className="add-mcp-input"
                  value={form.command}
                  onChange={(e) => set("command", e.target.value)}
                />
              </Field>
              <Field label="args" hint="comma-separated">
                <input
                  id="add-mcp-args"
                  type="text"
                  className="add-mcp-input"
                  value={form.args}
                  onChange={(e) => set("args", e.target.value)}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="url">
                <input
                  id="add-mcp-url"
                  type="text"
                  className="add-mcp-input"
                  value={form.url}
                  onChange={(e) => set("url", e.target.value)}
                />
              </Field>
              <Field label="headers" hint="key:value, key:value">
                <input
                  id="add-mcp-headers"
                  type="text"
                  className="add-mcp-input"
                  value={form.headers}
                  onChange={(e) => set("headers", e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
        {visibleErrors.length > 0 && (
          <ul className="add-mcp-errors">
            {visibleErrors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <div className="add-mcp-actions">
          <button type="button" className="add-mcp-link" onClick={onClose}>esc cancel</button>
          <button
            type="button"
            className="add-mcp-link add-mcp-link-primary"
            onClick={onSubmit}
            disabled={submitting}
          >
            ⏎ save & spawn →
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  // Pull the input id from the child's id prop so <label htmlFor> works.
  const id = (children as { props?: { id?: string } }).props?.id;
  return (
    <div className="add-mcp-field">
      <label htmlFor={id} className="add-mcp-label">
        {label}{hint && <span className="add-mcp-hint">  {hint}</span>}
      </label>
      <div className="add-mcp-control">{children}</div>
    </div>
  );
}
