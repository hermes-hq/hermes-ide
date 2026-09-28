// ─── Agent view provider: the optional structured view, same events ───
//
// F19. The optional Agent view already holds a precise picture of its
// agent (src/agent/agentSessionStore.ts): the protocol's init, results,
// pending approvals and exits. This maps that picture into the same
// SessionEvents every terminal session reports, with confidence exact, so
// the sidebar, the status strip and the inbox never read the view's own
// state. Pure: `observe(prev, next, at)` returns the events in between.

import type { SessionEvent } from "../contract/events";
import type { AgentStatusKind } from "../contract/status";
import type { AgentViewSnapshot } from "../agentSessionStore";
import { deriveActivity } from "../messageStore";
import { hasIdentity, sameIdentity, type IdentityFields, type SessionProvider } from "./types";

export const AGENT_VIEW_SOURCE = "agent-view";

/** Longest detail line kept (the inbox and the tooltip show one line). */
const DETAIL_MAX = 200;

export interface AgentViewObservation extends IdentityFields {
  readonly kind: AgentStatusKind;
  readonly detail: string;
  readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

/** "Bash: rm -rf build", "Edit: src/app.ts", or just the tool's name. */
export function approvalDetail(toolName: string, input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "url", "pattern", "description"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim() !== "") return oneLine(`${toolName}: ${v}`);
  }
  return oneLine(toolName);
}

export function agentViewObservationOf(snapshot: AgentViewSnapshot): AgentViewObservation {
  const { state } = snapshot;
  const init = state.initEvent;
  const identity: IdentityFields = {
    vendorSessionId: init?.session_id || null,
    model: init?.model || null,
    permissionMode: init?.permissionMode || null,
  };
  const obs = (kind: AgentStatusKind, detail = ""): AgentViewObservation => ({ ...identity, kind, detail, exit: null });

  if (snapshot.exit) {
    return { ...identity, kind: "exited", detail: "", exit: { code: snapshot.exit.code, signal: snapshot.exit.signal } };
  }
  if (snapshot.pendingPermRequest) {
    const req = snapshot.pendingPermRequest;
    return obs("needs_approval", approvalDetail(req.toolName, req.input ?? {}));
  }
  if (snapshot.protocolError) return obs("error", oneLine(snapshot.protocolError));
  if (deriveActivity(state).status !== "idle") return obs("working");
  const result = state.resultEvent;
  if (result) {
    if (result.is_error) {
      const why = typeof result.result === "string" && result.result.trim() ? result.result : (state.lastError ?? result.subtype);
      return obs("error", oneLine(String(why ?? "")));
    }
    return obs("done_unread");
  }
  if (state.initialized) return obs("idle");
  return obs("starting");
}

export const agentViewProvider: SessionProvider<AgentViewObservation> = {
  id: "agent-view",
  source: AGENT_VIEW_SOURCE,
  capabilities: { status: "exact", approvals: true, questions: false, turnBoundaries: false, identity: true },
  observe(prev, next, at) {
    const events: SessionEvent[] = [];
    const identity: IdentityFields = {
      vendorSessionId: next.vendorSessionId,
      model: next.model,
      permissionMode: next.permissionMode,
    };
    if (hasIdentity(identity) && !sameIdentity(prev, identity)) {
      events.push({ type: "identity", at, source: AGENT_VIEW_SOURCE, ...identity });
    }
    if (next.exit) {
      if (!prev?.exit) events.push({ type: "exit", at, source: AGENT_VIEW_SOURCE, code: next.exit.code, signal: next.exit.signal });
      return events;
    }
    if (!prev || prev.exit || prev.kind !== next.kind || prev.detail !== next.detail) {
      events.push({
        type: "status",
        at,
        source: AGENT_VIEW_SOURCE,
        status: { kind: next.kind, confidence: "exact", detail: next.detail },
      });
    }
    return events;
  },
};
