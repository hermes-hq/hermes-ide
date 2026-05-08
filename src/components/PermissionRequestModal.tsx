/**
 * Permission request modal.  Rendered when the bridge forwards a
 * canUseTool request as a `_hermes_perm_request` envelope.  The user's
 * decision (approve, approve-all, deny, edit) is sent back via the
 * caller's `onDecision` handler — which writes a `_hermes_perm_response`
 * to the bridge's stdin.
 *
 * Visual: docs/internal/v1-tui-parity-plan.md §8.4.
 */
import "../styles/components/PermissionRequestModal.css";
import { useEffect, useMemo, useState } from "react";
import {
  buildApproveAllAllowRule,
  type PermRequest,
  type PermissionDecision,
} from "../utils/permissionRequest";

interface Props {
  request: PermRequest;
  permissionMode: string;
  onDecision: (decision: PermissionDecision) => void;
}

export function PermissionRequestModal({ request, permissionMode, onDecision }: Props) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() =>
    JSON.stringify(request.input, null, 2),
  );
  const [parsedEdit, setParsedEdit] = useState<Record<string, unknown> | null>(
    () => request.input,
  );

  // bypassPermissions: auto-allow on mount (pm-12).
  useEffect(() => {
    if (permissionMode === "bypassPermissions") {
      onDecision({ kind: "allow" });
    }
  }, [permissionMode, onDecision]);

  // Re-parse edit text on change; track validity for the confirm button.
  useEffect(() => {
    try {
      const v = JSON.parse(editText);
      if (v !== null && typeof v === "object") {
        setParsedEdit(v as Record<string, unknown>);
      } else {
        setParsedEdit(null);
      }
    } catch {
      setParsedEdit(null);
    }
  }, [editText]);

  const allowRule = useMemo(
    () => buildApproveAllAllowRule(request.toolName, request.input),
    [request.toolName, request.input],
  );

  if (permissionMode === "bypassPermissions") return null;

  return (
    <div className="perm-modal" role="dialog" aria-label="Permission request">
      <div className="perm-modal-header">
        <span className="perm-modal-glyph" aria-hidden="true">▸</span>
        <span>HERMES IS REQUESTING PERMISSION TO RUN A TOOL</span>
      </div>

      <dl className="perm-modal-body">
        <div className="perm-row">
          <dt>Tool</dt>
          <dd>{request.toolName}</dd>
        </div>
        {Object.entries(request.input).map(([key, value]) => (
          <div key={key} className="perm-row">
            <dt>{key}</dt>
            <dd>
              <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
            </dd>
          </div>
        ))}
      </dl>

      {editing && (
        <div className="perm-modal-edit">
          <textarea
            className="perm-edit-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={8}
            spellCheck={false}
          />
          {parsedEdit === null && (
            <div className="perm-edit-error">invalid JSON — fix to enable confirm</div>
          )}
        </div>
      )}

      <div className="perm-modal-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="perm-link"
              onClick={() => {
                setEditing(false);
                setEditText(JSON.stringify(request.input, null, 2));
              }}
            >
              cancel edit
            </button>
            <button
              type="button"
              className="perm-link perm-link-primary"
              disabled={parsedEdit === null}
              onClick={() => {
                if (parsedEdit) {
                  onDecision({ kind: "allow", updatedInput: parsedEdit });
                }
              }}
            >
              confirm edit
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="perm-link"
              onClick={() => onDecision({ kind: "allow" })}
            >
              approve once
            </button>
            <span className="perm-sep">·</span>
            <button
              type="button"
              className="perm-link"
              title={`Adds  permissions.allow: ['${allowRule}']  to ~/.claude/settings.json`}
              onClick={() => onDecision({ kind: "allow", persist: allowRule })}
            >
              approve all ({request.toolName})
            </button>
            <span className="perm-sep">·</span>
            <button
              type="button"
              className="perm-link perm-link-deny"
              onClick={() => onDecision({ kind: "deny" })}
            >
              deny
            </button>
            <span className="perm-sep">·</span>
            <button
              type="button"
              className="perm-link"
              onClick={() => setEditing(true)}
            >
              edit input
            </button>
          </>
        )}
      </div>
    </div>
  );
}
