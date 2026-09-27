import "../styles/components/ContainedErrorBoundary.css";
import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { translate } from "../i18n/registry";

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

/** Card text for each scope, looked up in the current interface language. */
const TEXT: Record<ContainmentScope, { title: string; titleNamed: string; hint: string; reload: string }> = {
	app: { title: "crash.app.title", titleNamed: "crash.app.title", hint: "crash.app.hint", reload: "crash.reload" },
	pane: { title: "crash.pane.title", titleNamed: "crash.pane.titleNamed", hint: "crash.pane.hint", reload: "crash.reloadPane" },
	block: { title: "crash.block.title", titleNamed: "crash.block.titleNamed", hint: "crash.block.hint", reload: "crash.reload" },
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
		const text = TEXT[scope];
		const title = scope !== "app" && label ? translate(text.titleNamed, { label }) : translate(text.title);
		return (
			<div
				className={`contained-error contained-error-${scope}`}
				role="alert"
				data-error-scope={scope}
			>
				<div className="contained-error-title">{title}</div>
				<div className="contained-error-hint">{translate(text.hint)}</div>
				{error.message ? <pre className="contained-error-message">{error.message}</pre> : null}
				<div className="contained-error-actions">
					<button type="button" className="contained-error-reload" onClick={this.reload}>
						{translate(text.reload)}
					</button>
					{actions}
				</div>
			</div>
		);
	}
}
