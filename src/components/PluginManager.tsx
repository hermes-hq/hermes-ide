import "../styles/components/PluginManager.css";
import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PluginManifest, RegistryPlugin, ChangelogEntry } from "../plugins/types";
import { downloadAndInstallPlugin, type InstallPhase } from "../plugins/pluginInstaller";
import { hasUpdate, meetsMinVersion } from "../plugins/semver";
import { PluginLoader } from "../plugins/PluginLoader";
import type { PluginRuntime } from "../plugins/PluginRuntime";
import { PluginSettingsForm } from "./PluginSettingsForm";
import { REGISTRY_URL } from "../plugins/constants";

interface InstalledPluginInfo {
	id: string;
	dir_name: string;
	manifest_json: string;
}

interface PluginEntry {
	manifest: PluginManifest;
	dirName: string;
	enabled: boolean;
}

type StoreTab = "installed" | "browse";

declare const __APP_VERSION__: string;

const DEFAULT_ICON = `<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;

const SearchIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<circle cx="11" cy="11" r="8" />
		<line x1="21" y1="21" x2="16.65" y2="16.65" />
	</svg>
);

const PuzzleIcon = () => (
	<svg viewBox="0 0 24 24">
		<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.5 2.5 0 1 0-3.214 3.214c.446.166.855.497.925.968a.98.98 0 0 1-.276.837l-1.61 1.611a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.878-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.878L2.292 13.44A2.404 2.404 0 0 1 1.586 11.735c0-.617.236-1.234.706-1.704L3.903 8.42a.98.98 0 0 1 .837-.276c.47.07.802.48.968.925a2.5 2.5 0 1 0 3.214-3.214c-.446-.166-.855-.497-.925-.968a.98.98 0 0 1 .276-.837l1.611-1.611a2.404 2.404 0 0 1 1.704-.706c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.878.29.493-.075.84-.505 1.02-.969a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02z" />
	</svg>
);

const PackageIcon = () => (
	<svg viewBox="0 0 24 24">
		<path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
		<polyline points="3.27 6.96 12 12.01 20.73 6.96" />
		<line x1="12" y1="22.08" x2="12" y2="12" />
	</svg>
);

export function PluginManager({ runtime }: { runtime?: PluginRuntime }) {
	const [installed, setInstalled] = useState<PluginEntry[]>([]);
	const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
	const [pluginsDir, setPluginsDir] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [installingId, setInstallingId] = useState<string | null>(null);
	const [installPhase, setInstallPhase] = useState<InstallPhase | null>(null);
	const [togglingId, setTogglingId] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<StoreTab>("installed");
	const [search, setSearch] = useState("");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

	const loadPlugins = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [plugins, dir, disabledIds] = await Promise.all([
				invoke<InstalledPluginInfo[]>("list_installed_plugins"),
				invoke<string>("get_plugins_dir"),
				invoke<string[]>("get_disabled_plugin_ids").catch(() => [] as string[]),
			]);

			setPluginsDir(dir);
			const disabledSet = new Set(disabledIds);

			const entries: PluginEntry[] = [];
			for (const p of plugins) {
				try {
					const manifest = JSON.parse(p.manifest_json) as PluginManifest;
					entries.push({ manifest, dirName: p.dir_name, enabled: !disabledSet.has(manifest.id) });
				} catch (err) {
					console.warn(`[PluginManager] Invalid manifest for plugin "${p.dir_name}":`, err);
				}
			}
			setInstalled(entries);
		} catch (err) {
			setError(String(err));
		}
		setLoading(false);
	}, []);

	const loadRegistry = useCallback(async () => {
		try {
			const json = await invoke<string>("fetch_plugin_registry", { url: REGISTRY_URL });
			const data = JSON.parse(json);
			setRegistry(data.plugins ?? []);
		} catch {
			// Registry unavailable — not critical
		}
	}, []);

	useEffect(() => {
		loadPlugins();
		loadRegistry();
	}, [loadPlugins, loadRegistry]);

	const handleUninstall = useCallback(async (pluginId: string, dirName: string, pluginName: string) => {
		if (!confirm(`Uninstall "${pluginName}"? This will remove the plugin files.`)) return;
		try {
			await invoke("uninstall_plugin", { pluginDir: dirName });
		} catch (err) {
			setError(`Failed to uninstall: ${err}`);
			return;
		}
		try {
			if (runtime) {
				await runtime.unregister(pluginId);
			}
		} catch {
			// Runtime cleanup is best-effort
		}
		// Clean up database records (plugin settings, enabled state)
		try {
			await invoke("cleanup_plugin_data", { pluginId });
		} catch {
			// DB cleanup is best-effort
		}
		setExpandedId(null);
		await loadPlugins();
	}, [loadPlugins, runtime]);

	const hotLoadPlugin = useCallback(async () => {
		if (!runtime) return;
		const loader = new PluginLoader(runtime);
		await loader.loadAllPlugins();
		await runtime.activateStartupPlugins();
	}, [runtime]);

	const handleInstall = useCallback(async (plugin: RegistryPlugin) => {
		setInstallingId(plugin.id);
		setInstallPhase(null);
		setError(null);
		try {
			await downloadAndInstallPlugin(plugin.downloadUrl, (phase) => setInstallPhase(phase));
			await loadPlugins();
			await hotLoadPlugin();
		} catch (err) {
			setError(`Failed to install "${plugin.name}": ${err}`);
		}
		setInstallingId(null);
		setInstallPhase(null);
	}, [loadPlugins, hotLoadPlugin]);

	const handleUpdate = useCallback(async (plugin: RegistryPlugin) => {
		setInstallingId(plugin.id);
		setInstallPhase(null);
		setError(null);
		try {
			await downloadAndInstallPlugin(plugin.downloadUrl, (phase) => setInstallPhase(phase));
			await loadPlugins();
			await hotLoadPlugin();
		} catch (err) {
			setError(`Failed to update "${plugin.name}": ${err}`);
		}
		setInstallingId(null);
		setInstallPhase(null);
	}, [loadPlugins, hotLoadPlugin]);

	const handleToggleEnabled = useCallback(async (pluginId: string, currentlyEnabled: boolean) => {
		setTogglingId(pluginId);
		try {
			// Activate/deactivate runtime first — if it fails, don't persist to DB
			if (runtime) {
				if (currentlyEnabled) {
					await runtime.deactivate(pluginId);
				} else {
					await runtime.activate(pluginId);
				}
			}
			await invoke("set_plugin_enabled", { pluginId, enabled: !currentlyEnabled });
			setInstalled(prev => prev.map(p =>
				p.manifest.id === pluginId ? { ...p, enabled: !currentlyEnabled } : p
			));
		} catch (err) {
			setError(`Failed to toggle plugin: ${err}`);
		}
		setTogglingId(null);
	}, [runtime]);

	// Derived data
	const installedIds = new Set(installed.map(p => p.manifest.id));
	const installedVersions = new Map(installed.map(p => [p.manifest.id, p.manifest.version]));

	const updatablePlugins: RegistryPlugin[] = [];
	const availablePlugins: RegistryPlugin[] = [];
	for (const rp of registry) {
		if (!installedIds.has(rp.id)) {
			availablePlugins.push(rp);
		} else {
			const currentVersion = installedVersions.get(rp.id);
			if (currentVersion && hasUpdate(currentVersion, rp.version)) {
				updatablePlugins.push(rp);
			}
		}
	}

	const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

	const registryMap = useMemo(() => {
		const m = new Map<string, RegistryPlugin>();
		for (const rp of registry) m.set(rp.id, rp);
		return m;
	}, [registry]);

	// Categories from browse plugins
	const categories = useMemo(() => {
		const cats = new Set<string>();
		for (const p of availablePlugins) {
			if (p.category) cats.add(p.category);
		}
		return Array.from(cats).sort();
	}, [availablePlugins]);

	// Search + category filtering
	const lowerSearch = search.toLowerCase().trim();

	const filteredInstalled = useMemo(() => {
		if (!lowerSearch) return installed;
		return installed.filter(p =>
			p.manifest.name.toLowerCase().includes(lowerSearch) ||
			p.manifest.description.toLowerCase().includes(lowerSearch) ||
			p.manifest.author.toLowerCase().includes(lowerSearch) ||
			p.manifest.id.toLowerCase().includes(lowerSearch)
		);
	}, [installed, lowerSearch]);

	const filteredAvailable = useMemo(() => {
		let list = availablePlugins;
		if (categoryFilter) {
			list = list.filter(p => p.category === categoryFilter);
		}
		if (lowerSearch) {
			list = list.filter(p =>
				p.name.toLowerCase().includes(lowerSearch) ||
				p.description.toLowerCase().includes(lowerSearch) ||
				p.author.toLowerCase().includes(lowerSearch) ||
				p.id.toLowerCase().includes(lowerSearch) ||
				(p.category ?? "").toLowerCase().includes(lowerSearch)
			);
		}
		return list;
	}, [availablePlugins, lowerSearch, categoryFilter]);

	const phaseLabel = (phase: InstallPhase | null) => {
		switch (phase) {
			case "downloading": return "Downloading...";
			case "extracting": return "Installing...";
			case "done": return "Done";
			default: return "Installing...";
		}
	};

	// Auto-switch to browse if no installed plugins and there are available ones
	useEffect(() => {
		if (!loading && installed.length === 0 && availablePlugins.length > 0) {
			setActiveTab("browse");
		}
	}, [loading, installed.length, availablePlugins.length]);

	// Collapse expanded row when switching tabs
	useEffect(() => {
		setExpandedId(null);
	}, [activeTab]);

	const toggleExpand = (id: string) => {
		setExpandedId(prev => prev === id ? null : id);
	};

	const renderIcon = (iconSvg: string | undefined) => (
		<div
			className="pm-row-icon"
			dangerouslySetInnerHTML={{ __html: iconSvg || DEFAULT_ICON }}
		/>
	);

	const renderInstalledRow = (p: PluginEntry) => {
		const update = updatablePlugins.find(u => u.id === p.manifest.id);
		const registryInfo = registryMap.get(p.manifest.id);
		const isToggling = togglingId === p.manifest.id;
		const isUpdating = installingId === p.manifest.id;
		const isExpanded = expandedId === p.manifest.id;

		return (
			<div key={p.manifest.id}>
				<div
					className={`pm-row${isExpanded ? " pm-row-expanded" : ""}${!p.enabled ? " pm-row-disabled" : ""}`}
					onClick={() => toggleExpand(p.manifest.id)}
				>
					{renderIcon(registryInfo?.icon)}
					<div className="pm-row-info">
						<span className="pm-row-name">{p.manifest.name}</span>
						<span className="pm-row-version">v{p.manifest.version}</span>
						<span className="pm-row-dot">&middot;</span>
						<span className="pm-row-author">{p.manifest.author}</span>
					</div>
					<div className="pm-row-badges">
						{!p.enabled && <span className="pm-badge pm-badge-disabled">off</span>}
						{update && <span className="pm-badge pm-badge-update">update</span>}
					</div>
					<div className="pm-row-action">
						<button
							className="pm-btn pm-btn-sm"
							onClick={(e) => { e.stopPropagation(); handleToggleEnabled(p.manifest.id, p.enabled); }}
							disabled={isToggling}
						>
							{p.enabled ? "Disable" : "Enable"}
						</button>
					</div>
				</div>
				{isExpanded && (
					<div className="pm-detail">
						<div className="pm-detail-desc">{p.manifest.description}</div>
						<div className="pm-detail-meta">
							<span className="pm-detail-tag"><strong>Author:</strong> {p.manifest.author}</span>
							{registryInfo?.category && (
								<span className="pm-detail-tag"><strong>Category:</strong> {registryInfo.category}</span>
							)}
							<span className="pm-detail-tag"><strong>ID:</strong> {p.manifest.id}</span>
						</div>
						{p.manifest.permissions && p.manifest.permissions.length > 0 && (
							<div className="pm-detail-perms">
								{p.manifest.permissions.map(perm => (
									<span key={perm} className="pm-detail-perm">{perm}</span>
								))}
							</div>
						)}
						{update && registryInfo?.changelog && registryInfo.changelog.length > 0 && (() => {
							const newEntries = registryInfo.changelog!.filter(
								(entry: ChangelogEntry) => hasUpdate(p.manifest.version, entry.version)
							);
							if (newEntries.length === 0) return null;
							return (
								<div className="pm-changelog">
									<div className="pm-changelog-title">What's new in v{update.version}</div>
									{newEntries.map((entry: ChangelogEntry) => (
										<div key={entry.version} className="pm-changelog-entry">
											{newEntries.length > 1 && (
												<div className="pm-changelog-version">v{entry.version} &middot; {entry.date}</div>
											)}
											<ul className="pm-changelog-list">
												{entry.changes.map((change: string, i: number) => (
													<li key={i}>{change}</li>
												))}
											</ul>
										</div>
									))}
								</div>
							);
						})()}
						{p.manifest.contributes.settings && Object.keys(p.manifest.contributes.settings).length > 0 && (
							<PluginSettingsForm
								pluginId={p.manifest.id}
								schema={p.manifest.contributes.settings}
								runtime={runtime}
							/>
						)}
						<div className="pm-detail-actions">
							<button
								className="pm-btn"
								onClick={() => handleToggleEnabled(p.manifest.id, p.enabled)}
								disabled={isToggling}
							>
								{p.enabled ? "Disable" : "Enable"}
							</button>
							{update && !isUpdating && (
								<button className="pm-btn pm-btn-update" onClick={() => handleUpdate(update)}>
									Update to v{update.version}
								</button>
							)}
							{isUpdating && (
								<span className="pm-progress">
									<span className="pm-spinner" />
									{phaseLabel(installPhase)}
								</span>
							)}
							<button
								className="pm-btn pm-btn-danger"
								onClick={() => handleUninstall(p.manifest.id, p.dirName, p.manifest.name)}
							>
								Uninstall
							</button>
						</div>
					</div>
				)}
			</div>
		);
	};

	const renderAvailableRow = (p: RegistryPlugin) => {
		const isInstalling = installingId === p.id;
		const compatible = !p.minAppVersion || meetsMinVersion(appVersion, p.minAppVersion);
		const isExpanded = expandedId === p.id;

		return (
			<div key={p.id}>
				<div
					className={`pm-row${isExpanded ? " pm-row-expanded" : ""}`}
					onClick={() => toggleExpand(p.id)}
				>
					{renderIcon(p.icon)}
					<div className="pm-row-info">
						<span className="pm-row-name">{p.name}</span>
						<span className="pm-row-version">v{p.version}</span>
						<span className="pm-row-dot">&middot;</span>
						<span className="pm-row-author">{p.author}</span>
					</div>
					<div className="pm-row-badges">
						{!compatible && <span className="pm-badge pm-badge-incompatible">v{p.minAppVersion}+</span>}
					</div>
					<div className="pm-row-action">
						{isInstalling ? (
							<span className="pm-progress"><span className="pm-spinner" /></span>
						) : (
							<button
								className="pm-btn pm-btn-primary pm-btn-sm"
								onClick={(e) => { e.stopPropagation(); handleInstall(p); }}
								disabled={!compatible}
							>
								Install
							</button>
						)}
					</div>
				</div>
				{isExpanded && (
					<div className="pm-detail">
						<div className="pm-detail-desc">{p.description}</div>
						<div className="pm-detail-meta">
							<span className="pm-detail-tag"><strong>Author:</strong> {p.author}</span>
							{p.category && (
								<span className="pm-detail-tag"><strong>Category:</strong> {p.category}</span>
							)}
							<span className="pm-detail-tag"><strong>ID:</strong> {p.id}</span>
						</div>
						{p.permissions && p.permissions.length > 0 && (
							<div className="pm-detail-perms">
								{p.permissions.map(perm => (
									<span key={perm} className="pm-detail-perm">{perm}</span>
								))}
							</div>
						)}
						{p.changelog && p.changelog.length > 0 && (
							<div className="pm-changelog">
								<div className="pm-changelog-title">Latest changes (v{p.changelog[0].version})</div>
								<ul className="pm-changelog-list">
									{p.changelog[0].changes.map((change: string, i: number) => (
										<li key={i}>{change}</li>
									))}
								</ul>
							</div>
						)}
						{!compatible && (
							<div className="pm-detail-tag" style={{ color: "var(--yellow)" }}>
								Requires app v{p.minAppVersion} or later
							</div>
						)}
						<div className="pm-detail-actions">
							{isInstalling ? (
								<span className="pm-progress">
									<span className="pm-spinner" />
									{phaseLabel(installPhase)}
								</span>
							) : (
								<button
									className="pm-btn pm-btn-primary"
									onClick={() => handleInstall(p)}
									disabled={!compatible}
								>
									Install
								</button>
							)}
						</div>
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="pm">
			{/* Search */}
			<div className="pm-search">
				<span className="pm-search-icon"><SearchIcon /></span>
				<input
					className="pm-search-input"
					placeholder="Search plugins..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>

			{/* Error */}
			{error && (
				<div className="pm-error">
					<span style={{ flex: 1 }}>{error}</span>
					<button className="pm-error-dismiss" onClick={() => setError(null)}>&times;</button>
				</div>
			)}

			{/* Tabs */}
			<div className="pm-tabs">
				<button
					className={`pm-tab${activeTab === "installed" ? " pm-tab-active" : ""}`}
					onClick={() => setActiveTab("installed")}
				>
					Installed
					{installed.length > 0 && (
						<span className="pm-tab-badge">{installed.length}</span>
					)}
					{updatablePlugins.length > 0 && (
						<span className="pm-tab-badge pm-tab-badge-update">{updatablePlugins.length}</span>
					)}
				</button>
				<button
					className={`pm-tab${activeTab === "browse" ? " pm-tab-active" : ""}`}
					onClick={() => setActiveTab("browse")}
				>
					Browse
					{availablePlugins.length > 0 && (
						<span className="pm-tab-badge">{availablePlugins.length}</span>
					)}
				</button>
			</div>

			{/* Category filter chips (browse tab only) */}
			{activeTab === "browse" && categories.length > 0 && (
				<div className="pm-categories">
					<button
						className={`pm-chip${categoryFilter === null ? " pm-chip-active" : ""}`}
						onClick={() => setCategoryFilter(null)}
					>
						All
					</button>
					{categories.map(cat => (
						<button
							key={cat}
							className={`pm-chip${categoryFilter === cat ? " pm-chip-active" : ""}`}
							onClick={() => setCategoryFilter(prev => prev === cat ? null : cat)}
						>
							{cat}
						</button>
					))}
				</div>
			)}

			{/* List */}
			<div className="pm-list">
				{loading ? (
					<div className="pm-empty">
						<span className="pm-progress"><span className="pm-spinner" />Loading plugins...</span>
					</div>
				) : activeTab === "installed" ? (
					filteredInstalled.length > 0 ? (
						filteredInstalled.map(renderInstalledRow)
					) : installed.length > 0 && lowerSearch ? (
						<div className="pm-empty">
							<span className="pm-empty-icon"><SearchIcon /></span>
							<span className="pm-empty-title">No matches</span>
							<span className="pm-empty-hint">
								No installed plugins match &ldquo;{search}&rdquo;
							</span>
						</div>
					) : (
						<div className="pm-empty">
							<span className="pm-empty-icon"><PackageIcon /></span>
							<span className="pm-empty-title">No plugins installed</span>
							<span className="pm-empty-hint">
								Browse the store to discover and install plugins.
							</span>
						</div>
					)
				) : (
					filteredAvailable.length > 0 ? (
						filteredAvailable.map(renderAvailableRow)
					) : availablePlugins.length > 0 && (lowerSearch || categoryFilter) ? (
						<div className="pm-empty">
							<span className="pm-empty-icon"><SearchIcon /></span>
							<span className="pm-empty-title">No matches</span>
							<span className="pm-empty-hint">
								No plugins match your filters. Try a different search or category.
							</span>
						</div>
					) : (
						<div className="pm-empty">
							<span className="pm-empty-icon"><PuzzleIcon /></span>
							<span className="pm-empty-title">No plugins available</span>
							<span className="pm-empty-hint">
								The plugin registry is empty or could not be reached.
							</span>
						</div>
					)
				)}
			</div>

			{/* Footer */}
			<div className="pm-footer">
				<span className="pm-footer-path">
					{pluginsDir || "Loading..."}
				</span>
			</div>
		</div>
	);
}
