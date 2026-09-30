// @vitest-environment jsdom
/**
 * The New Session creator, driven through clicks:
 *   - Branch step: a name typed in the "New branch" form is what the step's
 *     Continue uses, even without "Create & use" (it used to go on with the
 *     proposed or current branch). A name that cannot be created holds
 *     Continue back; "Use current branch" still wins over a typed name.
 *   - Folder step of a plain shell: the folder is a radio, so picking the
 *     chosen folder again (its box, its label, the row) keeps it chosen.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const available = vi.fn((_name: string) => ({ available: true, usedBySession: null }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "get_projects_ordered") {
			return [
				{ id: "p1", name: "alpha", path: "/tmp/hermes-test/alpha", languages: [], frameworks: [], path_exists: true },
				{ id: "p2", name: "beta", path: "/tmp/hermes-test/beta", languages: [], frameworks: [], path_exists: true },
			];
		}
		if (cmd === "git_is_git_repo") return true;
		if (cmd === "git_list_branches_for_project") {
			return [
				{ name: "main", is_current: true, is_remote: false, upstream: null, ahead: 0, behind: 0, last_commit_summary: null },
				{ name: "develop", is_current: false, is_remote: false, upstream: null, ahead: 0, behind: 0, last_commit_summary: null },
			];
		}
		if (cmd === "git_list_worktrees") return [];
		if (cmd === "git_check_branch_available") return available(String(args?.branchName));
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
import type { CreateSessionOpts } from "../types/session";

type OnCreate = (opts: CreateSessionOpts) => Promise<void>;

let proposed = "";
const primary = () => document.querySelector(".session-creator-btn-primary") as HTMLButtonElement;

async function openAtBranchStep(onCreate: OnCreate) {
	render(
		<I18nProvider>
			<SessionCreator onClose={() => {}} onCreate={onCreate} initialMode="agent" />
		</I18nProvider>,
	);
	fireEvent.click(await screen.findByText("alpha"));
	await waitFor(() => expect(primary()).toBeEnabled());
	fireEvent.click(primary());
	await waitFor(() => expect(document.querySelector(".session-creator-branch-multi")).not.toBeNull());
	// A new task branch (hermes/<slug>) is proposed and chosen on its own, and
	// the project folds; open it again.
	await waitFor(() => expect(document.querySelector(".session-creator-branch-selected-label")).toHaveTextContent(/^hermes\/\S+ \(new\)$/));
	proposed = document.querySelector(".session-creator-branch-selected-label")!.textContent!.replace(" (new)", "");
	await waitFor(() => expect(document.querySelector(".branch-selector-body")).toBeNull());
	fireEvent.click(document.querySelector(".session-creator-branch-project-header")!);
	fireEvent.click(await screen.findByRole("radio", { name: "New Branch" }));
	await screen.findByRole("textbox", { name: "Branch Name" });
}

const nameField = () => screen.getByRole("textbox", { name: "Branch Name" }) as HTMLInputElement;

async function typeName(name: string) {
	fireEvent.change(nameField(), { target: { value: name } });
	// Let the debounced availability check answer.
	await act(async () => {
		await new Promise((r) => setTimeout(r, 350));
	});
}

async function continueAndCreate(onCreate: ReturnType<typeof vi.fn<OnCreate>>) {
	fireEvent.click(primary());
	const create = await screen.findByRole("button", { name: /Create session/ });
	await act(async () => {
		fireEvent.click(create);
	});
	expect(onCreate).toHaveBeenCalledTimes(1);
	return onCreate.mock.calls[0][0];
}

describe("SessionCreator branch step: Continue commits the typed name", () => {
	afterEach(() => {
		cleanup();
		available.mockClear();
	});

	it("a valid typed name is the new branch, without pressing Create & use", async () => {
		const onCreate = vi.fn<OnCreate>(async () => {});
		await openAtBranchStep(onCreate);
		await typeName("feature/typed-by-hand");
		expect(available).toHaveBeenCalledWith("feature/typed-by-hand");
		expect(primary()).toHaveTextContent("Continue");
		const opts = await continueAndCreate(onCreate);
		expect(opts.branchSelections).toEqual({ p1: { branch: "feature/typed-by-hand", createNew: true } });
	});

	it("Continue right after typing, before the availability check answers, still uses the typed name", async () => {
		const onCreate = vi.fn<OnCreate>(async () => {});
		await openAtBranchStep(onCreate);
		fireEvent.change(nameField(), { target: { value: "feature/quick" } });
		const opts = await continueAndCreate(onCreate);
		expect(opts.branchSelections).toEqual({ p1: { branch: "feature/quick", createNew: true } });
	});

	it("a name that cannot be created holds Continue back until it is fixed", async () => {
		const onCreate = vi.fn<OnCreate>(async () => {});
		await openAtBranchStep(onCreate);
		await typeName("develop"); // already a branch
		expect(screen.getByText("A branch with this name already exists")).toBeInTheDocument();
		expect(primary()).toBeDisabled();
		available.mockReturnValueOnce({ available: false, usedBySession: null });
		await typeName("feature/taken");
		expect(primary()).toBeDisabled();
		await typeName("feature/free");
		expect(primary()).toBeEnabled();
		const opts = await continueAndCreate(onCreate);
		expect(opts.branchSelections).toEqual({ p1: { branch: "feature/free", createNew: true } });
	});

	it("the name field keeps the focus while its error comes and goes", async () => {
		await openAtBranchStep(vi.fn<OnCreate>(async () => {}));
		const field = nameField();
		field.focus();
		await typeName("develop");
		expect(screen.getByText("A branch with this name already exists")).toBeInTheDocument();
		expect(nameField()).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field).toHaveAttribute("aria-invalid", "true");
		expect(field).toHaveAccessibleDescription("A branch with this name already exists");
		await typeName("feature/ok");
		expect(screen.queryByText("A branch with this name already exists")).toBeNull();
		expect(document.activeElement).toBe(field);
	});

	it("'Use current branch' wins over a name left in the form", async () => {
		const onCreate = vi.fn<OnCreate>(async () => {});
		await openAtBranchStep(onCreate);
		await typeName("feature/not-this");
		fireEvent.click(screen.getByRole("button", { name: "Use current branch" }));
		const opts = await continueAndCreate(onCreate);
		expect(opts.branchSelections).toBeUndefined();
	});

	it("switching back to Existing Branch drops the typed name", async () => {
		const onCreate = vi.fn<OnCreate>(async () => {});
		await openAtBranchStep(onCreate);
		await typeName("feature/abandoned");
		fireEvent.click(screen.getByRole("radio", { name: "Existing Branch" }));
		const opts = await continueAndCreate(onCreate);
		expect(opts.branchSelections).toEqual({ p1: { branch: proposed, createNew: true } });
	});
});

describe("SessionCreator folder step of a plain shell: the folder is a radio", () => {
	afterEach(() => cleanup());

	it("picking the chosen folder again keeps it; picking another moves the choice", async () => {
		render(
			<I18nProvider>
				<SessionCreator onClose={() => {}} onCreate={async () => {}} />
			</I18nProvider>,
		);
		const shell = screen
			.getAllByRole("button")
			.find((b) => b.classList.contains("session-creator-provider-card") && b.textContent?.startsWith("Plain shell"));
		fireEvent.click(shell!);
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		await screen.findByText("alpha");
		const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(name) }) as HTMLInputElement;
		const row = (name: string) => screen.getByText(name).closest(".project-picker-item") as HTMLElement;

		fireEvent.click(radio("alpha"));
		expect(radio("alpha")).toBeChecked();
		// Its label, the row around it and Space all leave it chosen.
		fireEvent.click(screen.getByText("alpha"));
		expect(radio("alpha")).toBeChecked();
		fireEvent.click(row("alpha"));
		expect(radio("alpha")).toBeChecked();
		expect(row("alpha")).toHaveClass("project-picker-item-attached");

		fireEvent.click(row("beta"));
		expect(radio("beta")).toBeChecked();
		expect(radio("alpha")).not.toBeChecked();
		expect(document.querySelectorAll(".project-picker-item-attached")).toHaveLength(1);
	});
});
