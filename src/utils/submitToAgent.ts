/**
 * Submit a composer draft + image attachments to an Agent-mode session.
 *
 * Replaces the old `submitToPty` bracketed-paste hack: we now talk to the
 * `claude --print --input-format stream-json` subprocess directly through
 * `sendAgentInput`, which writes one NDJSON `user` envelope to its stdin.
 *
 * Wire format mirrors what Claude's stream-json input expects:
 *   { type: "user", message: { role: "user", content: [...blocks] } }
 *
 * Where each block is either a `text` block or a base64 `image` block.
 *
 * Behaviour:
 * - If both `draft` and `attachments` are empty/whitespace, returns without
 *   touching the subprocess.
 * - Images are appended BEFORE the text block so Claude renders them above
 *   the prompt text in its turn header — matches the user's mental model
 *   from the old paste-then-type flow.
 * - Caller is responsible for clearing the draft / attachment state after
 *   a successful resolve.
 */

import { emit } from "@tauri-apps/api/event";
import { sendAgentInput } from "../api/agent";

/** A single attachment ready to be embedded in a `user` message. */
export interface AgentAttachment {
  kind: "image";
  /** MIME type, e.g. `image/png`. */
  mediaType: string;
  /** Raw base64 (no `data:` prefix). */
  base64: string;
}

/** Serialized content block as Claude's stream-json expects it. */
export type AgentInputBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

/**
 * Build the `content` array that goes into the `user` message.
 *
 * Pure helper — no IO — so the submit logic can be unit-tested without
 * mocking Tauri.  The shape matches the Anthropic `user` message schema
 * that Claude's `--input-format stream-json` accepts.
 */
export function buildUserContent(
  draft: string,
  attachments: AgentAttachment[],
): AgentInputBlock[] {
  const content: AgentInputBlock[] = [];
  for (const a of attachments) {
    if (a.kind === "image") {
      content.push({
        type: "image",
        source: { type: "base64", media_type: a.mediaType, data: a.base64 },
      });
    }
  }
  if (draft.trim().length > 0) {
    content.push({ type: "text", text: draft });
  }
  return content;
}

/** A built `user` envelope ready to be echoed and sent.  Exposing the type
 *  lets callers split echo + send across try/retry boundaries while reusing
 *  the same uuid (so a retry doesn't appear twice in the rendered stream). */
export interface UserEnvelope {
  type: "user";
  uuid: string;
  message: { role: "user"; content: AgentInputBlock[] };
}

/** Build the user envelope without firing any IPC.  Returns `null` when
 *  there is nothing to send (empty draft, no attachments). */
export function buildUserEnvelope(
  draft: string,
  attachments: AgentAttachment[],
): UserEnvelope | null {
  const content = buildUserContent(draft, attachments);
  if (content.length === 0) return null;
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    message: { role: "user", content },
  };
}

/** Echo the user envelope onto `agent-event-{sessionId}` so the reducer
 *  appends it to the rendered conversation.  Claude's stream-json output
 *  never echoes user messages back — this synthetic event is what makes the
 *  conversation render both sides. */
export function echoUserEnvelope(sessionId: string, envelope: UserEnvelope): Promise<void> {
  return emit(`agent-event-${sessionId}`, envelope);
}

/** Forward the user envelope to Claude's stdin.  Caller is responsible for
 *  catching errors and (optionally) respawning the subprocess. */
export function sendUserEnvelope(sessionId: string, envelope: UserEnvelope): Promise<void> {
  return sendAgentInput(sessionId, envelope);
}

/**
 * Convenience wrapper: build, echo, then send.  Used by the simple call
 * sites and by the legacy unit tests; SessionContext.submitAgentMessage
 * uses the three primitives separately so retries don't double-echo.
 *
 * No-ops when there's nothing to send.
 */
export async function submitToAgent(
  sessionId: string,
  draft: string,
  attachments: AgentAttachment[],
): Promise<void> {
  const envelope = buildUserEnvelope(draft, attachments);
  if (!envelope) return;
  await echoUserEnvelope(sessionId, envelope);
  await sendUserEnvelope(sessionId, envelope);
}
