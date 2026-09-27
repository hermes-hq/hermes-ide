// @vitest-environment jsdom
/**
 * A Copilot session runs the standalone `copilot` CLI, so its quick actions
 * are that CLI's slash commands. The retired `gh copilot suggest/explain`
 * commands would be typed into Copilot's own prompt and do nothing useful.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const sendShortcutCommand = vi.fn();
vi.mock("../terminal/TerminalPool", () => ({ sendShortcutCommand: (...a: unknown[]) => sendShortcutCommand(...a) }));
vi.mock("../state/SessionContext", () => ({ useSession: () => ({ dispatch: vi.fn() }) }));
vi.mock("../components/CommandsPopover", () => ({ CommandsPopover: () => null }));

import { ProviderActionsBar } from "../components/ProviderActionsBar";

afterEach(() => {
	cleanup();
	sendShortcutCommand.mockReset();
});

function renderCopilotBar() {
	render(
		<ProviderActionsBar sessionId="s1" agentName="Copilot CLI" actions={[]} recentActions={[]} phase="idle" aiProvider="copilot" />,
	);
	return [...document.querySelectorAll(".pab-action")].map((b) => b.textContent ?? "");
}

describe("Copilot quick actions", () => {
	it("offers Copilot CLI slash commands", () => {
		expect(renderCopilotBar()).toEqual(["/compact", "/clear", "/context", "/model", "/help"]);
	});

	it("never offers the retired gh copilot commands", () => {
		expect(renderCopilotBar().some((c) => /gh copilot/.test(c))).toBe(false);
	});

	it("sends the slash command to the Copilot session", () => {
		renderCopilotBar();
		fireEvent.click(screen.getByRole("button", { name: "/compact" }));
		expect(sendShortcutCommand).toHaveBeenCalledWith("s1", "/compact");
	});
});
