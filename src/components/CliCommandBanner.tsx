/**
 * Banner shown above the composer when the user picks a slash command
 * that's CLI-only (e.g. `/mcp`, `/agents`).  These commands require
 * an interactive `claude /<cmd>` PTY — they don't work over the
 * stream-json prompt channel, so silently sending them would no-op.
 *
 * Spec / inspiration: Conductor's "Run /mcp in the embedded terminal"
 * row above the chat composer.  Click `Open terminal` to mount the
 * embedded inline PTY (Phase 3 follow-up); click the X to cancel.
 */
import "../styles/components/CliCommandBanner.css";

interface Props {
  command: string;
  /** Mount the embedded terminal that will run `claude <command>`. */
  onOpenTerminal: () => void;
  /** Dismiss the banner without running anything. */
  onCancel: () => void;
}

export function CliCommandBanner({ command, onOpenTerminal, onCancel }: Props) {
  return (
    <div className="cli-banner" role="status" aria-live="polite">
      <span className="cli-banner-icon" aria-hidden="true">▣</span>
      <span className="cli-banner-text">
        Run <code className="cli-banner-code">{command}</code> in the embedded terminal
      </span>
      <button
        type="button"
        className="cli-banner-action"
        onClick={onOpenTerminal}
      >
        <span aria-hidden="true">›_</span>
        <span>Open terminal</span>
      </button>
      <button
        type="button"
        className="cli-banner-dismiss"
        onClick={onCancel}
        aria-label="Cancel"
        title="Cancel"
      >
        ✕
      </button>
    </div>
  );
}
