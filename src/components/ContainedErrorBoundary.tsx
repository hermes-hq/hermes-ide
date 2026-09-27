import "../styles/components/ContainedErrorBoundary.css";
import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

/**
 * Where a crash is contained.
 *
 *   app   — the whole window (last line of defence; sits inside the
 *           session store so sessions survive a reload of the UI)
 *   pane  — one split pane (terminal or agent view)
 *   block — one message block inside the agent view
 */
export type ContainmentScope = "app" | "pane" | "block";

interface Props {
	scope: ContainmentScope;
	/** Names what broke in the card title, e.g. the session label. */
	label?: string;
	children: ReactNode;
	/** Runs when the user presses Reload, before the children remount. */
	onReload?: () => void;
	/** Extra buttons shown next to Reload (e.g. "Close pane"). */
	actions?: ReactNode;
}

interface State {
	error: Error | null;
	/** Bumped on every reload so the children remount from scratch. */
	generation: number;
}

const TITLES: Record<ContainmentScope, string> = {
	app: "Something went wrong",
	pane: "This pane stopped working",
	block: "This block could not be shown",
};

const HINTS: Record<ContainmentScope, string> = {
	app: "Your sessions are still running. Reload to bring the window back.",
	pane: "Other panes are not affected. Reload to try again.",
	block: "The rest of the conversation is not affected.",
};

/**
 * Error boundary that keeps a crash inside the part of the screen it
 * happened in and offers a Reload action that remounts just that part.
 */
export class ContainedErrorBoundary extends Component<Props, State> {
	state: State = { error: null, generation: 0 };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(
			`[ErrorBoundary:${this.props.scope}]${this.props.label ? ` ${this.props.label}:` : ""}`,
			error,
			info.componentStack,
		);
	}

	private reload = () => {
		this.props.onReload?.();
		this.setState((s) => ({ error: null, generation: s.generation + 1 }));
	};

	render() {
		const { scope, label, children, actions } = this.props;
		const { error, generation } = this.state;
		if (!error) {
			return <Fragment key={generation}>{children}</Fragment>;
		}
		const title = scope !== "app" && label ? `${TITLES[scope]}: ${label}` : TITLES[scope];
		return (
			<div
				className={`contained-error contained-error-${scope}`}
				role="alert"
				data-error-scope={scope}
			>
				<div className="contained-error-title">{title}</div>
				<div className="contained-error-hint">{HINTS[scope]}</div>
				{error.message ? <pre className="contained-error-message">{error.message}</pre> : null}
				<div className="contained-error-actions">
					<button type="button" className="contained-error-reload" onClick={this.reload}>
						{scope === "pane" ? "Reload pane" : "Reload"}
					</button>
					{actions}
				</div>
			</div>
		);
	}
}
