// ─── A refused launch: what the session says and offers (pure) ─────────
//
// The CLI refused the launch within its first seconds (the backend matched
// its words and stopped it; see src-tauri/src/agent_caps/watch.rs). The
// session shows the CLI's own line, says nothing ran, and offers what fits:
// the default model (always works: the flag is omitted), another signed-in
// account, sign in, or another model. Nothing is retried on its own.

import type { LaunchRejectedEvent } from "../contract/events";
import type { SessionAgentLaunch } from "../../types/session";
import type { AgentAccount, AgentCapabilities } from "./types";
import { basename, tildePath } from "../../utils/paths";

export type RejectionAction =
	| { kind: "retry-default" }
	| { kind: "use-account"; accountId: string; label: string }
	| { kind: "sign-in"; accountId: string | null }
	| { kind: "try-again" }
	| { kind: "pick-model" };

export interface RejectionView {
	/** i18n key of the title and its values. */
	titleKey: string;
	titleValues: Record<string, string>;
	actions: RejectionAction[];
}

/**
 * The model a refusal names (Codex: "The model `X` does not exist…", "The
 * 'X' model is not supported…"): what the CLI's own default resolved to
 * when the launch passed no model. Mirror of `refused_model_name` in
 * src-tauri/src/agent_caps/commands.rs.
 */
export function refusedModelName(message: string | null | undefined): string | null {
	if (!message) return null;
	const named = /[Tt]he model `([^`\s]+)`/.exec(message) ?? /[Tt]he ['"`]([^'"`\s]+)['"`] model\b/.exec(message);
	return named ? named[1] : null;
}

/**
 * Where the CLI's default profile keeps the config that names its default
 * model: the catalog's file ("~/.codex/config.toml"), or the same file in
 * the folder Hermes's environment points the profile at (`CODEX_HOME`),
 * shown under `home` as "~/…".
 */
export function defaultConfigPath(catalogPath: string | null | undefined, profileDir: string | null | undefined, home: string | null): string | null {
	if (!catalogPath) return null;
	const dir = profileDir?.replace(/[\\/]+$/, "");
	if (!dir) return catalogPath;
	const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
	return tildePath(`${dir}${sep}${basename(catalogPath)}`, home);
}

/** The account's name for the title: its label, or `defaultLabel` for the CLI's own profile. */
function accountLabel(caps: AgentCapabilities | null, accountId: string | null | undefined, defaultLabel: string): string {
	const id = accountId || "default";
	if (id === "default") return defaultLabel;
	return caps?.accounts.find((a) => a.id === id)?.label ?? id;
}

/**
 * The banner for a refusal. `launch`: what the session was started with;
 * `caps`: the agent's capabilities (other accounts), or null while loading.
 */
export function rejectionView(
	event: Pick<LaunchRejectedEvent, "reason" | "suggestion"> & { vendorMessage?: string },
	agentName: string,
	launch: SessionAgentLaunch | null | undefined,
	caps: AgentCapabilities | null,
	/** How the CLI's own profile is named in the title ("default"). */
	defaultLabel = "default",
	/** Where the CLI keeps its own default model for its default profile ("~/.codex/config.toml"). */
	configPath: string | null = null,
): RejectionView {
	const model = launch?.modelId ?? null;
	const accountId = launch?.accountId ?? null;
	const account = accountLabel(caps, accountId, defaultLabel);
	const current = accountId || "default";
	const others: AgentAccount[] = (caps?.accounts ?? []).filter((a) => a.id !== current && a.signedIn && a.signInState !== "unknown");
	const actions: RejectionAction[] = [];
	let titleKey: string;
	const titleValues: Record<string, string> = { agent: agentName, account };
	switch (event.reason) {
		case "model":
			if (model) {
				titleKey = "launchRejected.titleModel";
				titleValues.model = model;
				actions.push({ kind: "retry-default" });
			} else {
				// The CLI's own default (its config's model): name it, and where
				// it is set, when the CLI's words say which model it was.
				const resolved = refusedModelName(event.vendorMessage);
				if (resolved && configPath && (accountId || "default") === "default") {
					titleKey = "launchRejected.titleDefaultModelNamedConfig";
					titleValues.model = resolved;
					titleValues.config = configPath;
				} else if (resolved) {
					titleKey = "launchRejected.titleDefaultModelNamed";
					titleValues.model = resolved;
				} else {
					titleKey = "launchRejected.titleDefaultModel";
				}
			}
			for (const a of others.slice(0, 2)) actions.push({ kind: "use-account", accountId: a.id, label: a.id === "default" ? defaultLabel : a.label });
			actions.push({ kind: "pick-model" });
			break;
		case "effort":
			titleKey = "launchRejected.titleEffort";
			titleValues.effort = launch?.effort ?? "";
			actions.push({ kind: "retry-default" });
			actions.push({ kind: "pick-model" });
			break;
		case "signed_out":
			titleKey = "launchRejected.titleSignedOut";
			actions.push({ kind: "sign-in", accountId });
			for (const a of others.slice(0, 2)) actions.push({ kind: "use-account", accountId: a.id, label: a.id === "default" ? defaultLabel : a.label });
			actions.push({ kind: "try-again" });
			break;
		default:
			titleKey = "launchRejected.titleOther";
			for (const a of others.slice(0, 2)) actions.push({ kind: "use-account", accountId: a.id, label: a.id === "default" ? defaultLabel : a.label });
			if (model) actions.push({ kind: "retry-default" });
			actions.push({ kind: "try-again" });
	}
	return { titleKey, titleValues, actions };
}
