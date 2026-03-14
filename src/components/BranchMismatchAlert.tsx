import { useEffect } from "react";
import "../styles/components/BranchMismatchAlert.css";

export interface BranchMismatchAlertProps {
	branch: string;
	sessionLabel: string;
	onDismiss: () => void;
}

const AUTO_DISMISS_MS = 8000;

const WarnIcon = () => (
	<svg viewBox="0 0 24 24" width="16" height="16">
		<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
		<line x1="12" y1="9" x2="12" y2="13" />
		<line x1="12" y1="17" x2="12.01" y2="17" />
	</svg>
);

export function BranchMismatchAlert({ branch, sessionLabel, onDismiss }: BranchMismatchAlertProps) {
	useEffect(() => {
		const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
		return () => clearTimeout(timer);
	}, [onDismiss]);

	return (
		<div className="branch-mismatch-alert">
			<span className="branch-mismatch-icon">
				<WarnIcon />
			</span>
			<div className="branch-mismatch-body">
				<div className="branch-mismatch-title">
					You&apos;ve entered another session&apos;s worktree
				</div>
				<div className="branch-mismatch-detail">
					Branch <span className="branch-mismatch-branch">{branch}</span> belongs to session <strong>{sessionLabel}</strong>
				</div>
			</div>
			<button className="branch-mismatch-close" onClick={onDismiss}>&times;</button>
		</div>
	);
}
