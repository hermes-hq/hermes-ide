// ─── Launch refused (2.0 launch contract) ──────────────────────────────
//
// Shown above a terminal session whose agent CLI refused the launch in its
// first seconds (a model the account cannot use, an effort it rejects, no
// sign-in). Hermes stopped the launch; this banner says so in plain words,
// quotes the CLI's own line and offers the next step. Nothing starts again
// until the person picks one.

import { useEffect, useMemo, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import "../styles/components/LaunchRejectedBanner.css";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { getAgentCapabilities, relaunchAgent } from "../agent/capabilities/api";
import { defaultConfigPath, rejectionView, type RejectionAction } from "../agent/capabilities/rejection";
import { nearestEffort } from "../agent/capabilities/choice";
import type { AgentCapabilities } from "../agent/capabilities/types";
import { getAgent } from "../catalog/agentCatalog";
import { useI18n } from "../i18n/I18nProvider";
import type { SessionData } from "../types/session";

/** Rejections the person dealt with (per session: the event's time), across re-mounts. */
const handled = new Map<string, number>();

export interface LaunchRejectedBannerProps {
	session: SessionData;
	/** Open the CLI's sign-in for an account in a new terminal (beside this one). */
	onSignIn: (agentId: string, accountId: string | null) => void;
}

export function LaunchRejectedBanner({ session, onSignIn }: LaunchRejectedBannerProps) {
	const { t } = useI18n();
	const { rejection } = useSessionEvents(session.id);
	const [caps, setCaps] = useState<AgentCapabilities | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [picking, setPicking] = useState(false);
	const [pickModel, setPickModel] = useState("default");
	const [pickEffort, setPickEffort] = useState<string>("");
	const [, force] = useState(0);
	const agentId = session.ai_provider ?? "";
	const visible = !!rejection && handled.get(session.id) !== rejection.at;

	// The accounts (for the title and "Use another account") come from the
	// agent's capabilities; the banner waits for them briefly so it does not
	// show a raw account id first.
	const [ready, setReady] = useState(false);
	const [home, setHome] = useState<string | null>(null);
	useEffect(() => {
		if (!visible || !agentId) return;
		let live = true;
		const giveUp = setTimeout(() => live && setReady(true), 2000);
		const capsRead = getAgentCapabilities(agentId, session.agent_launch?.accountId ?? null)
			.then((c) => live && setCaps(c))
			.catch(() => live && setCaps(null));
		const homeRead = homeDir()
			.then((h) => live && setHome(h))
			.catch(() => {});
		void Promise.all([capsRead, homeRead]).finally(() => live && setReady(true));
		return () => {
			live = false;
			clearTimeout(giveUp);
		};
	}, [visible, agentId, session.agent_launch?.accountId]);

	const agentName = getAgent(agentId)?.name ?? agentId;
	// Where the CLI keeps its own default model (Codex: ~/.codex/config.toml,
	// or $CODEX_HOME/config.toml when Hermes's environment sets it).
	const configPath = defaultConfigPath(getAgent(agentId)?.setup?.settings.global[0], caps?.defaultProfileDir, home);
	const view = useMemo(
		() => (rejection ? rejectionView(rejection, agentName, session.agent_launch, caps, t("launchRejected.defaultAccount"), configPath) : null),
		[rejection, agentName, session.agent_launch, caps, t, configPath],
	);
	if (!visible || !rejection || !view || !ready) return null;

	const done = () => {
		handled.set(session.id, rejection.at);
		setPicking(false);
		force((n) => n + 1);
	};
	const relaunch = async (opts: { modelId: string | null; effort: string | null; accountId?: string | null }) => {
		setBusy(true);
		setError(null);
		try {
			await relaunchAgent(session.id, { modelId: opts.modelId, effort: opts.effort, accountId: opts.accountId ?? undefined, purpose: "agent" });
			done();
		} catch (e) {
			setError(t("launchRejected.failed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setBusy(false);
		}
	};
	const launch = session.agent_launch ?? null;
	// Everything but the model that was just refused (the default one included).
	const models = (caps?.models ?? []).filter((m) => m.available && m.id !== (launch?.modelId ?? "default"));
	const run = (a: RejectionAction) => {
		switch (a.kind) {
			case "retry-default": {
				const def = caps?.models.find((m) => m.id === "default");
				void relaunch({ modelId: null, effort: rejection.reason === "effort" ? null : nearestEffort(launch?.effort ?? null, def?.efforts ?? []) });
				break;
			}
			case "use-account":
				void relaunch({ modelId: launch?.modelId ?? null, effort: launch?.effort ?? null, accountId: a.accountId });
				break;
			case "try-again":
				void relaunch({ modelId: launch?.modelId ?? null, effort: launch?.effort ?? null });
				break;
			case "sign-in":
				onSignIn(agentId, a.accountId);
				break;
			case "pick-model":
				setPickModel(models[0]?.id ?? "default");
				setPickEffort("");
				setPicking(true);
				break;
		}
	};
	const label = (a: RejectionAction): string => {
		switch (a.kind) {
			case "retry-default":
				return t("launchRejected.retryDefault");
			case "use-account":
				return t("launchRejected.useAccount", { account: a.label });
			case "sign-in":
				return t("launchRejected.signIn");
			case "try-again":
				return t("launchRejected.tryAgain");
			case "pick-model":
				return t("launchRejected.pickModel");
		}
	};
	const picked = models.find((m) => m.id === pickModel);
	const efforts = picked?.efforts ?? [];

	return (
		<div className="launch-rejected" role="alert" data-reason={rejection.reason} data-session-id={session.id}>
			<div className="launch-rejected-title">{t(view.titleKey, view.titleValues)}</div>
			<div className="launch-rejected-body">
				{t("launchRejected.said", { agent: agentName })}{" "}
				<span className="launch-rejected-vendor">{rejection.vendorMessage}</span> {t("launchRejected.stopped")}
			</div>
			<div className="launch-rejected-actions">
				{view.actions.map((a, i) => (
					<button
						key={`${a.kind}-${"accountId" in a ? a.accountId : i}`}
						type="button"
						className={`launch-rejected-action${i === 0 ? " primary" : ""}`}
						data-action={a.kind}
						data-account={"accountId" in a ? a.accountId ?? "" : undefined}
						disabled={busy}
						onClick={() => run(a)}
					>
						{label(a)}
					</button>
				))}
				<button type="button" className="launch-rejected-dismiss" aria-label={t("launchRejected.dismiss")} title={t("launchRejected.dismiss")} onClick={done}>
					×
				</button>
			</div>
			{picking && (
				<div className="launch-rejected-pick">
					<label>
						{t("launchRejected.modelLabel")}{" "}
						<select className="launch-rejected-model" value={pickModel} onChange={(e) => { setPickModel(e.target.value); setPickEffort(""); }}>
							{models.map((m) => (
								<option key={m.id} value={m.id}>
									{m.id === "default" ? t("launchRejected.defaultModel") : m.label === m.id ? m.id : `${m.label} (${m.id})`}
								</option>
							))}
						</select>
					</label>
					{efforts.length > 0 && (
						<label>
							{t("launchRejected.effortLabel")}{" "}
							<select className="launch-rejected-effort" value={pickEffort} onChange={(e) => setPickEffort(e.target.value)}>
								<option value="">{t("launchRejected.agentDefault")}</option>
								{efforts.map((e) => (
									<option key={e} value={e}>{e}</option>
								))}
							</select>
						</label>
					)}
					<button
						type="button"
						className="launch-rejected-start primary"
						disabled={busy || !picked}
						onClick={() => void relaunch({ modelId: pickModel === "default" ? null : pickModel, effort: pickEffort || null })}
					>
						{t("launchRejected.start")}
					</button>
				</div>
			)}
			{error && <div className="launch-rejected-error">{error}</div>}
		</div>
	);
}
