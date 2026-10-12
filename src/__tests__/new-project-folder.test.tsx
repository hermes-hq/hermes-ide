// @vitest-environment jsdom
/**
 * New folder, the IDE's "New Project": in the New Session wizard's folder
 * step a new folder is made next to the newest project (or where the last
 * one was made) with the chosen setup, and it joins the session's folders.
 * Keys typed in the form stay in it: Space and Enter do not pick a folder of
 * the list behind it, and Esc closes the form, not the wizard.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { invoke } from "@tauri-apps/api/core";
import type { CreateSessionOpts } from "../types/session";

let lastParent = "";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
		if (cmd === "get_projects_ordered") {
			return [
				{ id: "p-app", name: "app", path: "/fixture-home/code/app", languages: [], frameworks: [], path_exists: true },
				{ id: "p-notes", name: "notes", path: "/fixture-home/notes", languages: [], frameworks: [], path_exists: true },
			];
		}
		if (cmd === "get_settings") return lastParent ? { new_folder_parent: lastParent } : {};
		if (cmd === "create_project_folder") {
			if (args.name === "taken") throw "/fixture-home/code/taken already exists.";
			return { id: "p-new", name: args.name, path: `${args.parent}/${args.name}`, languages: [], frameworks: [] };
		}
		if (cmd === "git_is_git_repo") return true;
		if (cmd === "git_enclosing_repo") return null;
		if (cmd === "git_list_branches_for_project") return [];
		if (cmd === "git_list_worktrees") return [];
		return undefined;
	}),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { SessionCreator } from "../components/SessionCreator";
import { defaultNewFolderParent } from "../components/NewFolderForm";
import { I18nProvider } from "../i18n/I18nProvider";

afterEach(() => {
	cleanup();
	lastParent = "";
	vi.mocked(invoke).mockClear();
});

async function openForm() {
	const onClose = vi.fn();
	render(
		<I18nProvider>
			<SessionCreator onClose={onClose} onCreate={vi.fn(async (_o: CreateSessionOpts) => {})} initialMode="agent" />
		</I18nProvider>,
	);
	await screen.findByText("notes");
	fireEvent.click(screen.getByRole("button", { name: "New folder…" }));
	const name = await screen.findByLabelText("Name");
	return { onClose, name: name as HTMLInputElement };
}

const createCalls = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "create_project_folder");

describe("New folder in the New Session wizard", () => {
	it("goes next to the newest project by default", () => {
		expect(defaultNewFolderParent([{ path: "/fixture-home/code/app" }, { path: "/fixture-home/notes" }])).toBe("/fixture-home/code");
		expect(defaultNewFolderParent([{ path: "C:\\work\\app" }])).toBe("C:\\work");
		expect(defaultNewFolderParent([])).toBe("~");
	});

	it("makes the folder with git, a .gitignore and AGENTS.md, and adds it to the session", async () => {
		const { name, onClose } = await openForm();
		expect(screen.getByLabelText("Create in")).toHaveValue("/fixture-home/code");
		fireEvent.change(name, { target: { value: "habit tracker" } });
		fireEvent.keyDown(name, { key: " " });
		fireEvent.keyDown(name, { key: "Enter" });
		await waitFor(() => expect(createCalls()).toHaveLength(1));
		expect(createCalls()[0][1]).toEqual({
			parent: "/fixture-home/code",
			name: "habit tracker",
			options: { git: true, agentsMd: true, readme: false, gitignore: true },
		});
		const row = await screen.findByText("habit tracker");
		const pick = row.closest(".h-choice")?.querySelector("input") as HTMLInputElement | null;
		expect(pick?.checked).toBe(true);
		expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
		const settings = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "set_setting");
		expect(settings).toContainEqual(["set_setting", { key: "new_folder_parent", value: "/fixture-home/code" }]);
	});

	it("starts where the last new folder was made", async () => {
		lastParent = "/fixture-home/projects";
		await openForm();
		await waitFor(() => expect(screen.getByLabelText("Create in")).toHaveValue("/fixture-home/projects"));
	});

	it("without git there is no .gitignore", async () => {
		const { name } = await openForm();
		fireEvent.click(screen.getByLabelText("Start a git repository"));
		expect(screen.getByLabelText("Add a .gitignore")).toBeDisabled();
		fireEvent.click(screen.getByLabelText("Add a README"));
		fireEvent.change(name, { target: { value: "notes-2" } });
		fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
		await waitFor(() => expect(createCalls()).toHaveLength(1));
		expect(createCalls()[0][1]).toMatchObject({ options: { git: false, agentsMd: true, readme: true, gitignore: false } });
	});

	it("says why a folder could not be made and keeps the form", async () => {
		const { name } = await openForm();
		fireEvent.change(name, { target: { value: "taken" } });
		fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
		expect(screen.getByLabelText("Name")).toBeInTheDocument();
	});

	it("Esc closes the form, not the wizard", async () => {
		const { name, onClose } = await openForm();
		fireEvent.keyDown(name, { key: "Escape" });
		expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
		expect(createCalls()).toHaveLength(0);
	});
});
