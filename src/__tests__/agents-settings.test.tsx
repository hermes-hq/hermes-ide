// @vitest-environment jsdom
/**
 * Settings > Agents (2.0 launch contract): one card per installed agent
 * with its accounts, what can be chosen at launch and how exactly Hermes
 * knows its status; Add account creates the profile and opens the sign-in
 * when it is not signed in; presets are renamed and deleted from here.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home-fixture") }));

import { AgentsSettings, choiceSummary, effortSummary, modelsSummary, tildePath } from "../components/AgentsSettings";
import type { AgentCapabilities, CheckedPreset } from "../agent/capabilities/types";
import { I18nProvider } from "../i18n/I18nProvider";
import { translate } from "../i18n/registry";

const t = (k: string, v?: Record<string, string | number>) => translate(k, v);

function claude(over: Partial<AgentCapabilities> = {}): AgentCapabilities {
	return {
		agentId: "claude",
		agentName: "Claude Code",
		cliVersion: "2.1.284",
		installed: true,
		verifiedOnRealInstall: true,
		accounts: [{ id: "default", label: "Default profile", detail: "Max plan", signedIn: true, signInState: "signed-in" }],
		activeAccountId: "default",
		canAddAccount: true,
		models: ["default", "opus", "sonnet", "haiku", "opusplan"].map((id) => ({ id, label: id, efforts: [], available: true })),
		modelSource: "aliases",
		acceptsTypedModel: true,
		effortValues: ["low", "medium", "high", "xhigh", "max"],
		approvalModes: [
			{ id: "default", label: "Ask", flag: [], note: "", danger: false },
			{ id: "acceptEdits", label: "Accept edits", flag: [], note: "", danger: false },
		],
		statusSource: "exact",
		...over,
	};
}

const copilot: AgentCapabilities = { ...claude(), agentId: "copilot", agentName: "GitHub Copilot CLI", installed: false, verifiedOnRealInstall: false };
const preset: CheckedPreset = {
	id: "p1",
	name: "Deep",
	choice: { agentId: "claude", accountId: "work", approvalModeId: "acceptEdits", modelId: "opus", effort: "high", extraArgs: "", prefix: "", channels: [], where: { kind: "current-checkout" }, trackAsFeature: false },
	issues: [{ field: "account", message: "Work is signed out; using Default profile", was: "work", now: "default" }],
	launchable: true,
	effective: { agentId: "claude", accountId: "default", approvalModeId: "acceptEdits", modelId: "opus", effort: "high", extraArgs: "", prefix: "", channels: [], where: { kind: "current-checkout" }, trackAsFeature: false },
};

describe("summaries", () => {
	it("words what can be chosen at launch", () => {
		expect(modelsSummary(claude(), t)).toBe("Models: default, opus, sonnet, haiku, opusplan");
		expect(modelsSummary(claude({ modelSource: "cli-list", agentName: "Codex", models: [{ id: "default", label: "D", efforts: [], available: true }, { id: "a", label: "A", efforts: [], available: false }, { id: "b", label: "B", efforts: [], available: true }] }), t)).toBe(
			"Models: from Codex's own list (2) · 1 refused by this account",
		);
		expect(modelsSummary(claude({ modelSource: "free-text", models: [claude().models[0]] }), t)).toBe("Models: default, or type a name");
		expect(effortSummary(claude(), t)).toBe("Effort: low · medium · high · xhigh · max");
		expect(effortSummary(claude({ effortValues: [] }), t)).toBe("Effort: not offered at launch");
		expect(choiceSummary(preset.choice)).toBe("Claude Code · work · opus · high · acceptEdits");
		expect(tildePath("/home-fixture/.claude-work", "/home-fixture")).toBe("~/.claude-work");
		expect(tildePath("/elsewhere/.claude-work", "/home-fixture")).toBe("/elsewhere/.claude-work");
	});
});

describe("AgentsSettings", () => {
	let accounts: AgentCapabilities["accounts"];
	beforeEach(() => {
		accounts = claude().accounts;
		h.invoke.mockReset();
		h.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
			switch (cmd) {
				case "list_agent_capabilities":
					return [claude({ accounts }), copilot];
				case "list_launch_presets":
					return [preset];
				case "add_agent_account": {
					const a = { id: "work", label: String(args.label), detail: "not signed in", signedIn: false, signInState: "signed-out", profileEnv: { name: "CLAUDE_CONFIG_DIR", value: "/home-fixture/.claude-work" } };
					accounts = [...accounts, a];
					return { account: a, reused: false, signedIn: false };
				}
				default:
					return undefined;
			}
		});
	});
	afterEach(() => cleanup());

	it("a card per installed agent; the others are named once", async () => {
		const r = render(
			<I18nProvider>
				<AgentsSettings />
			</I18nProvider>,
		);
		const card = await waitFor(() => {
			const c = r.container.querySelector('.agents-settings-card[data-agent-id="claude"]');
			expect(c).not.toBeNull();
			return c as HTMLElement;
		});
		expect(card.dataset.verified).toBe("true");
		expect(card).toHaveTextContent("✓ Verified on a real install");
		expect(card).toHaveTextContent("Default profile · Max plan · signed in");
		expect(card).toHaveTextContent("Exact status");
		expect(r.container.querySelector('.agents-settings-card[data-agent-id="copilot"]')).toBeNull();
		expect(r.getByText("Not installed: GitHub Copilot CLI. They appear here once installed.")).toBeInTheDocument();
		expect(r.container.querySelector(".agents-settings-preset-issues")).toHaveTextContent("Changed at launch: Work is signed out; using Default profile");
	});

	it("Add account creates it and opens its sign-in; the profile reads as ~/…", async () => {
		const onSignInAccount = vi.fn();
		const r = render(
			<I18nProvider>
				<AgentsSettings onSignInAccount={onSignInAccount} />
			</I18nProvider>,
		);
		fireEvent.click(await r.findByText("+ Add account (opens a terminal to sign in)"));
		fireEvent.change(r.getByLabelText("Account name, e.g. Work"), { target: { value: "Work" } });
		fireEvent.click(r.getByText("Add and sign in"));
		await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("add_agent_account", { agentId: "claude", label: "Work" }));
		await waitFor(() => expect(onSignInAccount).toHaveBeenCalledWith("claude", "work"));
		await waitFor(() => expect(r.container.querySelector('[data-account-id="work"]')).toHaveTextContent("Work · not signed in · profile ~/.claude-work"));
	});

	it("presets: rename and delete call the backend", async () => {
		const r = render(
			<I18nProvider>
				<AgentsSettings />
			</I18nProvider>,
		);
		fireEvent.click(await r.findByText("Rename"));
		fireEvent.change(r.getByLabelText("Preset name"), { target: { value: "Deeper" } });
		fireEvent.click(r.getByText("Save"));
		await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("rename_launch_preset", { id: "p1", name: "Deeper" }));
		fireEvent.click(r.getByText("Delete"));
		await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("delete_launch_preset", { id: "p1" }));
	});
});
