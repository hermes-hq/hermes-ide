// @vitest-environment jsdom
/**
 * The folder step's Next waits for the git check of the current selection.
 * Moving on before it answers skipped the branch step, so the task started
 * without its own branch and worktree.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

let resolveGitCheck: ((isGit: boolean) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === "get_projects_ordered") {
			return [
				{
					id: "p1",
					name: "repo",
					path: "/tmp/hermes-test/repo",
					languages: [],
					frameworks: [],
					path_exists: true,
				},
			];
		}
		if (cmd === "git_is_git_repo") {
			return new Promise<boolean>((resolve) => {
				resolveGitCheck = resolve;
			});
		}
		if (cmd === "git_list_branches_for_project") return [];
		if (cmd === "git_list_worktrees") return [];
		return undefined;
	}),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => () => {}),
	emit: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { SessionCreator } from "../components/SessionCreator";
import { I18nProvider } from "../i18n/I18nProvider";

const nextButton = () => document.querySelector(".session-creator-actions .session-creator-btn-primary") as HTMLButtonElement;

describe("SessionCreator folder step waits for the git check", () => {
	afterEach(() => {
		cleanup();
		resolveGitCheck = null;
	});

	it("keeps Next disabled until the selected folder is known to be a repo, then shows the branch step", async () => {
		render(
			<I18nProvider>
				<SessionCreator onClose={() => {}} onCreate={async () => {}} initialMode="agent" />
			</I18nProvider>,
		);
		const item = await screen.findByText("repo");

		// Every label Next shows, including ones replaced within the same
		// tick: selecting the folder must never render an enabled
		// "Next (1 selected)" before the check has answered.
		const shown: string[] = [];
		const observer = new MutationObserver((records) => {
			for (const r of records) {
				if (r.type === "characterData" && r.oldValue != null) shown.push(r.oldValue);
				r.removedNodes.forEach((n) => shown.push(n.textContent ?? ""));
			}
		});
		observer.observe(nextButton(), { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
		fireEvent.click(item);
		await act(async () => {});
		observer.disconnect();
		shown.push(nextButton().textContent ?? "");
		expect(shown).not.toContain("Next (1 selected)");

		expect(nextButton()).toBeDisabled();
		expect(nextButton()).toHaveTextContent("Checking...");
		// Clicking or pressing Enter while it checks does not move on.
		fireEvent.click(nextButton());
		expect(document.querySelector(".session-creator-branch-multi")).toBeNull();

		await waitFor(() => expect(resolveGitCheck).not.toBeNull());
		await act(async () => {
			resolveGitCheck?.(true);
		});
		await waitFor(() => expect(nextButton()).toBeEnabled());
		expect(nextButton()).toHaveTextContent("Next (1 selected)");

		fireEvent.click(nextButton());
		await waitFor(() => expect(document.querySelector(".session-creator-branch-multi")).not.toBeNull());
	});
});
