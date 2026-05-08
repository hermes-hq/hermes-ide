/**
 * Plan-mode banner — sits above the composer when the active session is
 * in `plan` permission mode.  Visual: §8.5.
 *
 * The banner is the user's promise that no file-mutating tools will run
 * autonomously — Claude will describe its plan and surface ExitPlanMode
 * before doing anything destructive.
 */
import "../styles/components/PlanModeBanner.css";

interface Props {
  permissionMode: string;
  /** Optional click handler — when provided, the banner becomes a
   *  button that opens the permission picker. */
  onClick?: () => void;
}

export function PlanModeBanner({ permissionMode, onClick }: Props) {
  if (permissionMode !== "plan") return null;
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className="plan-mode-banner"
      onClick={onClick}
    >
      <span className="plan-mode-tag">PLAN MODE</span>
      <span className="plan-mode-sep">·</span>
      <span className="plan-mode-text">
        no edits will execute. claude will describe its plan and ask before continuing.
      </span>
    </Tag>
  );
}
