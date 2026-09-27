import "../styles/components/StartupProblemScreen.css";
import type { StartupProblem } from "../api/startupProblem";

interface StartupProblemScreenProps {
	problem: StartupProblem;
	onQuit: () => void;
}

/**
 * Shown instead of the workspace when Hermes could not open its data.
 * Nothing else starts in this state, so the data stays exactly as it was.
 */
export function StartupProblemScreen({ problem, onQuit }: StartupProblemScreenProps) {
	return (
		<main className="startup-problem" role="alertdialog" aria-labelledby="startup-problem-title" aria-describedby="startup-problem-message">
			<div className="startup-problem-card">
				<h1 id="startup-problem-title" className="startup-problem-title">
					{problem.title}
				</h1>
				<p id="startup-problem-message" className="startup-problem-message">
					{problem.message}
				</p>
				<p className="startup-problem-path">
					<span className="startup-problem-path-label">Data file</span>
					<code>{problem.dataPath}</code>
				</p>
				<div className="startup-problem-actions">
					<button type="button" className="startup-problem-quit" onClick={onQuit} autoFocus>
						Quit Hermes
					</button>
				</div>
			</div>
		</main>
	);
}
