// @vitest-environment jsdom
/**
 * F30 / F35 — the pane-header chips of a terminal session.
 *
 * - flag off: nothing renders and nothing is asked of the backend
 * - the instructions chip lists the files the agent loads, from the backend
 * - "Link CLAUDE.md to AGENTS.md" calls the backend for the session's folder
 *   and the chip then lists both files
 * - the safety chip follows the running agent's command line: none for the
 *   mapped default, "Looser than default" for a looser flag
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
	invoke: vi.fn(),
	argv: [] as string[][],
	linked: false,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("2.0.0")) }));

import { I18nProvider } from "../i18n/I18nProvider";
import { AgentSetupChips, ARGV_POLL_MS } from "../components/AgentSetupChips";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";
import type { AgentSetupOverview } from "../api/agentSetup";

const FOLDER = "/work/project";

function overview(agentId: string): AgentSetupOverview {
	const claudeMd = { path: `${FOLDER}/CLAUDE.md`, display: "CLAUDE.md", name: "CLAUDE.md", scope: "project" as const, folder: FOLDER, loaded: true, via: null };
	const agentsMd = { path: `${FOLDER}/AGENTS.md`, display: "AGENTS.md", name: "AGENTS.md", scope: "project" as const, folder: FOLDER, loaded: true, via: null };
	const base = { agentName: agentId, known: true, settings: [], skills: [], mcp: [{ agentId, agentName: agentId, servers: [{ name: "docs", source: ".mcp.json", scope: "project" as const, loaded: true }] }] };
	if (agentId === "codex") return { ...base, agentId, instructions: [agentsMd], link: null };
	return h.linked
		? { ...base, agentId, instructions: [claudeMd, { ...agentsMd, via: "CLAUDE.md" }], link: null }
		: { ...base, agentId, instructions: [], link: { folder: FOLDER, file: "CLAUDE.md", target: "AGENTS.md" } };
}

function backend(cmd: string, args: Record<string, unknown>) {
	switch (cmd) {
		case "session_process_argv":
			return Promise.resolve(h.argv);
		case "agent_setup_overview":
			return Promise.resolve(overview(args.agentId as string));
		case "link_instructions_to_agents_md":
			h.linked = true;
			return Promise.resolve("created");
		case "get_settings":
		case "get_setting":
			return Promise.resolve(null);
		default:
			return Promise.reject(new Error(`unexpected ${cmd}`));
	}
}

function renderChips(aiProvider: string | null) {
	return render(
		<I18nProvider>
			<AgentSetupChips session={{ id: "s1", mode: "terminal", ai_provider: aiProvider, working_directory: FOLDER, workspace_paths: [] }} />
		</I18nProvider>,
	);
}

const chips = () => document.querySelector(".agent-setup-chips");

describe("AgentSetupChips", () => {
	beforeEach(() => {
		localStorage.clear();
		__resetFeatureFlagsForTest();
		h.invoke.mockReset();
		h.invoke.mockImplementation(backend);
		h.argv = [];
		h.linked = false;
	});
	afterEach(() => {
		cleanup();
		__resetFeatureFlagsForTest();
	});

	it("renders nothing and asks nothing with the flag off", async () => {
		await initFeatureFlags({});
		renderChips("claude");
		await act(async () => { await Promise.resolve(); });
		expect(chips()).toBeNull();
		const asked = h.invoke.mock.calls.map((c) => c[0]);
		expect(asked).not.toContain("session_process_argv");
		expect(asked).not.toContain("agent_setup_overview");
	});

	describe("with the flag on", () => {
		beforeEach(async () => {
			await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ agentCatalog: true }) });
		});

		it("a Codex session lists AGENTS.md", async () => {
			renderChips("codex");
			await waitFor(() => expect(screen.getByRole("button", { name: "AGENTS.md" })).toBeInTheDocument());
			// The chip alone does not read the MCP config files.
			expect(h.invoke).toHaveBeenCalledWith("agent_setup_overview", { agentId: "codex", cwd: FOLDER, attached: [], includeMcp: false });
		});

		it("links CLAUDE.md to AGENTS.md, then lists both", async () => {
			renderChips("claude");
			const chip = await screen.findByRole("button", { name: "No instruction file" });
			fireEvent.click(chip);
			const link = await screen.findByRole("button", { name: "Link CLAUDE.md to AGENTS.md" });
			// The open view reads and names the servers each agent sees.
			expect(await screen.findByText("docs")).toBeInTheDocument();
			expect(h.invoke).toHaveBeenCalledWith("agent_setup_overview", { agentId: "claude", cwd: FOLDER, attached: [], includeMcp: true });
			fireEvent.click(link);
			await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("link_instructions_to_agents_md", { agentId: "claude", folder: FOLDER }));
			await waitFor(() => expect(screen.getByRole("button", { name: "CLAUDE.md + AGENTS.md" })).toBeInTheDocument());
			expect(screen.getByText("linked from CLAUDE.md")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Link CLAUDE.md to AGENTS.md" })).toBeNull();
		});

		it("shows no safety chip for the mapped default", async () => {
			h.argv = [["claude", "--permission-mode", "acceptEdits"]];
			renderChips("claude");
			await waitFor(() => expect(chips()).toHaveAttribute("data-safety", "default"));
			expect(screen.queryByText("Looser than default")).toBeNull();
		});

		it("shows 'Looser than default' for a looser flag, naming it", async () => {
			h.argv = [["/opt/tools/bin/claude", "--permission-mode", "acceptEdits", "--dangerously-skip-permissions"]];
			renderChips("claude");
			const chip = await screen.findByText("Looser than default");
			expect(chip.getAttribute("title")).toContain("--dangerously-skip-permissions");
			expect(chips()).toHaveAttribute("data-safety", "looser");
		});

		it("shows nothing for an SSH session and reads nothing", async () => {
			render(
				<I18nProvider>
					<AgentSetupChips session={{ id: "s1", mode: "terminal", ai_provider: "claude", working_directory: FOLDER, workspace_paths: [], ssh_info: { host: "example.test" } }} />
				</I18nProvider>,
			);
			await act(async () => { await Promise.resolve(); });
			expect(chips()).toBeNull();
			const asked = h.invoke.mock.calls.map((c) => c[0]);
			expect(asked).not.toContain("session_process_argv");
			expect(asked).not.toContain("agent_setup_overview");
		});

		it("pauses reading the processes while the window is hidden", async () => {
			vi.useFakeTimers();
			const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
			try {
				renderChips("claude");
				await act(async () => { await Promise.resolve(); });
				const reads = () => h.invoke.mock.calls.filter((c) => c[0] === "session_process_argv").length;
				const first = reads();
				expect(first).toBe(1);
				visibility.mockReturnValue("hidden");
				await act(async () => { vi.advanceTimersByTime(ARGV_POLL_MS * 3); });
				expect(reads()).toBe(first);
				visibility.mockReturnValue("visible");
				await act(async () => { vi.advanceTimersByTime(ARGV_POLL_MS); });
				expect(reads()).toBe(first + 1);
			} finally {
				visibility.mockRestore();
				vi.useRealTimers();
			}
		});

		it("follows an agent started by hand in a plain shell", async () => {
			h.argv = [["codex", "--dangerously-bypass-approvals-and-sandbox"]];
			renderChips(null);
			await screen.findByText("Looser than default");
			expect(chips()).toHaveAttribute("data-agent-id", "codex");
		});
	});
});
