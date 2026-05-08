import type { TextBlockData } from "../types";
import { MarkdownBody } from "./MarkdownBody";

interface TextBlockProps {
  block: TextBlockData;
  /**
   * When `true` this text block is the last text block of the
   * currently-streaming assistant message — render the heartbeat cursor
   * inline at the end of the rendered markdown (playbook §6).
   *
   * The cursor is a 1px vertical bar that blinks at ~57 BPM (1.06s `step-end`).
   * It disappears the instant streaming completes — no fade.
   */
  isStreamingTail?: boolean;
}

/**
 * Assistant text block — full GFM markdown via <MarkdownBody>.  Tables,
 * lists, headings, code fences (highlighted), inline code, links, mermaid
 * diagrams.  The heartbeat cursor is appended at the end of the markdown
 * region while streaming, so the user sees a live "currently writing" cue
 * regardless of which markdown leaf the stream-tail lands in.
 */
export function TextBlock({ block, isStreamingTail }: TextBlockProps) {
  return (
    <div className="agent-text-block">
      <MarkdownBody source={block.text} />
      {isStreamingTail ? (
        <span className="agent-cursor" aria-hidden="true" />
      ) : null}
    </div>
  );
}
