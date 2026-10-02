// ─── Settings > Agents (2.0 launch contract) ───────────────────────────
//
// What is installed, which accounts are signed in, and what each agent
// lets a person choose at launch, checked from the installed CLIs (the
// backend runs their read-only probes and caches the answer per CLI
// version). Accounts can be added here: Hermes creates the new profile
// folder and opens a terminal running the CLI's own sign-in in it. The
// presets saved from the launcher are listed, renamed and deleted here.

import { useCallback, useEffect, useRef, useState } from "react";
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
import { refreshDoctor } from "../launcher/doctorStore";
import { tildePath } from "../utils/paths";
import { isMac } from "../utils/platform";
import { Button } from "./ui";

type T = (key: string, values?: Record<string, string | number>) => string;

/** Who refused the models counted in the summary: the account the capabilities were read for. */
function refusedBy(c: AgentCapabilities, count: number, t: T): string {
	const id = c.activeAccountId ?? "default";
	if (id === "default") return t("agentsSettings.refusedByDefault", { count });
	const label = c.accounts.find((a) => a.id === id)?.label ?? id;
	return t("agentsSettings.refusedByAccount", { count, account: label });
}

export function modelsSummary(c: AgentCapabilities, t: T): string {
	const refused = c.models.filter((m) => !m.available).length;
	const extra = refused > 0 ? ` · ${refusedBy(c, refused, t)}` : "";
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
 * English from a closed set ("Max plan", "API key", "ChatGPT account",
 * "fails to start: <its first line>"); a product name ("Amazon Bedrock")
 * stays as it is.
 */
export function accountDetailText(detail: string, t: T): string {
	const plan = /^(\S+) plan$/.exec(detail);
	if (plan) return t("agentsSettings.detail.plan", { plan: plan[1] });
	if (detail === "API key") return t("agentsSettings.detail.apiKey");
	const account = /^(Claude|ChatGPT|Google) account$/.exec(detail);
	if (account) return t("agentsSettings.detail.account", { vendor: account[1] });
	const broken = /^fails to start: (.*)$/s.exec(detail);
	if (broken) return t("agentsSettings.detail.broken", { reason: broken[1] });
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
	if (!a.detail.startsWith("fails to start: ")) {
		parts.push(
			a.signInState === "signed-in" ? t("agentsSettings.signedIn") : a.signInState === "signed-out" ? t("agentsSettings.signedOut") : t("agentsSettings.signInUnknown"),
		);
	}
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

/**
 * The label an account name would duplicate (case and spaces ignored): an
 * account of this agent, or its own profile ("Default", "Default profile").
 * The backend refuses the same names; checking here says it in the
 * person's language before anything is created.
 */
export function takenAccountLabel(accounts: readonly AgentAccount[], name: string): string | null {
	const want = name.trim().toLowerCase();
	if (!want) return null;
	if (want === "default" || want === "default profile") return accounts.find((a) => a.id === "default")?.label ?? "Default profile";
	return accounts.find((a) => a.id !== "default" && a.label.trim().toLowerCase() === want)?.label ?? null;
}

/**
 * Remove an account: what stays on disk is said before anything happens.
 * A signed-in profile can be signed out with the agent's own sign-out.
 */
function RemoveConfirm({
	account,
	agentName,
	home,
	t,
	onCancel,
	onRemove,
}: {
	account: AgentAccount;
	agentName: string;
	home: string | null;
	t: T;
	onCancel: () => void;
	onRemove: (signOut: boolean) => Promise<void>;
}) {
	const [busy, setBusy] = useState<"remove" | "sign-out" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		cancelRef.current?.focus();
	}, []);
	const path = account.profileEnv ? tildePath(account.profileEnv.value, home) : "";
	const signedIn = account.signInState === "signed-in";
	const key = signedIn ? (isMac ? "agentsSettings.removeConfirmSignedInMac" : "agentsSettings.removeConfirmSignedIn") : isMac ? "agentsSettings.removeConfirmMac" : "agentsSettings.removeConfirm";
	const run = async (signOut: boolean) => {
		setBusy(signOut ? "sign-out" : "remove");
		setError(null);
		try {
			await onRemove(signOut);
		} catch (e) {
			setError(t("agentsSettings.removeFailed", { error: e instanceof Error ? e.message : String(e) }));
			setBusy(null);
		}
	};
	const titleId = `agents-settings-remove-${account.id}`;
	return (
		<span
			className="agents-settings-confirm"
			role="alertdialog"
			aria-labelledby={titleId}
			onKeyDown={(e) => {
				// Esc cancels the removal only (Settings stays open).
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					onCancel();
				}
			}}
		>
			<span id={titleId} className="agents-settings-confirm-text">
				{t(key, { label: account.label, path, agent: agentName })}
			</span>
			<span className="agents-settings-confirm-actions">
				<Button ref={cancelRef} size="sm" className="agents-settings-confirm-cancel" onClick={onCancel} disabled={busy !== null}>
					{t("common.cancel")}
				</Button>
				<Button size="sm" variant="danger" className="agents-settings-confirm-remove" loading={busy === "remove"} disabled={busy === "sign-out"} onClick={() => void run(false)}>
					{t("agentsSettings.removeConfirmRemove")}
				</Button>
				{signedIn && (
					<Button size="sm" variant="danger" className="agents-settings-confirm-sign-out" loading={busy === "sign-out"} disabled={busy === "remove"} onClick={() => void run(true)}>
						{t("agentsSettings.removeConfirmSignOut")}
					</Button>
				)}
			</span>
			{error && (
				<span className="agents-settings-error" role="alert">
					{error}
				</span>
			)}
		</span>
	);
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
	onRemove: (accountId: string, signOut: boolean) => Promise<void>;
}) {
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
	const removeButtons = useRef(new Map<string, HTMLButtonElement>());
	const addButton = useRef<HTMLButtonElement>(null);
	const agentName = caps.agentName ?? caps.agentId;
	const taken = takenAccountLabel(caps.accounts, name);
	const add = async () => {
		if (taken) {
			setError(t("agentsSettings.duplicateAccount", { agent: agentName, label: taken }));
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const added = await addAgentAccount(caps.agentId, name);
			setAdding(false);
			setName("");
			if (added.reused) {
				const path = added.account.profileEnv ? tildePath(added.account.profileEnv.value, home) : "";
				setNotice(added.signedIn ? t("agentsSettings.reusedSignedIn", { path }) : t("agentsSettings.reused", { path }));
			}
			onAdded();
			if (!added.signedIn) onSignIn?.(caps.agentId, added.account.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const cancelAdd = () => {
		setAdding(false);
		setName("");
		setError(null);
		requestAnimationFrame(() => addButton.current?.focus());
	};
	const exact = caps.statusSource === "exact";
	return (
		<div className="agents-settings-card" data-agent-id={caps.agentId} data-verified={caps.verifiedOnRealInstall ? "true" : "false"}>
			<div className="agents-settings-col agents-settings-name">
				<span className="agents-settings-agent">{agentName}</span>
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
							<Button variant="link" size="sm" className="agents-settings-link" onClick={() => onSignIn(caps.agentId, a.id)} aria-label={t("agentsSettings.signInTo", { account: a.label, agent: agentName })}>
								{t("agentsSettings.signIn")}
							</Button>
						)}
						{a.id !== "default" && removing !== a.id && (
							<Button
								ref={(el) => {
									if (el) removeButtons.current.set(a.id, el);
									else removeButtons.current.delete(a.id);
								}}
								variant="link"
								size="sm"
								className="agents-settings-link agents-settings-remove"
								onClick={() => setRemoving(a.id)}
								aria-label={t("agentsSettings.removeAccountNamed", { account: a.label, agent: agentName })}
							>
								{t("agentsSettings.removeAccount")}
							</Button>
						)}
						{removing === a.id && (
							<RemoveConfirm
								account={a}
								agentName={agentName}
								home={home}
								t={t}
								onCancel={() => {
									setRemoving(null);
									// The keyboard goes back to this account's Remove.
									requestAnimationFrame(() => removeButtons.current.get(a.id)?.focus());
								}}
								onRemove={async (signOut) => {
									await onRemove(a.id, signOut);
									setRemoving(null);
								}}
							/>
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
								aria-invalid={taken ? true : undefined}
								onChange={(e) => {
									setName(e.target.value);
									setError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										e.stopPropagation();
										if (name.trim()) void add();
									}
									if (e.key === "Escape") {
										// Cancels the new account only; Settings stays open.
										e.preventDefault();
										e.stopPropagation();
										cancelAdd();
									}
								}}
								autoFocus
							/>
							<Button size="sm" className="agents-settings-add-confirm" disabled={busy || !name.trim() || !!taken} loading={busy} onClick={() => void add()}>
								{t("agentsSettings.addAccountConfirm")}
							</Button>
							<Button variant="link" size="sm" className="agents-settings-link" onClick={cancelAdd}>
								{t("common.cancel")}
							</Button>
						</span>
					) : (
						<Button
							ref={addButton}
							variant="link"
							size="sm"
							className="agents-settings-link agents-settings-add"
							onClick={() => {
								setAdding(true);
								setNotice(null);
							}}
						>
							{t("agentsSettings.addAccount")}
						</Button>
					)
				) : (
					caps.accountNote && <span className="agents-settings-muted agents-settings-account-note">{caps.accountNote}</span>
				)}
				{(error || (adding && taken)) && (
					<span className="agents-settings-error agents-settings-add-error" role="alert">
						{error ?? t("agentsSettings.duplicateAccount", { agent: agentName, label: taken ?? "" })}
					</span>
				)}
				{notice && (
					<span className="agents-settings-notice" role="status">
						{notice}
					</span>
				)}
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
					{exact ? t("agentsSettings.exactNote", { agent: agentName }) : t("agentsSettings.guessedNote", { agent: agentName })}
				</span>
			</div>
		</div>
	);
}

function PresetRow({ preset, t, onChanged }: { preset: CheckedPreset; t: T; onChanged: () => void }) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(preset.name);
	const [error, setError] = useState<string | null>(null);
	const renameButton = useRef<HTMLButtonElement>(null);
	// The keyboard goes back to Rename once the edit ends (saved or not).
	const backToRename = () => requestAnimationFrame(() => renameButton.current?.focus());
	const save = async () => {
		try {
			await renameLaunchPreset(preset.id, name);
			setEditing(false);
			// The rename went through: an earlier refusal no longer applies.
			setError(null);
			onChanged();
			backToRename();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	const cancel = () => {
		setName(preset.name);
		setEditing(false);
		setError(null);
		backToRename();
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
						if (e.key === "Enter") {
							e.preventDefault();
							e.stopPropagation();
							void save();
						}
						if (e.key === "Escape") {
							// Cancels the rename only: Settings stays open.
							e.preventDefault();
							e.stopPropagation();
							cancel();
						}
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
					<Button variant="link" size="sm" className="agents-settings-link agents-settings-preset-save" onClick={() => void save()}>
						{t("agentsSettings.save")}
					</Button>
				) : (
					<Button
						ref={renameButton}
						variant="link"
						size="sm"
						className="agents-settings-link agents-settings-preset-rename"
						aria-label={t("agentsSettings.renamePreset", { name: preset.name })}
						onClick={() => {
							setName(preset.name);
							setError(null);
							setEditing(true);
						}}
					>
						{t("agentsSettings.rename")}
					</Button>
				)}
				<Button
					variant="link"
					size="sm"
					className="agents-settings-link agents-settings-preset-delete"
					aria-label={t("agentsSettings.deletePreset", { name: preset.name })}
					onClick={() => {
						void deleteLaunchPreset(preset.id).then(onChanged, (e) => setError(String(e)));
					}}
				>
					{t("common.delete")}
				</Button>
			</span>
			{error && (
				<span className="agents-settings-error" role="alert">
					{error}
				</span>
			)}
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
	// One "Check again" for the whole tab: the cards and the agent doctor below them.
	const checkAgain = () => {
		void load(true);
		void refreshDoctor();
	};
	const installed = (agents ?? []).filter((a) => a.installed);
	const missing = (agents ?? []).filter((a) => !a.installed);
	return (
		<div className="agents-settings" data-loading={loading ? "true" : "false"}>
			<div className="agents-settings-bar">
				<p className="settings-hint">{t("agentsSettings.intro")}</p>
				<Button size="sm" className="agents-settings-refresh" onClick={checkAgain} disabled={loading} title={t("agentsSettings.refreshHint")}>
					{t("agentsSettings.refresh")}
				</Button>
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
							// The backend dropped this agent's cached answer: it is probed again
							// without "Check again" (which also forgets refused models).
							onAdded={() => void load(false)}
							onSignIn={onSignInAccount}
							onRemove={async (accountId, signOut) => {
								await removeAgentAccount(c.agentId, accountId, signOut);
								await load(false);
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
