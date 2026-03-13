import "../styles/components/PluginUpdateConfirmDialog.css";
import type { PluginUpdateInfo } from "../hooks/usePluginUpdateChecker";
import type { ChangelogEntry } from "../plugins/types";
import { hasUpdate } from "../plugins/semver";

interface PluginUpdateConfirmDialogProps {
	plugins: PluginUpdateInfo[];
	onConfirm: () => void;
	onCancel: () => void;
}

export function PluginUpdateConfirmDialog({ plugins, onConfirm, onCancel }: PluginUpdateConfirmDialogProps) {
	if (plugins.length === 0) return null;

	const single = plugins.length === 1;

	return (
		<div className="puc-backdrop" onClick={onCancel}>
			<div className="puc-dialog" onClick={(e) => e.stopPropagation()}>
				<div className="puc-header">
					<span className="puc-title">
						{single ? "Update Plugin" : "Update Plugins"}
					</span>
					<span className="puc-count">
						{single ? "1 plugin" : `${plugins.length} plugins`}
					</span>
				</div>
				<div className="puc-body">
					{plugins.map((plugin) => (
						<PluginCard key={plugin.id} plugin={plugin} />
					))}
				</div>
				<div className="puc-footer">
					<button className="puc-btn puc-btn-cancel" onClick={onCancel}>
						Cancel
					</button>
					<button className="puc-btn puc-btn-confirm" onClick={onConfirm}>
						{single ? "Update" : "Update All"}
					</button>
				</div>
			</div>
		</div>
	);
}

function PluginCard({ plugin }: { plugin: PluginUpdateInfo }) {
	const newEntries = plugin.changelog?.filter(
		(entry: ChangelogEntry) => hasUpdate(plugin.currentVersion, entry.version)
	) ?? [];

	return (
		<div className="puc-plugin">
			<div className="puc-plugin-header">
				{plugin.icon && (
					<div
						className="puc-plugin-icon"
						dangerouslySetInnerHTML={{ __html: plugin.icon }}
					/>
				)}
				<span className="puc-plugin-name">{plugin.name}</span>
				<span className="puc-plugin-versions">
					v{plugin.currentVersion}
					<span className="puc-arrow">&rarr;</span>
					<span className="puc-plugin-new-version">v{plugin.newVersion}</span>
				</span>
			</div>
			{newEntries.length > 0 ? (
				<div className="puc-changelog">
					{newEntries.map((entry) => (
						<div key={entry.version} className="puc-changelog-entry">
							{newEntries.length > 1 && (
								<div className="puc-changelog-version">
									v{entry.version} &middot; {entry.date}
								</div>
							)}
							<ul className="puc-changelog-list">
								{entry.changes.map((change, i) => (
									<li key={i}>{change}</li>
								))}
							</ul>
						</div>
					))}
				</div>
			) : (
				<div className="puc-no-changelog">No changelog available</div>
			)}
		</div>
	);
}
