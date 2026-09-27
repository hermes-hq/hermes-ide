/**
 * Slash-command receipt selector.
 *
 * When the user submits a recognised slash command (`/compact`,
 * `/clear`, `/init`, `/review`), the Agent SDK bridge accepts it but
 * the assistant turn comes back empty —
 * the only text block contains the literal string `"(no content)"`
 * because the command's effect is internal (compaction, history
 * reset, side-effecting side-channels), not a conversational reply.
 *
 * Without intervention, the conversation timeline ends up looking
 * broken: `You: /compact` followed by `Hermes: (no content)`.  The
 * user has no idea whether the command worked.
 *
 * This module recognises that exact pattern and lets the timeline
 * render a small "✓ Compacted" / "✓ Cleared" card in place of the
 * empty assistant message.
 */
import type { ContentBlock } from "./types";
import { isTextBlock, isThinkingBlock, isToolUseBlock } from "./types";
import type { RenderedMessage } from "./messageStore";

/** Slash commands whose stream-json reply is conventionally empty.
 *  Curated narrowly on purpose — adding a verb here MUST be paired
 *  with confirming via the `--print` channel that the SDK really
 *  emits an empty reply (or `"(no content)"`) for it.  False
 *  positives suppress a real reply; false negatives just leave the
 *  "(no content)" rendering in place, which is the status quo. */
const RECEIPT_VERBS = new Set<ReceiptVerb>([
  "compact",
  "clear",
  "init",
  "review",
]);

export type ReceiptVerb = "compact" | "clear" | "init" | "review";

export interface SlashReceipt {
  /** The bare verb, lowercased, no leading slash. */
  command: ReceiptVerb;
  /** Human-readable confirmation label rendered in the card. */
  label: string;
  /** Brief explanation of what the command did, for the card body. */
  description: string;
}

/** Map of receipt verb → user-facing strings.  Centralised here so
 *  the rendering component can stay dumb. */
const RECEIPT_COPY: Record<ReceiptVerb, { label: string; description: string }> = {
  compact: {
    label: "Compacted conversation",
    description: "Older turns were summarised so the session can continue.",
  },
  clear: {
    label: "Cleared conversation",
    description: "History reset; the next turn starts from a clean slate.",
  },
  init: {
    label: "CLAUDE.md initialised",
    description: "Project memory file generated from the codebase.",
  },
  review: {
    label: "Review complete",
    description: "The diff was inspected; see the surrounding messages for findings.",
  },
};

/* Recognise the literal "(no content)" placeholder Claude emits when
 * a stream-json slash command succeeds with no spoken reply.  Match
 * is case-insensitive and tolerant of surrounding whitespace; we do
 * NOT want to mistake a real message ending in "(no content)" for
 * the placeholder, so it must be the entire trimmed text. */
const PLACEHOLDER_TEXT_PATTERN = /^\(no content\)$/i;

/** Return the bare receipt-verb if `text` is a single, recognised
 *  slash command and nothing else.  Returns null for prose, for
 *  non-receipt slash commands, and for receipt commands that carry
 *  additional arguments (we only suppress the reply when the user
 *  unambiguously asked for a side-effect-only invocation). */
export function isSlashReceiptCommand(text: string): ReceiptVerb | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // The whole trimmed string must be exactly `/<verb>` — no args.
  if (/\s/.test(trimmed)) return null;
  const verb = trimmed.slice(1).toLowerCase();
  return RECEIPT_VERBS.has(verb as ReceiptVerb)
    ? (verb as ReceiptVerb)
    : null;
}

/** True when the assistant message produced no real output — either
 *  zero blocks, blocks that are only whitespace, or the literal
 *  `"(no content)"` placeholder.  A turn with a tool_use or
 *  non-empty thinking block is NOT considered empty — the user
 *  cares about whatever side-effect that tool produced. */
export function isEmptyAssistantBlocks(blocks: ContentBlock[]): boolean {
  if (blocks.length === 0) return true;
  for (const b of blocks) {
    if (isToolUseBlock(b)) return false;
    if (isThinkingBlock(b) && b.thinking.trim().length > 0) return false;
    if (isTextBlock(b)) {
      const text = b.text.trim();
      if (text.length === 0) continue;
      if (PLACEHOLDER_TEXT_PATTERN.test(text)) continue;
      // Any other text content counts as a real reply.
      return false;
    }
    // Image, unknown — treat as content.
    return false;
  }
  return true;
}

/** Decide whether to render a slash-command receipt card in place
 *  of an empty assistant message.  Returns null when the regular
 *  message render should proceed.
 *
 *  Used for slash commands that DO emit an assistant turn with the
 *  literal `"(no content)"` placeholder (`/clear` is the observed
 *  case).  Commands that don't emit any assistant turn at all (e.g.
 *  `/compact`) are handled by `slashReceiptAfterUserMessage`. */
export function slashReceiptForMessage(
  current: RenderedMessage,
  previous: RenderedMessage | null,
): SlashReceipt | null {
  if (current.role !== "assistant") return null;
  if (!isEmptyAssistantBlocks(current.blocks)) return null;
  if (!previous || previous.role !== "user") return null;

  // Walk the previous user message's text blocks and treat the
  // concatenated text as the user's prompt.  In practice the
  // submitter sends a single text block, but we handle the general
  // shape so a future composer change doesn't silently regress this.
  const verb = userMessageReceiptVerb(previous);
  if (!verb) return null;
  return buildReceipt(verb);
}

/** Decide whether to synthesize a receipt card AFTER a user message
 *  whose slash command never got an assistant reply at all.  Returns
 *  null when no receipt should be injected.
 *
 *  This complements `slashReceiptForMessage`: that handles the case
 *  where Claude emits an empty `"(no content)"` assistant turn (the
 *  `/clear` path); this handles the case where Claude emits NO
 *  assistant turn at all and the next thing in the message list is
 *  either another user message or end-of-conversation (the `/compact`
 *  path).
 *
 *  CRITICAL: we MUST NOT fire when an assistant message follows —
 *  that path is owned by `slashReceiptForMessage` (when empty) or by
 *  the normal renderer (when there's real content).  Doubling up
 *  would render two cards / a card + an empty message. */
export function slashReceiptAfterUserMessage(
  message: RenderedMessage,
  next: RenderedMessage | null,
): SlashReceipt | null {
  if (message.role !== "user") return null;
  // If an assistant message follows, this isn't our path — either the
  // receipt-replace handler will swap that empty message out, or the
  // normal renderer will show a real reply.
  if (next && next.role === "assistant") return null;
  const verb = userMessageReceiptVerb(message);
  if (!verb) return null;
  return buildReceipt(verb);
}

/* ─── helpers ─────────────────────────────────────────────────────── */

function userMessageReceiptVerb(message: RenderedMessage): ReceiptVerb | null {
  if (message.role !== "user") return null;
  let promptText = "";
  for (const b of message.blocks) {
    if (isTextBlock(b)) promptText += b.text;
  }
  return isSlashReceiptCommand(promptText);
}

function buildReceipt(verb: ReceiptVerb): SlashReceipt {
  const copy = RECEIPT_COPY[verb];
  return { command: verb, label: copy.label, description: copy.description };
}
