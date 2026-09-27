/**
 * Permission request modal.  Rendered when the bridge forwards a
 * canUseTool request as a `_hermes_perm_request` envelope.  The user's
 * decision (approve, approve-all, deny, edit) is sent back via the
 * caller's `onDecision` handler — which writes a `_hermes_perm_response`
 * to the bridge's stdin.
 *
 * Visual: docs/internal/v1-tui-parity-plan.md §8.4.
 *
 * The prompt never takes keyboard focus: it can appear while the user is
 * typing in the composer, and an Enter meant for their message must not
 * land on a focused approve button.
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
  /**
   * Whether an "Always allow" rule can be saved.  False when the session
   * has no project folder: the rule would have nowhere to go, so the
   * button is not offered rather than silently saving nothing.
   */
  canPersist?: boolean;
}

export function PermissionRequestModal({ request, permissionMode, onDecision, canPersist = true }: Props) {
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
              Cancel
            </button>
            <span className="perm-modal-actions-spacer" />
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
              Confirm edit
            </button>
          </>
        ) : (
          <>
            {/* Quieter actions on the left, primary CTA on the right.
             * Layout follows the standard dialog pattern: destructive
             * + secondary options sit at the leading edge, the
             * confirm action gets the trailing spotlight. */}
            <button
              type="button"
              className="perm-link perm-link-deny"
              onClick={() => onDecision({ kind: "deny" })}
            >
              Deny
            </button>
            <button
              type="button"
              className="perm-link"
              onClick={() => setEditing(true)}
            >
              Edit input
            </button>
            <span className="perm-modal-actions-spacer" />
            {canPersist && (
              <button
                type="button"
                className="perm-link"
                title={`Adds permissions.allow: ['${allowRule}'] to this project's .claude/settings.local.json`}
                onClick={() => onDecision({ kind: "allow", persist: allowRule })}
              >
                Always allow ({request.toolName})
              </button>
            )}
            <button
              type="button"
              className="perm-link perm-link-primary"
              onClick={() => onDecision({ kind: "allow" })}
            >
              Approve once
            </button>
          </>
        )}
      </div>
    </div>
  );
}
