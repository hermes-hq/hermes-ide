/**
 * The LaunchChoice rules the launcher applies while a person switches agent,
 * account or model (src/agent/capabilities/choice.ts). The backend applies
 * the same rules to stored choices (src-tauri/src/agent_caps/choice.rs);
 * both are tested on the same cases.
 */
import { describe, expect, it } from "vitest";
import { agentLaunchOptions, comboKey, nearestEffort, reconcileChoice } from "../agent/capabilities/choice";
import type { AgentCapabilities, LaunchChoice } from "../agent/capabilities/types";

const CL = ["low", "medium", "high", "xhigh", "max"];

function claudeCaps(over: Partial<AgentCapabilities> = {}): AgentCapabilities {
	return {
		agentId: "claude",
		agentName: "Claude Code",
		cliVersion: "2.1.284",
		installed: true,
		verifiedOnRealInstall: true,
		accounts: [
			{ id: "default", label: "Default profile", detail: "Max plan", signedIn: true },
			{ id: "work", label: "Work", detail: "not signed in", signedIn: false, profileEnv: { name: "CLAUDE_CONFIG_DIR", value: "~/.claude-work" } },
		],
		activeAccountId: "default",
		canAddAccount: true,
		models: [
			{ id: "default", label: "Default", efforts: CL, available: true },
			{ id: "opus", label: "Opus", efforts: CL, available: true },
			{ id: "haiku", label: "Haiku", efforts: [], available: true },
			{ id: "claude-opus-4-6", label: "Opus 4.6", efforts: ["low", "medium", "high", "max"], available: true },
			{ id: "gone", label: "Gone", efforts: CL, available: false, unavailableReason: "gone is not available on this account" },
		],
		modelSource: "aliases",
		acceptsTypedModel: true,
		approvalModes: [
			{ id: "default", label: "Ask", flag: [], note: "", danger: false },
			{ id: "acceptEdits", label: "Accept edits", flag: ["--permission-mode", "acceptEdits"], note: "", danger: false },
		],
		defaultApprovalModeId: "acceptEdits",
		statusSource: "exact",
		...over,
	};
}

function choice(over: Partial<LaunchChoice> = {}): LaunchChoice {
	return {
		agentId: "claude",
		accountId: "default",
		approvalModeId: "acceptEdits",
		modelId: "opus",
		effort: "high",
		extraArgs: "",
		prefix: "",
		channels: [],
		where: { kind: "new-worktree", baseBranch: "main", branch: "hermes/fix-login" },
		trackAsFeature: false,
		...over,
	};
}

describe("nearestEffort", () => {
	it("keeps an allowed effort and drops effort for a model without levels", () => {
		expect(nearestEffort("high", CL)).toBe("high");
		expect(nearestEffort("high", [])).toBeNull();
		expect(nearestEffort(null, CL)).toBeNull();
	});
	it("moves to the nearest level on the scale, the weaker one on a tie", () => {
		expect(nearestEffort("xhigh", ["low", "medium", "high", "max"])).toBe("high");
		expect(nearestEffort("ultra", CL)).toBe("max");
		expect(nearestEffort("minimal", ["low", "high"])).toBe("low");
		expect(nearestEffort("medium", ["low", "high"])).toBe("low");
		expect(nearestEffort("none", ["low", "medium"])).toBe("low");
	});
	it("an unknown word takes medium when offered, else the first level", () => {
		expect(nearestEffort("bogus", CL)).toBe("medium");
		expect(nearestEffort("bogus", ["low", "high"])).toBe("low");
	});
});

describe("reconcileChoice", () => {
	it("returns a valid choice unchanged and launchable", () => {
		const r = reconcileChoice(choice(), claudeCaps());
		expect(r.issues).toEqual([]);
		expect(r.launchable).toBe(true);
		expect(r.choice).toEqual(choice());
	});

	it("an unavailable model falls back to default and says why", () => {
		const r = reconcileChoice(choice({ modelId: "gone" }), claudeCaps());
		expect(r.choice.modelId).toBe("default");
		expect(r.issues).toEqual([
			{
				field: "model",
				message: "gone is not available on this account; using the default model",
				was: "gone",
				now: "default",
				code: "modelUnavailable",
				params: { model: "gone", agent: "Claude Code", reason: "gone is not available on this account" },
			},
		]);
		expect(r.launchable).toBe(true);
	});

	it("a model no longer offered by a list-only agent falls back to default", () => {
		const r = reconcileChoice(choice({ modelId: "gpt-9" }), claudeCaps({ acceptsTypedModel: false }));
		expect(r.choice.modelId).toBe("default");
		expect(r.issues[0].field).toBe("model");
	});

	it("a typed model is kept for an agent that takes one, with the default's efforts", () => {
		const r = reconcileChoice(choice({ modelId: "claude-sonnet-5-5" }), claudeCaps());
		expect(r.choice.modelId).toBe("claude-sonnet-5-5");
		expect(r.issues).toEqual([]);
	});

	it("an effort the model does not take moves to the nearest, or is dropped", () => {
		const nearest = reconcileChoice(choice({ modelId: "claude-opus-4-6", effort: "xhigh" }), claudeCaps());
		expect(nearest.choice.effort).toBe("high");
		expect(nearest.issues).toEqual([
			{
				field: "effort",
				message: "Opus 4.6 does not take effort xhigh; using high",
				was: "xhigh",
				now: "high",
				code: "effortChanged",
				params: { model: "Opus 4.6", agent: "Claude Code", was: "xhigh", now: "high" },
			},
		]);
		const none = reconcileChoice(choice({ modelId: "haiku", effort: "max" }), claudeCaps());
		expect(none.choice.effort).toBeNull();
		expect(none.issues[0].message).toBe("Haiku has no effort levels; the effort is left to Claude Code");
	});

	it("a signed-out or removed account is offered the active one, never taken on its own (not launchable)", () => {
		const out = reconcileChoice(choice({ accountId: "work" }), claudeCaps());
		expect(out.choice.accountId).toBe("default");
		expect(out.issues[0]).toEqual({
			field: "account",
			message: "Work is signed out; using Default profile",
			was: "work",
			now: "default",
			code: "accountSignedOutUsing",
			params: { account: "Work", agent: "Claude Code", using: "Default profile" },
		});
		const gone = reconcileChoice(choice({ accountId: "old" }), claudeCaps());
		expect(gone.choice.accountId).toBe("default");
		expect(gone.launchable).toBe(false);
		expect(out.launchable).toBe(false);
	});

	it("is not launchable when no account is signed in or the agent is not installed", () => {
		const caps = claudeCaps({ accounts: [{ id: "default", label: "Default profile", detail: "", signedIn: false }] });
		expect(reconcileChoice(choice(), caps).launchable).toBe(false);
		expect(reconcileChoice(choice(), claudeCaps({ installed: false })).launchable).toBe(false);
	});

	it("an approval mode the agent lacks falls back to its safety default", () => {
		const r = reconcileChoice(choice({ approvalModeId: "plan" }), claudeCaps());
		expect(r.choice.approvalModeId).toBe("acceptEdits");
		expect(r.issues[0].field).toBe("approval");
	});

	it("checks the Also-on choice with the second agent's capabilities", () => {
		const codex = claudeCaps({ agentId: "codex", agentName: "Codex", models: [{ id: "default", label: "Default", efforts: ["low", "medium", "high"], available: true }], acceptsTypedModel: false });
		const r = reconcileChoice(choice({ alsoOn: choice({ agentId: "codex", modelId: "gpt-5.5", effort: "max" }) }), claudeCaps(), codex);
		expect(r.choice.alsoOn?.modelId).toBe("default");
		expect(r.choice.alsoOn?.effort).toBe("high");
		expect(r.issues.every((i) => i.message.startsWith("Also on: "))).toBe(true);
	});
});

describe("comboKey", () => {
	it("ignores the per-task branch name and channel order, nothing else", () => {
		const a = choice({ channels: ["b", "a"] });
		const b = choice({ channels: ["a", "b"], where: { kind: "new-worktree", baseBranch: "main", branch: "hermes/other-task" } });
		expect(comboKey(a)).toBe(comboKey(b));
		expect(comboKey(a)).not.toBe(comboKey(choice({ effort: "max" })));
		expect(comboKey(a)).not.toBe(comboKey(choice({ where: { kind: "new-worktree", baseBranch: "dev", branch: "" } })));
		expect(comboKey(choice({ where: { kind: "existing-branch", branch: "x" } }))).not.toBe(comboKey(choice({ where: { kind: "existing-branch", branch: "y" } })));
	});
});

describe("agentLaunchOptions", () => {
	it("omits the default model and the default account", () => {
		expect(agentLaunchOptions(choice({ modelId: "default", accountId: "default", effort: null }))).toEqual({ modelId: null, effort: null, accountId: null, purpose: "agent" });
		expect(agentLaunchOptions(choice({ accountId: "work" }))).toEqual({ modelId: "opus", effort: "high", accountId: "work", purpose: "agent" });
	});
});
