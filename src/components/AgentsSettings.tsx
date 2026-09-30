// ─── Settings > Agents (2.0 launch contract) ───────────────────────────
//
// What is installed, which accounts are signed in, and what each agent
// lets a person choose at launch, checked from the installed CLIs (the
// backend runs their read-only probes and caches the answer per CLI
// version). Accounts can be added here: Hermes creates the new profile
// folder and opens a terminal running the CLI's own sign-in in it. The
// presets saved from the launcher are listed, renamed and deleted here.

import { useCallback, useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import "../styles/components/AgentsSettings.css";
import {
	addAgentAccount,
	deleteLaunchPreset,
	listAgentCapabilities,
	listLaunchPresets,
	removeAgentAccount,
	renameLaunchPreset,
} from "../agent/capabilities/api";
import type { AgentAccount, AgentCapabilities, CheckedPreset, ChoiceIssue, LaunchChoice } from "../agent/capabilities/types";
import { getAgent } from "../catalog/agentCatalog";
import { useI18n } from "../i18n/I18nProvider";

type T = (key: string, values?: Record<string, string | number>) => string;

/** A path under the home folder reads as ~/… */
export function tildePath(path: string, home: string | null): string {
	if (home && (path === home || path.startsWith(home + "/") || path.startsWith(home + "\\"))) return "~" + path.slice(home.length);
	return path;
}

export function modelsSummary(c: AgentCapabilities, t: T): string {
	const refused = c.models.filter((m) => !m.available).length;
	const extra = refused > 0 ? ` · ${t("agentsSettings.refused", { count: refused })}` : "";
	if (c.modelSource === "cli-list") return t("agentsSettings.modelsFromList", { agent: c.agentName ?? c.agentId, count: c.models.length - 1 }) + extra;
	if (c.modelSource === "free-text" || (c.models.length <= 1 && c.acceptsTypedModel)) return t("agentsSettings.modelsFreeText");
	return t("agentsSettings.models", { list: c.models.map((m) => m.id).join(", ") }) + extra;
}

export function effortSummary(c: AgentCapabilities, t: T): string {
	const values = c.effortValues ?? [];
	return values.length > 0 ? t("agentsSettings.effort", { levels: values.join(" · ") }) : t("agentsSettings.effortNone");
}

/**
 * An account's short fact in the person's language. The backend says it in
 * English from a closed set ("Max plan", "API key", "ChatGPT account"); a
 * product name ("Amazon Bedrock") stays as it is.
 */
export function accountDetailText(detail: string, t: T): string {
	const plan = /^(\S+) plan$/.exec(detail);
	if (plan) return t("agentsSettings.detail.plan", { plan: plan[1] });
	if (detail === "API key") return t("agentsSettings.detail.apiKey");
	const account = /^(Claude|ChatGPT|Google) account$/.exec(detail);
	if (account) return t("agentsSettings.detail.account", { vendor: account[1] });
	return detail;
}

/** A preset's issue in the person's language (the English message when the code is unknown). */
export function issueText(issue: ChoiceIssue, t: T): string {
	const key = `agentsSettings.issue.${issue.code}`;
	const text = issue.code ? t(key, issue.params ?? {}) : "";
	if (!text || text === key) return issue.message;
	return issue.alsoOn ? t("agentsSettings.issue.alsoOn", { issue: text }) : text;
}

function accountLine(a: AgentAccount, t: T, home: string | null): string {
	const parts = [a.label];
	if (a.detail && a.detail !== "not signed in" && a.detail !== "sign-in not checked") parts.push(accountDetailText(a.detail, t));
	parts.push(
		a.signInState === "signed-in" ? t("agentsSettings.signedIn") : a.signInState === "signed-out" ? t("agentsSettings.signedOut") : t("agentsSettings.signInUnknown"),
	);
	if (a.profileEnv) parts.push(t("agentsSettings.profile", { path: tildePath(a.profileEnv.value, home) }));
	return parts.join(" · ");
}

export function choiceSummary(c: LaunchChoice): string {
	const name = getAgent(c.agentId)?.name ?? c.agentId;
	const parts = [name];
	if (c.accountId && c.accountId !== "default") parts.push(c.accountId);
	parts.push(c.modelId);
	if (c.effort) parts.push(c.effort);
	parts.push(c.approvalModeId);
	return parts.join(" · ");
}

function AgentCard({
	caps,
	t,
	home,
	onAdded,
	onSignIn,
	onRemove,
}: {
	caps: AgentCapabilities;
	t: T;
	home: string | null;
	onAdded: () => void;
	onSignIn?: (agentId: string, accountId: string) => void;
	onRemove: (accountId: string) => void;
}) {
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const add = async () => {
		setBusy(true);
		setError(null);
		try {
			const added = await addAgentAccount(caps.agentId, name);
			setAdding(false);
			setName("");
			onAdded();
			if (!added.signedIn) onSignIn?.(caps.agentId, added.account.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const exact = caps.statusSource === "exact";
	return (
		<div className="agents-settings-card" data-agent-id={caps.agentId} data-verified={caps.verifiedOnRealInstall ? "true" : "false"}>
			<div className="agents-settings-col agents-settings-name">
				<span className="agents-settings-agent">{caps.agentName ?? caps.agentId}</span>
				<span className="agents-settings-muted">{caps.cliVersion ? t("agentsSettings.installed", { version: caps.cliVersion }) : t("agentsSettings.installedNoVersion")}</span>
				<span className={`agents-settings-verified ${caps.verifiedOnRealInstall ? "ok" : "no"}`}>
					{caps.verifiedOnRealInstall ? t("agentsSettings.verified") : t("agentsSettings.notVerified")}
				</span>
			</div>
			<div className="agents-settings-col">
				<span className="agents-settings-heading">{t("agentsSettings.accounts")}</span>
				{caps.accounts.map((a) => (
					<span key={a.id} className="agents-settings-account" data-account-id={a.id} data-signed-in={a.signInState}>
						{accountLine(a, t, home)}
						{a.signInState === "signed-out" && onSignIn && (
							<button type="button" className="agents-settings-link" onClick={() => onSignIn(caps.agentId, a.id)}>
								{t("agentsSettings.signIn")}
							</button>
						)}
						{a.id !== "default" && (
							<button type="button" className="agents-settings-link" onClick={() => onRemove(a.id)}>
								{t("agentsSettings.removeAccount")}
							</button>
						)}
					</span>
				))}
				{caps.canAddAccount ? (
					adding ? (
						<span className="agents-settings-add-form">
							<input
								className="agents-settings-add-name"
								value={name}
								placeholder={t("agentsSettings.accountName")}
								aria-label={t("agentsSettings.accountName")}
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && name.trim()) void add();
									if (e.key === "Escape") setAdding(false);
								}}
								autoFocus
							/>
							<button type="button" className="agents-settings-add-confirm" disabled={busy || !name.trim()} onClick={() => void add()}>
								{t("agentsSettings.addAccountConfirm")}
							</button>
							<button type="button" className="agents-settings-link" onClick={() => setAdding(false)}>
								{t("common.cancel")}
							</button>
						</span>
					) : (
						<button type="button" className="agents-settings-link agents-settings-add" onClick={() => setAdding(true)}>
							{t("agentsSettings.addAccount")}
						</button>
					)
				) : (
					caps.accountNote && <span className="agents-settings-muted agents-settings-account-note">{caps.accountNote}</span>
				)}
				{error && <span className="agents-settings-error">{error}</span>}
			</div>
			<div className="agents-settings-col">
				<span className="agents-settings-heading">{t("agentsSettings.atLaunch")}</span>
				<span className="agents-settings-models">{modelsSummary(caps, t)}</span>
				<span className="agents-settings-effort">{effortSummary(caps, t)}</span>
				<span className="agents-settings-approval">{t("agentsSettings.approval", { modes: caps.approvalModes.map((m) => m.label).join(" · ") })}</span>
			</div>
			<div className="agents-settings-col">
				<span className="agents-settings-heading">{t("agentsSettings.status")}</span>
				<span className={`agents-settings-status ${exact ? "ok" : "no"}`} data-status-source={caps.statusSource}>
					{exact ? t("agentsSettings.exact") : t("agentsSettings.guessed")}
				</span>
				<span className="agents-settings-muted">
					{exact ? t("agentsSettings.exactNote", { agent: caps.agentName ?? caps.agentId }) : t("agentsSettings.guessedNote", { agent: caps.agentName ?? caps.agentId })}
				</span>
			</div>
		</div>
	);
}

function PresetRow({ preset, t, onChanged }: { preset: CheckedPreset; t: T; onChanged: () => void }) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(preset.name);
	const [error, setError] = useState<string | null>(null);
	const save = async () => {
		try {
			await renameLaunchPreset(preset.id, name);
			setEditing(false);
			onChanged();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	return (
		<div className="agents-settings-preset" data-preset-id={preset.id} data-launchable={preset.launchable ? "true" : "false"}>
			{editing ? (
				<input
					className="agents-settings-preset-name-input"
					value={name}
					aria-label={t("agentsSettings.presetName")}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void save();
						if (e.key === "Escape") setEditing(false);
					}}
					autoFocus
				/>
			) : (
				<span className="agents-settings-preset-name">{preset.name}</span>
			)}
			<span className="agents-settings-muted agents-settings-preset-choice">{choiceSummary(preset.choice)}</span>
			{preset.issues.length > 0 && (
				<span className="agents-settings-preset-issues">{t("agentsSettings.presetIssues", { issues: preset.issues.map((i) => issueText(i, t)).join("; ") })}</span>
			)}
			<span className="agents-settings-preset-actions">
				{editing ? (
					<button type="button" className="agents-settings-link agents-settings-preset-save" onClick={() => void save()}>
						{t("agentsSettings.save")}
					</button>
				) : (
					<button type="button" className="agents-settings-link agents-settings-preset-rename" onClick={() => setEditing(true)}>
						{t("agentsSettings.rename")}
					</button>
				)}
				<button
					type="button"
					className="agents-settings-link agents-settings-preset-delete"
					onClick={() => {
						void deleteLaunchPreset(preset.id).then(onChanged, (e) => setError(String(e)));
					}}
				>
					{t("common.delete")}
				</button>
			</span>
			{error && <span className="agents-settings-error">{error}</span>}
		</div>
	);
}

export function AgentsSettings({ onSignInAccount }: { onSignInAccount?: (agentId: string, accountId: string) => void }) {
	const { t } = useI18n();
	const [agents, setAgents] = useState<AgentCapabilities[] | null>(null);
	const [presets, setPresets] = useState<CheckedPreset[]>([]);
	const [loading, setLoading] = useState(false);
	const [home, setHome] = useState<string | null>(null);
	useEffect(() => {
		homeDir().then((h) => setHome(h.replace(/[\\/]+$/, "")), () => setHome(null));
	}, []);
	const load = useCallback(async (refresh: boolean) => {
		setLoading(true);
		try {
			const [caps, list] = await Promise.all([listAgentCapabilities(refresh), listLaunchPresets().catch(() => [] as CheckedPreset[])]);
			setAgents(caps);
			setPresets(list);
		} catch (e) {
			console.warn("[AgentsSettings] could not read the agents:", e);
			setAgents([]);
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void load(false);
	}, [load]);
	const installed = (agents ?? []).filter((a) => a.installed);
	const missing = (agents ?? []).filter((a) => !a.installed);
	return (
		<div className="agents-settings" data-loading={loading ? "true" : "false"}>
			<div className="agents-settings-bar">
				<p className="settings-hint">{t("agentsSettings.intro")}</p>
				<button type="button" className="agents-settings-refresh" onClick={() => void load(true)} disabled={loading}>
					{t("agentsSettings.refresh")}
				</button>
			</div>
			{agents === null ? (
				<p className="agents-settings-muted">{t("agentsSettings.checking")}</p>
			) : (
				<>
					{installed.map((c) => (
						<AgentCard
							key={c.agentId}
							caps={c}
							t={t}
							home={home}
							onAdded={() => void load(true)}
							onSignIn={onSignInAccount}
							onRemove={(accountId) => {
								void removeAgentAccount(c.agentId, accountId).then(() => load(true));
							}}
						/>
					))}
					{missing.length > 0 && (
						<p className="agents-settings-muted agents-settings-missing">
							{t("agentsSettings.notInstalled", { agents: missing.map((m) => m.agentName ?? m.agentId).join(", ") })}
						</p>
					)}
				</>
			)}
			<h3 className="settings-section-title">{t("agentsSettings.presets")}</h3>
			{presets.length === 0 ? (
				<p className="agents-settings-muted agents-settings-presets-empty">{t("agentsSettings.presetsEmpty")}</p>
			) : (
				<div className="agents-settings-presets">
					{presets.map((p) => (
						<PresetRow key={p.id} preset={p} t={t} onChanged={() => void listLaunchPresets().then(setPresets)} />
					))}
				</div>
			)}
		</div>
	);
}
