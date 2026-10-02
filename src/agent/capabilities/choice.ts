// ─── LaunchChoice rules (pure) ─────────────────────────────────────────
//
// The same rules the backend applies when it reads a stored choice
// (src-tauri/src/agent_caps/choice.rs), for the launcher to apply while a
// person switches agent, account or model: an unavailable model falls back
// to "default", an effort the model does not take moves to the nearest one
// it does, a missing or signed-out account to the active one (offered, not
// launchable until the person takes it or signs in), an approval
// mode the agent lacks to its safety default. Tested against the same
// cases as the Rust side (src/agent/capabilities/__tests__).

import type { AgentCapabilities, ChoiceIssue, ChoiceIssueCode, CheckedChoice, LaunchChoice, AgentLaunchOptions, ModelOption } from "./types";

/** Every effort word any agent uses, weakest first. "Nearest" is measured on this scale. */
export const EFFORT_SCALE: readonly string[] = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export const DEFAULT_MODEL_ID = "default";

/**
 * The effort to use for a model that takes `allowed`: the stored one when
 * allowed, else the nearest on EFFORT_SCALE (a tie goes to the weaker one),
 * null when the model takes none or nothing was stored.
 */
export function nearestEffort(stored: string | null, allowed: readonly string[]): string | null {
	if (!stored || allowed.length === 0) return null;
	if (allowed.includes(stored)) return stored;
	const at = EFFORT_SCALE.indexOf(stored);
	if (at < 0) return allowed.includes("medium") ? "medium" : allowed[0];
	let best: string | null = null;
	let bestDistance = Infinity;
	for (const e of allowed) {
		const i = EFFORT_SCALE.indexOf(e);
		if (i < 0) continue;
		const d = Math.abs(i - at);
		if (d < bestDistance || (d === bestDistance && best !== null && i < EFFORT_SCALE.indexOf(best))) {
			best = e;
			bestDistance = d;
		}
	}
	return best ?? allowed[0];
}

/** The model entry for an id; a typed name on an agent that accepts one gets the default's efforts. */
export function findModel(caps: AgentCapabilities, modelId: string): ModelOption | null {
	const found = caps.models.find((m) => m.id === modelId);
	if (found) return found;
	if (caps.acceptsTypedModel && modelId.trim() && modelId !== DEFAULT_MODEL_ID) {
		const def = caps.models.find((m) => m.id === DEFAULT_MODEL_ID);
		return { id: modelId, label: modelId, efforts: def ? [...def.efforts] : [], available: true };
	}
	return null;
}

/**
 * A stored choice checked against current capabilities, with every part
 * that is not available any more replaced and flagged. `alsoOn` needs the
 * second agent's capabilities; without them it is kept as stored.
 */
export function reconcileChoice(
	choice: LaunchChoice,
	caps: AgentCapabilities,
	alsoOnCaps?: AgentCapabilities | null,
): CheckedChoice {
	const issues: ChoiceIssue[] = [];
	const out: LaunchChoice = { ...choice, channels: [...choice.channels], where: { ...choice.where } as LaunchChoice["where"] };
	let launchable = true;
	const name = caps.agentName ?? caps.agentId;

	if (!caps.installed) {
		issues.push({ field: "agent", message: `${name} is not installed`, was: choice.agentId, now: null, code: "agentMissing", params: { agent: name } });
		launchable = false;
	}

	// Account: known and signed in, else the active one.
	const account = caps.accounts.find((a) => a.id === choice.accountId);
	if (!account || !account.signedIn) {
		const active = caps.accounts.find((a) => a.id === caps.activeAccountId && a.signedIn) ?? caps.accounts.find((a) => a.signedIn) ?? null;
		const why = !account ? `The account "${choice.accountId}" is not set up for ${name} any more` : `${account.label} is signed out`;
		const code = `${account ? "accountSignedOut" : "accountGone"}${active ? "Using" : ""}` as ChoiceIssueCode;
		const params = { account: account?.label ?? choice.accountId, agent: name, using: active?.label ?? "" };
		issues.push({ field: "account", message: active ? `${why}; using ${active.label}` : why, was: choice.accountId, now: active?.id ?? null, code, params });
		if (active) out.accountId = active.id;
		// Offered, never taken on its own: the launch waits for a sign-in or an explicit choice.
		launchable = false;
	}

	// Model: listed and available, else default.
	let model = findModel(caps, choice.modelId);
	if (!model || !model.available) {
		const why = model?.unavailableReason ?? `${choice.modelId} is not offered by ${name} any more`;
		const code: ChoiceIssueCode = model?.unavailableCode === "refused" ? "modelRefused" : model?.unavailableReason ? "modelUnavailable" : "modelGone";
		issues.push({ field: "model", message: `${why}; using the default model`, was: choice.modelId, now: DEFAULT_MODEL_ID, code, params: { model: choice.modelId, agent: name, reason: why } });
		out.modelId = DEFAULT_MODEL_ID;
		model = caps.models.find((m) => m.id === DEFAULT_MODEL_ID) ?? { id: DEFAULT_MODEL_ID, label: "Default", efforts: [], available: true };
	}

	// Effort: one the model takes, else the nearest.
	const effort = nearestEffort(choice.effort, model.efforts);
	if (effort !== choice.effort) {
		const message =
			effort === null
				? `${model.label} has no effort levels; the effort is left to ${name}`
				: `${model.label} does not take effort ${choice.effort}; using ${effort}`;
		issues.push({
			field: "effort",
			message,
			was: choice.effort,
			now: effort,
			code: effort === null ? "effortNone" : "effortChanged",
			params: { model: model.label, agent: name, was: choice.effort ?? "", now: effort ?? "" },
		});
		out.effort = effort;
	}

	// Approval mode: one the agent has, else its safety default.
	if (caps.approvalModes.length > 0 && !caps.approvalModes.some((m) => m.id === choice.approvalModeId)) {
		const fallback = caps.approvalModes.find((m) => m.id === caps.defaultApprovalModeId) ?? caps.approvalModes[0];
		issues.push({
			field: "approval",
			message: `${name} has no "${choice.approvalModeId}" mode; using ${fallback.label}`,
			was: choice.approvalModeId,
			now: fallback.id,
			code: "approvalGone",
			params: { agent: name, mode: choice.approvalModeId, using: fallback.label },
		});
		out.approvalModeId = fallback.id;
	}

	if (choice.alsoOn && alsoOnCaps) {
		const inner = reconcileChoice(choice.alsoOn, alsoOnCaps, null);
		out.alsoOn = inner.choice;
		for (const i of inner.issues) issues.push({ ...i, message: `Also on: ${i.message}`, alsoOn: true });
		if (!inner.launchable) launchable = false;
	}
	return { choice: out, issues, launchable };
}

/**
 * The identity of a combination: two launches are "the same" when every
 * choice but the per-task branch name matches. Mirrors combo_key in Rust
 * (the stored history is keyed by the Rust one).
 */
export function comboKey(choice: LaunchChoice): string {
	const where =
		choice.where.kind === "new-worktree"
			? `new-worktree:${choice.where.baseBranch}`
			: choice.where.kind === "existing-branch"
				? `existing-branch:${choice.where.branch}`
				: "current-checkout";
	return JSON.stringify([
		choice.agentId,
		choice.accountId,
		choice.approvalModeId,
		choice.modelId,
		choice.effort ?? "",
		choice.extraArgs.trim(),
		choice.prefix.trim(),
		[...choice.channels].sort(),
		where,
		choice.trackAsFeature,
		choice.alsoOn ? comboKey(choice.alsoOn) : null,
	]);
}

/** The create_session options for a choice's model, effort and account. */
export function agentLaunchOptions(choice: Pick<LaunchChoice, "modelId" | "effort" | "accountId">): AgentLaunchOptions {
	return {
		modelId: choice.modelId && choice.modelId !== DEFAULT_MODEL_ID ? choice.modelId : null,
		effort: choice.effort ?? null,
		accountId: choice.accountId && choice.accountId !== "default" ? choice.accountId : null,
		purpose: "agent",
	};
}
