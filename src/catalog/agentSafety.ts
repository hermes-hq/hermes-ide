// ─── One safety default across vendors (F35) ──────────────────────────
//
// Hermes has one safety default for every agent: write inside the working
// folder; ask before using the network or touching other folders. Each
// catalog entry maps it to that agent's own launch flags
// (`terminal.safety.default_mode`, one of its permission modes) and lists the
// argument sequences that run it looser (`terminal.safety.looser_args`).
//
// New sessions start in the mapped mode, and a running agent whose command
// line holds a looser argument gets a "Looser than default" chip. The command
// line is read from the processes under the session's shell, so an agent the
// user starts by hand is judged the same way as one Hermes started.
//
// Behind the agentCatalog flag (see isSafetyDefaultEnabled).

import { AGENT_CATALOG, getAgent, isAgentCatalogBetaEnabled, type AgentSafety } from "./agentCatalog";
import type { PermissionMode } from "../types/session";

/** Whether the 2.0 safety default and instruction-file chips are on. */
export function isSafetyDefaultEnabled(): boolean {
	return isAgentCatalogBetaEnabled();
}

export function safetyOf(agentId: string | null | undefined): AgentSafety | undefined {
	return getAgent(agentId)?.terminal.safety;
}

/** The permission mode a new session of this agent starts in. */
export function safetyDefaultMode(agentId: string | null | undefined): PermissionMode {
	return safetyOf(agentId)?.default_mode ?? "default";
}

/** `/usr/local/bin/Claude.EXE` -> `claude`. */
function commandName(token: string): string {
	const base = token.split(/[\\/]/).pop() ?? token;
	return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, "");
}

export interface AgentInvocation {
	agentId: string;
	/** The arguments after the agent's command. */
	args: string[];
}

/**
 * Finds a catalog agent among the agent command lines running under the
 * session's shell. The backend (`session_process_argv`) returns only those,
 * each starting at the agent's command: it sees through wrappers (`node
 * .../bin/claude`, `caffeinate -i claude`, `cmd /c codex.cmd`) and never
 * counts an agent's name as a later argument (`cat claude`). So the agent is
 * read from the first word only. `preferId` wins when several agents run.
 */
export function findAgentInvocation(argvs: readonly (readonly string[])[], preferId?: string | null): AgentInvocation | null {
	const binaries = new Map<string, string>();
	for (const a of AGENT_CATALOG.agents) {
		const bin = a.terminal.argv[0];
		if (bin && !a.custom) binaries.set(bin.toLowerCase(), a.id);
	}
	let first: AgentInvocation | null = null;
	for (const argv of argvs) {
		const id = argv.length ? binaries.get(commandName(argv[0])) : undefined;
		if (!id) continue;
		// A multi-word command (`goose session`, `kiro-cli chat`): skip its subcommand words.
		const words = getAgent(id)?.terminal.argv.length ?? 1;
		const hit = { agentId: id, args: argv.slice(words) };
		if (id === preferId) return hit;
		first ??= hit;
	}
	return first;
}

/** Whether `args` hold `seq` (as separate tokens, or as `--flag=value`). */
function holds(args: readonly string[], seq: readonly string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (seq.length === 1) {
			if (a === seq[0] || a.startsWith(`${seq[0]}=`)) return true;
			continue;
		}
		if (a === `${seq[0]}=${seq[1]}` && seq.length === 2) return true;
		if (seq.every((s, k) => args[i + k] === s)) return true;
	}
	return false;
}

export type SafetyVerdict =
	| { level: "looser"; reason: "flag"; flag: string }
	| { level: "looser"; reason: "vendor"; note: string }
	| { level: "ok" };

/** How an agent started with `args` compares to Hermes's safety default. */
export function judgeSafety(agentId: string, args: readonly string[]): SafetyVerdict {
	const safety = safetyOf(agentId);
	if (!safety) return { level: "ok" };
	for (const seq of safety.looser_args) {
		if (holds(args, seq)) return { level: "looser", reason: "flag", flag: seq.join(" ") };
	}
	if (safety.fit === "looser") return { level: "looser", reason: "vendor", note: safety.note };
	return { level: "ok" };
}
