import { useEffect, useState } from "react";

interface ThinkingIndicatorProps {
  /** Unix-ms when the activity started.  Drives the elapsed counter. */
  since: number | null;
  /** Variant used for the leading label — `awaiting` for "user submitted,
   *  Claude hasn't begun yet", `thinking` for "Claude is in flight". */
  variant: "awaiting" | "thinking" | "running";
  /** When `variant === "running"`, the tool name to surface. */
  toolName?: string;
}

/** Classic Braille-spinner frames — used by Cargo, npm, every well-loved
 *  CLI.  Cycles every 80ms.  10 frames so steps(10) timing is exact. */
const SPINNER_FRAMES = [
  "⠋", "⠙", "⠹", "⠸", "⠼",
  "⠴", "⠦", "⠧", "⠇", "⠏",
];

/** Wave bar — a brass `▆▇█▇▆` head sliding through a 13-char track of
 *  hairline dashes (`─`).  Each frame shifts the head one slot right.
 *  At 13 slots × 80ms = ~1s wave traversal — pleasingly slow, not
 *  twitchy.  The wave wraps cleanly. */
const WAVE_TRACK_LEN = 13;
const WAVE_HEAD = "▆▇█▇▆";
function waveFrame(frame: number): string {
  // Shift the wave head along a track of `─` dashes.  The head straddles
  // 5 chars; the track is 13 chars wide; we let the head slide all the way
  // off the right edge (track length + head length frames per cycle) so
  // it feels like a sweep, not a treadmill.
  const cycleLen = WAVE_TRACK_LEN + WAVE_HEAD.length;
  const offset = ((frame % cycleLen) + cycleLen) % cycleLen - WAVE_HEAD.length;
  let out = "";
  for (let i = 0; i < WAVE_TRACK_LEN; i++) {
    const headIdx = i - offset;
    if (headIdx >= 0 && headIdx < WAVE_HEAD.length) {
      out += WAVE_HEAD[headIdx];
    } else {
      out += "─"; // ─
    }
  }
  return out;
}

/**
 * Vintage-terminal thinking indicator.  Renders in the conversation
 * column while Claude is between the user's submit and the first
 * streaming token.  Three motions in one row:
 *
 *   ⠋  ─────▆▇█▇▆────  thinking · 4.2s
 *
 * - Braille spinner on the left (every 80ms).
 * - Brass wave sliding through a hairline track in the middle.
 * - Status word + elapsed seconds on the right.
 *
 * Respects `prefers-reduced-motion`: animation freezes to the first
 * frame and the elapsed counter still ticks.
 */
export function ThinkingIndicator({ since, variant, toolName }: ThinkingIndicatorProps) {
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (typeof matchMedia === "function"
      && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // No animation — just tick `now` once per second for the counter.
      const slow = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(slow);
    }
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 80);
    return () => clearInterval(id);
  }, []);

  const elapsed = since ? formatThinkingElapsed(now - since) : "";
  const label =
    variant === "awaiting"
      ? "awaiting Claude"
      : variant === "running"
        ? `running ${toolName ?? "tool"}`
        : "thinking";

  return (
    <div className="agent-thinking-indicator" data-variant={variant} role="status" aria-live="polite">
      <span className="agent-thinking-spinner" aria-hidden="true">
        {SPINNER_FRAMES[frame]}
      </span>
      <span className="agent-thinking-wave" aria-hidden="true">
        {waveFrame(frame)}
      </span>
      <span className="agent-thinking-label">{label}</span>
      {elapsed ? (
        <>
          <span className="agent-thinking-sep" aria-hidden="true">·</span>
          <span className="agent-thinking-elapsed">{elapsed}</span>
        </>
      ) : null}
    </div>
  );
}

/** Format thinking-elapsed: `4.2s` under 10s (one decimal for "alive"
 *  feel), `42s` between 10–59, `1m 12s` over a minute. */
function formatThinkingElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}
