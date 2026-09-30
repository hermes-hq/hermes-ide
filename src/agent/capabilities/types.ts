// ─── Agent capabilities: the launch contract (2.0) ─────────────────────
//
// What each installed agent lets a person choose at launch (account, model,
// effort, approval mode), the LaunchChoice the launcher builds from it, the
// usual combination per repository and the saved presets. The backend
// (src-tauri/src/agent_caps/) owns discovery, validation and storage; this
// module is the typed client the launcher, the session banner and
// Settings > Agents use. The field names are the wire format (camelCase on
// both sides). Additions only: never rename or remove a field.

/** One account an agent can run as. `id` "default" is the CLI's own default profile. */
export interface AgentAccount {
	id: string;
	/** "Work", "Personal", "ChatGPT account", "Default profile"… */
	label: string;
	/** A short fact about the account, e.g. "Max plan" or "ChatGPT account". Never an e-mail. */
	detail: string;
	/** The environment variable that selects this account's profile, e.g. CLAUDE_CONFIG_DIR=~/.claude-work. */
	profileEnv?: { name: string; value: string };
	signedIn: boolean;
	/** "unknown" when the agent has no read-only way to tell (signedIn is then true: Hermes does not block). */
	signInState?: "signed-in" | "signed-out" | "unknown";
}

/** One model the launcher offers. The first one is always {id:"default"}. */
export interface ModelOption {
	/** The value passed to the model flag; "default" omits the flag. */
	id: string;
	label: string;
	note?: string;
	/** Effort levels this model accepts, in the agent's order. [] = no effort control. */
	efforts: string[];
	available: boolean;
	unavailableReason?: string;
	/** Why, as a code: "refused" (the account refused it at a launch). */
	unavailableCode?: "refused";
}

export interface ApprovalModeOption {
	/** A Hermes permission mode id (default, acceptEdits, plan, auto, dontAsk, bypassPermissions). */
	id: string;
	label: string;
	/** The arguments the agent is started with for it ([] = none). */
	flag: string[];
	note: string;
	danger: boolean;
}

export interface AgentCapabilities {
	agentId: string;
	cliVersion: string | null;
	installed: boolean;
	/** True only for agents proven with a real CLI in this release (claude, codex, agy). */
	verifiedOnRealInstall: boolean;
	accounts: AgentAccount[];
	activeAccountId: string | null;
	/** The agent has a profile mechanism, so "Add account" is offered. */
	canAddAccount: boolean;
	/** Always starts with {id:"default"}. */
	models: ModelOption[];
	/** Where the list came from: the CLI's own list, the catalog's aliases, or nothing (type a name). */
	modelSource: "cli-list" | "aliases" | "free-text";
	approvalModes: ApprovalModeOption[];
	/** "exact": the agent reports its own status; "guessed": Hermes reads the screen. */
	statusSource: "exact" | "guessed";
	// ─── additive (CAP) ─────────────────────────────────────────────
	/** The agent's name from the catalog. */
	agentName?: string;
	/** Effort levels in the agent's own order (the union of every model's). [] = no effort control at launch. */
	effortValues?: string[];
	/** Who checks an effort value: the CLI before it runs, the vendor's server after a request, or nobody. */
	effortValidatedBy?: "cli" | "server" | "none";
	/** A model name may be typed that is not in the list (aliases / free-text agents). */
	acceptsTypedModel?: boolean;
	/** Why accounts show no sign-in state or cannot be added ("One account per Mac user…"). */
	accountNote?: string;
	/** The approval mode that maps Hermes's safety default for this agent (a stored mode it lacks falls back to it). */
	defaultApprovalModeId?: string;
	/** Epoch ms when the probes ran (the result is cached per CLI version and account). */
	checkedAt?: number;
}

export type LaunchWhere =
	/** `branch` "" in a stored/usual choice: derive it from the task. */
	| { kind: "new-worktree"; baseBranch: string; branch: string }
	| { kind: "existing-branch"; branch: string }
	| { kind: "current-checkout" };

export interface LaunchChoice {
	agentId: string;
	accountId: string;
	approvalModeId: string;
	/** "default" = omit the model flag. */
	modelId: string;
	effort: string | null;
	extraArgs: string;
	prefix: string;
	channels: string[];
	where: LaunchWhere;
	trackAsFeature: boolean;
	/** "Also on": the same task on a second agent, on its own branch. */
	alsoOn?: LaunchChoice;
}

export type LaunchField = "model" | "effort" | "account" | "approval";

export type LaunchValidation = { ok: true } | { ok: false; field: LaunchField; message: string };

/**
 * One part of a stored choice (usual combination, preset, remembered
 * choice) that is not available any more, and what replaced it.
 */
export interface ChoiceIssue {
	field: LaunchField | "agent";
	/** Plain sentence for people: "gpt-5.5 is not available on this account". */
	message: string;
	/** What was stored. */
	was: string | null;
	/** What the choice uses now (null: nothing could replace it). */
	now: string | null;
	/** What happened, for the UI key agentsSettings.issue.<code> (with `params`). */
	code: ChoiceIssueCode;
	params: Record<string, string>;
	/** About the choice's "Also on" agent. */
	alsoOn?: boolean;
}

export type ChoiceIssueCode =
	| "agentMissing"
	| "accountGone"
	| "accountGoneUsing"
	| "accountSignedOut"
	| "accountSignedOutUsing"
	| "modelRefused"
	| "modelGone"
	| "modelUnavailable"
	| "effortNone"
	| "effortChanged"
	| "approvalGone";

/** A stored choice checked against the current capabilities. */
export interface CheckedChoice {
	/** The stored choice with every unavailable part replaced by the contract rules. */
	choice: LaunchChoice;
	issues: ChoiceIssue[];
	/** False when something could not be replaced (e.g. the agent is not installed). Never launch it then. */
	launchable: boolean;
}

/** get_usual_launch_choice: where the choice came from. */
export type UsualSource = "repo" | "global" | "catalog";

export interface UsualLaunchChoice extends CheckedChoice {
	source: UsualSource;
	/** How often this combination was launched (0 for catalog defaults). */
	count: number;
	lastUsedAt: number | null;
}

export interface LaunchPreset {
	id: string;
	name: string;
	choice: LaunchChoice;
}

/** A preset as read back: checked like any stored choice. */
export interface CheckedPreset extends LaunchPreset {
	issues: ChoiceIssue[];
	launchable: boolean;
	/** The choice with unavailable parts replaced (launch this one). */
	effective: LaunchChoice;
}

/** remember_launch_choice: what the launcher may say afterwards. */
export interface RememberResult {
	/** Launches of this exact combination in this repository, this one included. */
	count: number;
	/** Offer "Save as preset?" once: 3+ identical launches, not a preset, never dismissed. */
	suggestPreset: boolean;
}

/** add_agent_account: the new account and how to sign it in. */
export interface AddedAccount {
	account: AgentAccount;
	/** The profile folder existed already (the person's own); nothing was created. */
	reused: boolean;
	/** The account is signed in already (a reused folder); no login terminal is needed. */
	signedIn: boolean;
}

/** SessionEvent addition: the CLI refused the launch within its first seconds. */
export interface LaunchRejection {
	reason: "model" | "effort" | "signed_out" | "other";
	vendorMessage: string;
	suggestion: "retry-default" | "switch-account" | "sign-in";
}

/** What a terminal session was launched with (the backend keeps it on the session). */
export interface SessionLaunchChoice {
	modelId: string | null;
	effort: string | null;
	accountId: string | null;
}

/** Options create_session takes for the model, effort and account (the rest of the choice maps to existing fields). */
export interface AgentLaunchOptions {
	modelId?: string | null;
	effort?: string | null;
	accountId?: string | null;
	/** "login": run the CLI's sign-in command in the account's profile instead of the agent. */
	purpose?: "agent" | "login";
}
