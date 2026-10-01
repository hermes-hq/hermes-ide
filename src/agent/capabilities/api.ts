// ─── Agent capabilities: Tauri commands ────────────────────────────────
//
// Thin typed wrappers over the backend commands in
// src-tauri/src/agent_caps/commands.rs. Every stored choice the backend
// returns has already been checked against the agent's current
// capabilities (see CheckedChoice): launch `choice` / `effective`, never the
// raw stored one.

import { invoke } from "@tauri-apps/api/core";
import type {
	AddedAccount,
	AgentCapabilities,
	AgentLaunchOptions,
	CheckedChoice,
	CheckedPreset,
	LaunchChoice,
	LaunchValidation,
	RememberResult,
	UsualLaunchChoice,
} from "./types";

/**
 * What an agent lets a person choose at launch. Cached per CLI version and
 * account; `refresh` runs the CLI's read-only probes again.
 */
export function getAgentCapabilities(agentId: string, accountId?: string | null, refresh = false): Promise<AgentCapabilities> {
	return invoke<AgentCapabilities>("get_agent_capabilities", { agentId, accountId: accountId ?? null, refresh });
}

/** Every catalog agent's capabilities (Settings > Agents). Agents that are not installed come back with installed: false. */
export function listAgentCapabilities(refresh = false): Promise<AgentCapabilities[]> {
	return invoke<AgentCapabilities[]>("list_agent_capabilities", { refresh });
}

/** Checks a choice before launch. Effort is checked here because most CLIs do not check it themselves. */
export function validateLaunch(choice: LaunchChoice): Promise<LaunchValidation> {
	return invoke<LaunchValidation>("validate_launch", { choice });
}

/** The exact command line shown as "Hermes will run". */
export function previewLaunch(choice: LaunchChoice, task: string): Promise<string> {
	return invoke<string>("preview_launch", { choice, task });
}

/**
 * Remembers a launched choice: per agent + account (what the launcher
 * pre-selects for that agent) and, with a repository, in that repository's
 * launch history (the usual combination).
 */
export function rememberLaunchChoice(choice: LaunchChoice, repo?: string | null): Promise<RememberResult> {
	return invoke<RememberResult>("remember_launch_choice", { choice, repo: repo ?? null });
}

/** The choice last launched for this agent and account, checked. Null when there is none. */
export function getRememberedLaunchChoice(agentId: string, accountId?: string | null): Promise<CheckedChoice | null> {
	return invoke<CheckedChoice | null>("get_remembered_launch_choice", { agentId, accountId: accountId ?? null });
}

/** "Save as preset?" dismissed: never offered again for this combination. */
export function dismissPresetSuggestion(choice: LaunchChoice, repo?: string | null): Promise<void> {
	return invoke("dismiss_preset_suggestion", { choice, repo: repo ?? null });
}

/**
 * The launcher's starting point for a repository: its most frequent recent
 * combination (tie: the most recent), else the most frequent one across
 * repositories, else the catalog defaults. Always checked.
 */
export function getUsualLaunchChoice(repo: string | null): Promise<UsualLaunchChoice> {
	return invoke<UsualLaunchChoice>("get_usual_launch_choice", { repo });
}

export function listLaunchPresets(): Promise<CheckedPreset[]> {
	return invoke<CheckedPreset[]>("list_launch_presets");
}

export function saveLaunchPreset(name: string, choice: LaunchChoice): Promise<CheckedPreset> {
	return invoke<CheckedPreset>("save_launch_preset", { name, choice });
}

export function renameLaunchPreset(id: string, name: string): Promise<CheckedPreset> {
	return invoke<CheckedPreset>("rename_launch_preset", { id, name });
}

export function deleteLaunchPreset(id: string): Promise<void> {
	return invoke("delete_launch_preset", { id });
}

/**
 * Adds an account: creates its profile folder (only now, because the person
 * asked) and records it. The caller then opens a terminal running the CLI's
 * sign-in in that profile (see agentLaunchOptions with purpose "login").
 */
export function addAgentAccount(agentId: string, label: string): Promise<AddedAccount> {
	return invoke<AddedAccount>("add_agent_account", { agentId, label });
}

/**
 * Forgets an account Hermes added (and the models it refused). The profile
 * folder stays on disk; `signOut` first runs the agent's own sign-out in it
 * (the account stays when that fails).
 */
export function removeAgentAccount(agentId: string, accountId: string, signOut = false): Promise<void> {
	return invoke("remove_agent_account", { agentId, accountId, signOut });
}

/**
 * Starts a terminal session's agent again with another model, effort or
 * account (the rejection banner's Retry / Use another account / Pick
 * another model). Only fields given change.
 */
export function relaunchAgent(sessionId: string, options: AgentLaunchOptions): Promise<void> {
	return invoke("relaunch_agent", { sessionId, options });
}
