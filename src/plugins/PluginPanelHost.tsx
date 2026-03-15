import { Component, type ReactNode, type ErrorInfo } from "react";

interface PluginPanelHostProps {
	pluginId: string;
	panelId: string;
	panelName: string;
	children: ReactNode;
}

interface PluginPanelHostState {
	hasError: boolean;
	error: Error | null;
}

export class PluginPanelHost extends Component<PluginPanelHostProps, PluginPanelHostState> {
	state: PluginPanelHostState = { hasError: false, error: null };

	static getDerivedStateFromError(error: Error): PluginPanelHostState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(`[Plugin:${this.props.pluginId}] Panel "${this.props.panelId}" crashed:`, error, info.componentStack);
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className="plugin-panel-error" data-plugin-id={this.props.pluginId}>
					<div style={{ padding: "16px", color: "var(--text-2)", fontSize: "var(--text-sm)" }}>
						<div style={{ fontWeight: 600, marginBottom: 8 }}>
							Plugin Error: {this.props.panelName}
						</div>
						<div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--red)", marginBottom: 12, wordBreak: "break-word" }}>
							{this.state.error?.message}
						</div>
						<button
							onClick={() => this.setState({ hasError: false, error: null })}
							style={{
								background: "var(--bg-3)",
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-sm)",
								color: "var(--text-1)",
								padding: "4px 12px",
								cursor: "pointer",
								fontSize: "var(--text-xs)",
							}}
						>
							Retry
						</button>
					</div>
				</div>
			);
		}
		return (
			<div className="plugin-panel-container" data-plugin-id={this.props.pluginId} style={{ width: "100%", height: "100%", position: "relative" }}>
				{this.props.children}
			</div>
		);
	}
}
