/**
 * canUseTool permission request envelopes — the seam between the bridge
 * (which holds the SDK's canUseTool callback) and the frontend (which
 * renders the approval modal).
 *
 * Spec: docs/internal/v1-tui-parity-plan.md §2 (M1c) + §7.5.
 *
 * Wire shape:
 *   bridge → frontend (stdout NDJSON):
 *     { type: "_hermes_perm_request", id, toolName, input }
 *   frontend → bridge (stdin NDJSON):
 *     { type: "_hermes_perm_response", id, decision: { behavior, ... } }
 */

export interface PermRequest {
  type: "_hermes_perm_request";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface PermResponse {
  type: "_hermes_perm_response";
  id: string;
  decision:
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string };
}

export type PermissionDecision =
  | { kind: "allow"; updatedInput?: Record<string, unknown>; persist?: string }
  | { kind: "deny"; message?: string };

export function isPermRequest(v: unknown): v is PermRequest {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.type === "_hermes_perm_request"
    && typeof o.id === "string"
    && typeof o.toolName === "string"
    && o.input !== null
    && typeof o.input === "object"
  );
}

export function buildPermResponse(id: string, decision: PermissionDecision): PermResponse {
  if (decision.kind === "allow") {
    return {
      type: "_hermes_perm_response",
      id,
      decision: decision.updatedInput
        ? { behavior: "allow", updatedInput: decision.updatedInput }
        : { behavior: "allow" },
    };
  }
  return {
    type: "_hermes_perm_response",
    id,
    decision: {
      behavior: "deny",
      message: decision.message && decision.message.trim() !== ""
        ? decision.message
        : "user declined",
    },
  };
}

/** Build a settings.json `permissions.allow` rule string from the
 *  request's tool name + input.  Same syntax the TUI emits, so the
 *  rule applies in both Hermes and standalone Claude Code. */
export function buildApproveAllAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    return `Bash(${input.command}:*)`;
  }
  if ((toolName === "Read" || toolName === "Edit" || toolName === "Write")
    && typeof input.file_path === "string") {
    return `${toolName}(${input.file_path})`;
  }
  return toolName;
}
