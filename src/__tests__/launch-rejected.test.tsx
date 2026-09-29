// @vitest-environment jsdom
/**
 * A launch the agent's CLI refused (2.0 launch contract): what the session
 * says and offers (src/agent/capabilities/rejection.ts), the store keeping
 * the refusal until a turn starts, and the banner's buttons calling the
 * backend with the right choice (relaunch_agent / sign-in).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { rejectionView } from "../agent/capabilities/rejection";
import type { AgentCapabilities } from "../agent/capabilities/types";
import { LaunchRejectedBanner } from "../components/LaunchRejectedBanner";
import { I18nProvider } from "../i18n/I18nProvider";
import { dispatchSessionEvent, getSessionEventSnapshot, _resetSessionEventStoreForTest } from "../agent/contract/sessionEventStore";
import type { SessionData } from "../types/session";

const CL = ["low", "medium", "high", "xhigh", "max"];

function caps(over: Partial<AgentCapabilities> = {}): AgentCapabilities {
	return {
		agentId: "claude",
		agentName: "Claude Code",
		cliVersion: "2.1.284",
		installed: true,
		verifiedOnRealInstall: true,
		accounts: [
			{ id: "default", label: "Default profile", detail: "Pro plan", signedIn: true, signInState: "signed-in" },
			{ id: "work", label: "Work", detail: "Max plan", signedIn: true, signInState: "signed-in", profileEnv: { name: "CLAUDE_CONFIG_DIR", value: "~/.claude-work" } },
			{ id: "old", label: "Old", detail: "", signedIn: false, signInState: "signed-out" },
		],
		activeAccountId: "default",
		canAddAccount: true,
		models: [
			{ id: "default", label: "Default", efforts: CL, available: true },
			{ id: "opus", label: "Opus", efforts: CL, available: true },
			{ id: "haiku", label: "Haiku", efforts: [], available: true },
		],
		modelSource: "aliases",
		approvalModes: [],
		statusSource: "exact",
		...over,
	};
}

describe("rejectionView", () => {
	it("a refused model: its name and the account, Retry with default, the other signed-in account, another model", () => {
		const v = rejectionView({ reason: "model", suggestion: "retry-default" }, "Claude Code", { modelId: "opus", accountId: null }, caps());
		expect(v.titleKey).toBe("launchRejected.titleModel");
		expect(v.titleValues).toEqual({ agent: "Claude Code", account: "default", model: "opus" });
		expect(v.actions).toEqual([{ kind: "retry-default" }, { kind: "use-account", accountId: "work", label: "Work" }, { kind: "pick-model" }]);
	});

	it("the default model refused: no Retry with the same default", () => {
		const v = rejectionView({ reason: "model", suggestion: "retry-default" }, "Codex", { modelId: null, accountId: "work" }, caps());
		expect(v.titleKey).toBe("launchRejected.titleDefaultModel");
		expect(v.titleValues.account).toBe("Work");
		expect(v.actions.map((a) => a.kind)).toEqual(["use-account", "pick-model"]);
		expect(v.actions[0]).toEqual({ kind: "use-account", accountId: "default", label: "default" });
	});

	it("signed out: Sign in for that account first, then the other accounts, then Try again", () => {
		const v = rejectionView({ reason: "signed_out", suggestion: "sign-in" }, "Claude Code", { accountId: "work" }, caps());
		expect(v.titleKey).toBe("launchRejected.titleSignedOut");
		expect(v.actions).toEqual([
			{ kind: "sign-in", accountId: "work" },
			{ kind: "use-account", accountId: "default", label: "default" },
			{ kind: "try-again" },
		]);
	});

	it("an effort refused, and an unknown refusal", () => {
		expect(rejectionView({ reason: "effort", suggestion: "retry-default" }, "Codex", { modelId: "m", effort: "ultra" }, null)).toMatchObject({
			titleKey: "launchRejected.titleEffort",
			titleValues: { effort: "ultra" },
			actions: [{ kind: "retry-default" }, { kind: "pick-model" }],
		});
		const other = rejectionView({ reason: "other", suggestion: "switch-account" }, "Gemini CLI", null, null);
		expect(other.titleKey).toBe("launchRejected.titleOther");
		expect(other.actions).toEqual([{ kind: "try-again" }]);
	});

	it("never offers a signed-out or unchecked account", () => {
		const c = caps({ accounts: [...caps().accounts, { id: "maybe", label: "Maybe", detail: "", signedIn: true, signInState: "unknown" }] });
		const v = rejectionView({ reason: "model", suggestion: "retry-default" }, "Claude Code", { modelId: "opus" }, c);
		expect(v.actions.filter((a) => a.kind === "use-account").map((a) => (a as { accountId: string }).accountId)).toEqual(["work"]);
	});
});

describe("the session event store keeps a refusal until a turn starts", () => {
	beforeEach(() => _resetSessionEventStoreForTest());
	it("sets an exact error status with the CLI's words and clears on turn_start", () => {
		dispatchSessionEvent("s1", { type: "launch_rejected", at: 5, reason: "model", vendorMessage: "There's an issue with the selected model (x).", suggestion: "retry-default" });
		const snap = getSessionEventSnapshot("s1");
		expect(snap.rejection?.reason).toBe("model");
		expect(snap.status).toEqual({ kind: "error", confidence: "exact", detail: "There's an issue with the selected model (x)." });
		dispatchSessionEvent("s1", { type: "turn_start", at: 6, n: 1 });
		expect(getSessionEventSnapshot("s1").rejection).toBeNull();
	});
});

function session(over: Partial<SessionData> = {}): SessionData {
	return {
		id: "sess-r",
		label: "S",
		description: "",
		color: "#000",
		group: null,
		phase: "idle",
		working_directory: "/tmp/x",
		shell: "zsh",
		created_at: "",
		last_activity_at: "",
		workspace_paths: [],
		detected_agent: null,
		metrics: {} as SessionData["metrics"],
		ai_provider: "claude",
		auto_approve: false,
		permission_mode: "default",
		custom_prefix: "",
		custom_suffix: "",
		channels: [],
		context_injected: false,
		ssh_info: null,
		mode: "terminal",
		agent_launch: { modelId: "opus", effort: "high", accountId: null },
		...over,
	};
}

describe("LaunchRejectedBanner", () => {
	beforeEach(() => {
		_resetSessionEventStoreForTest();
		h.invoke.mockReset();
		h.invoke.mockImplementation(async (cmd: string) => (cmd === "get_agent_capabilities" ? caps() : undefined));
	});
	afterEach(() => cleanup());

	it("shows nothing without a refusal", () => {
		const { container } = render(
			<I18nProvider>
				<LaunchRejectedBanner session={session()} onSignIn={() => {}} />
			</I18nProvider>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the CLI's words; Retry with default model relaunches without a model, keeping the effort the default takes", async () => {
		dispatchSessionEvent("sess-r", { type: "launch_rejected", at: 7, reason: "model", vendorMessage: "There's an issue with the selected model (opus).", suggestion: "retry-default" });
		const r = render(
			<I18nProvider>
				<LaunchRejectedBanner session={session()} onSignIn={() => {}} />
			</I18nProvider>,
		);
		const title = await r.findByText("opus isn't available on your default Claude Code account");
		expect(title).toBeInTheDocument();
		expect(r.getByText("There's an issue with the selected model (opus).")).toBeInTheDocument();
		fireEvent.click(r.getByText("Retry with default model"));
		await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("relaunch_agent", { sessionId: "sess-r", options: { modelId: null, effort: "high", accountId: undefined, purpose: "agent" } }));
		await waitFor(() => expect(r.container).toBeEmptyDOMElement());
	});

	it("Use the Work account keeps the model and effort; Pick another model starts the chosen one", async () => {
		dispatchSessionEvent("sess-r", { type: "launch_rejected", at: 8, reason: "model", vendorMessage: "no", suggestion: "retry-default" });
		const r = render(
			<I18nProvider>
				<LaunchRejectedBanner session={session({ id: "sess-r" })} onSignIn={() => {}} />
			</I18nProvider>,
		);
		fireEvent.click(await r.findByText("Use the Work account instead"));
		await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("relaunch_agent", { sessionId: "sess-r", options: { modelId: "opus", effort: "high", accountId: "work", purpose: "agent" } }));
		cleanup();

		dispatchSessionEvent("sess-r", { type: "launch_rejected", at: 9, reason: "model", vendorMessage: "no", suggestion: "retry-default" });
		const p = render(
			<I18nProvider>
				<LaunchRejectedBanner session={session()} onSignIn={() => {}} />
			</I18nProvider>,
		);
		fireEvent.click(await p.findByText("Pick another model"));
		const select = p.container.querySelector("select.launch-rejected-model") as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toEqual(["default", "haiku"]);
		fireEvent.change(select, { target: { value: "haiku" } });
		expect(p.container.querySelector("select.launch-rejected-effort")).toBeNull();
		fireEvent.click(p.getByText("Start"));
		await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("relaunch_agent", { sessionId: "sess-r", options: { modelId: "haiku", effort: null, accountId: undefined, purpose: "agent" } }));
	});

	it("when the default model was refused, Pick another model does not offer it again", async () => {
		dispatchSessionEvent("sess-r", { type: "launch_rejected", at: 11, reason: "model", vendorMessage: "no", suggestion: "retry-default" });
		const r = render(
			<I18nProvider>
				<LaunchRejectedBanner session={session({ agent_launch: { modelId: null } })} onSignIn={() => {}} />
			</I18nProvider>,
		);
		expect(r.queryByText("Retry with default model")).toBeNull();
		fireEvent.click(await r.findByText("Pick another model"));
		const select = r.container.querySelector("select.launch-rejected-model") as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toEqual(["opus", "haiku"]);
		expect(select.value).toBe("opus");
		fireEvent.click(r.getByText("Start"));
		await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("relaunch_agent", { sessionId: "sess-r", options: { modelId: "opus", effort: null, accountId: undefined, purpose: "agent" } }));
	});

	it("Sign in hands the account to the caller (a terminal running the CLI's sign-in)", async () => {
		dispatchSessionEvent("sess-r", { type: "launch_rejected", at: 10, reason: "signed_out", vendorMessage: "Not logged in · Please run /login", suggestion: "sign-in" });
		const onSignIn = vi.fn();
		const r = render(
			<I18nProvider>
				<LaunchRejectedBanner session={session({ agent_launch: { accountId: "work" } })} onSignIn={onSignIn} />
			</I18nProvider>,
		);
		fireEvent.click(await r.findByText("Sign in"));
		expect(onSignIn).toHaveBeenCalledWith("claude", "work");
		expect(h.invoke).not.toHaveBeenCalledWith("relaunch_agent", expect.anything());
	});
});
