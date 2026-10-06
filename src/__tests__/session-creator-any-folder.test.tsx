// @vitest-environment jsdom
/**
 * The New Session wizard takes any folder. A folder that is not a git
 * repository (a plain folder, or a parent folder holding several
 * repositories) gets a plain hint, no branch step and no worktree; in a mixed
 * selection the git project keeps its branch step and the plain folder is
 * named as worked in directly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { CreateSessionOpts } from "../types/session";

const GIT = new Set(["p-app"]);

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
		if (cmd === "get_projects_ordered") {
			return [
				{ id: "p-notes", name: "notes", path: "/fixture-home/notes", languages: [], frameworks: [], path_exists: true },
				{ id: "p-code", name: "code", path: "/fixture-home/code", languages: [], frameworks: [], path_exists: true },
				{ id: "p-app", name: "app", path: "/fixture-home/app", languages: [], frameworks: [], path_exists: true },
			];
		}
		if (cmd === "git_is_git_repo") return GIT.has(String(args?.projectId));
		if (cmd === "git_list_branches_for_project") return [{ name: "main", is_remote: false, is_head: true }];
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
const hints = () => [...document.querySelectorAll(".session-creator-nongit-row")].map((n) => n.textContent);

async function openWizard() {
	const onCreate = vi.fn(async (_opts: CreateSessionOpts) => {});
	render(
		<I18nProvider>
			<SessionCreator onClose={() => {}} onCreate={onCreate} initialMode="agent" />
		</I18nProvider>,
	);
	await screen.findByText("notes");
	return onCreate;
}

async function pickFolders(...names: string[]) {
	for (const name of names) fireEvent.click(screen.getByText(name));
	await waitFor(() => expect(nextButton()).toBeEnabled());
}

async function confirm() {
	// The confirm step: the session's name field.
	await waitFor(() => expect(document.querySelector(".session-creator-name")).not.toBeNull());
	const create = [...document.querySelectorAll<HTMLButtonElement>(".session-creator-btn-primary")].pop()!;
	await act(async () => {
		fireEvent.click(create);
	});
}

describe("SessionCreator: any folder, git or not", () => {
	afterEach(() => cleanup());

	it("a plain folder: a plain hint, no branch step, and the session starts in the folder with no worktree", async () => {
		const onCreate = await openWizard();
		await pickFolders("notes");
		expect(hints()).toEqual(["notes: not a git repository, the agent works directly in this folder."]);
		fireEvent.click(nextButton());
		expect(document.querySelector(".session-creator-branch-multi")).toBeNull();
		await confirm();
		await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
		const opts = onCreate.mock.calls[0][0];
		expect(opts).toMatchObject({ projectIds: ["p-notes"], workingDirectory: "/fixture-home/notes" });
		expect(opts.branchSelections).toBeUndefined();
	});

	it("a parent folder holding several repositories is one folder: no worktree in the repositories inside it", async () => {
		const onCreate = await openWizard();
		await pickFolders("code");
		expect(hints()).toEqual(["code: not a git repository, the agent works directly in this folder."]);
		fireEvent.click(nextButton());
		await confirm();
		await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
		expect(onCreate.mock.calls[0][0]).toMatchObject({ projectIds: ["p-code"], workingDirectory: "/fixture-home/code" });
		expect(onCreate.mock.calls[0][0].branchSelections).toBeUndefined();
	});

	it("a mixed selection: the git project keeps its branch step, the plain folder is named as worked in directly", async () => {
		const onCreate = await openWizard();
		await pickFolders("notes", "app");
		expect(hints()).toEqual(["notes: not a git repository, the agent works directly in this folder."]);
		fireEvent.click(nextButton());
		await waitFor(() => expect(document.querySelector(".session-creator-branch-multi")).not.toBeNull());
		expect(document.querySelector(".session-creator-branch-nonGit")).toHaveTextContent("Not a git repository");
		fireEvent.click(document.querySelector(".session-creator-btn-skip") as HTMLElement);
		await confirm();
		await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
		const opts = onCreate.mock.calls[0][0];
		expect(opts.projectIds).toEqual(["p-notes", "p-app"]);
		expect(opts.branchSelections).toBeUndefined();
	});
});
