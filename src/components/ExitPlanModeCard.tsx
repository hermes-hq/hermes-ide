/**
 * ExitPlanModeCard — plan submitted-for-approval card.
 *
 * Visual: docs/internal/v1-tui-parity-plan.md §8.3.
 *
 * Approve / Reject only (TUI parity, no Modify per locked decision §0.4).
 * Reject opens a feedback box; user can submit empty if they just want
 * Claude to rethink without explanation.
 */
import "../styles/components/ExitPlanModeCard.css";
import { useState } from "react";
import type { ExitPlanModeDecision, ExitPlanModeInput } from "../utils/exitPlanMode";
import { MarkdownBody } from "../agent/blocks/MarkdownBody";

interface Props {
  toolUseId: string;
  input: ExitPlanModeInput;
  /** Active permission mode — used to render the PLAN MODE banner above
   *  the card when the session is currently in plan mode. */
  permissionMode: string;
  onSubmit: (decision: ExitPlanModeDecision) => void;
}

export function ExitPlanModeCard({ toolUseId, input, permissionMode, onSubmit }: Props) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");

  const showPlanBanner = permissionMode === "plan";
  const planContent = input.plan?.trim() ?? "";

  return (
    <div className="ep-card" data-tool-use-id={toolUseId} role="dialog" aria-label="Plan submitted for approval">
      {showPlanBanner && <div className="ep-plan-banner">PLAN MODE — review and approve before claude executes</div>}

      <div className="ep-card-header">PLAN SUBMITTED FOR APPROVAL</div>

      <div className="ep-card-body">
        {planContent === "" ? (
          <p className="ep-card-empty">no plan provided by claude</p>
        ) : (
          <MarkdownBody source={planContent} />
        )}
      </div>

      {!rejecting && (
        <div className="ep-card-actions">
          <button
            type="button"
            className="ep-reject"
            onClick={() => setRejecting(true)}
          >
            ✗ reject
          </button>
          <button
            type="button"
            className="ep-approve"
            onClick={() => onSubmit({ accept: true })}
          >
            ✓ approve
          </button>
        </div>
      )}

      {rejecting && (
        <div className="ep-card-reject-form">
          <textarea
            className="ep-feedback"
            placeholder="why are you rejecting? (optional)"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            autoFocus
          />
          <div className="ep-card-actions">
            <button
              type="button"
              className="ep-reject"
              onClick={() => {
                setRejecting(false);
                setFeedback("");
              }}
            >
              cancel
            </button>
            <button
              type="button"
              className="ep-approve"
              onClick={() =>
                onSubmit(
                  feedback.trim() === ""
                    ? { accept: false }
                    : { accept: false, feedback: feedback.trim() },
                )
              }
            >
              confirm reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
