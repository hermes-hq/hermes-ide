// @vitest-environment jsdom
/**
 * When Hermes cannot open its data (e.g. it was saved by a newer version),
 * the window explains why and offers Quit instead of starting the workspace.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { StartupProblem } from "../api/startupProblem";
import { StartupProblemScreen } from "../components/StartupProblemScreen";

const newerData: StartupProblem = {
	kind: "newer-data",
	title: "Your data is from a newer version of Hermes",
	message:
		"This data was saved by a newer version of Hermes (data version 7; this version understands up to 1). Hermes has not opened or changed it.",
	dataPath: "/fixture-home/Library/Application Support/com.hermes-ide.terminal/hermes_idea_v3.db",
	found: 7,
	supported: 1,
	step: null,
	detail: null,
};

describe("StartupProblemScreen", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("explains the problem and shows which file was left alone", () => {
		render(<StartupProblemScreen problem={newerData} onQuit={() => {}} />);
		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toHaveAccessibleName("Your data is from a newer version of Hermes");
		expect(dialog).toHaveAccessibleDescription(/data version 7; this version understands up to 1\). Hermes has not opened or changed it/);
		expect(screen.getByText(newerData.dataPath)).toBeInTheDocument();
	});

	it("quits when the user presses Quit", () => {
		const onQuit = vi.fn();
		render(<StartupProblemScreen problem={newerData} onQuit={onQuit} />);
		const quit = screen.getByRole("button", { name: "Quit Hermes" });
		expect(quit).toHaveFocus();
		fireEvent.click(quit);
		expect(onQuit).toHaveBeenCalledTimes(1);
	});

	it("speaks the language the user picked, even though plugins never load here", () => {
		localStorage.setItem("hermes.ui_language", "de");
		render(<StartupProblemScreen problem={newerData} onQuit={() => {}} />);
		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toHaveAccessibleName("Deine Daten stammen aus einer neueren Version von Hermes");
		expect(dialog).toHaveAccessibleDescription(/Datenversion 7; diese Version versteht bis 1/);
		expect(screen.getByText("Datendatei")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Hermes beenden" })).toBeInTheDocument();
	});

	it("falls back to English for a language without a built-in pack", () => {
		render(<StartupProblemScreen problem={newerData} onQuit={() => {}} locale="xx" />);
		expect(screen.getByRole("button", { name: "Quit Hermes" })).toBeInTheDocument();
		expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Your data is from a newer version of Hermes");
	});

	it("names the failed step and the underlying error when an update fails", () => {
		const failed: StartupProblem = {
			kind: "migration-failed",
			title: "Hermes could not update your data",
			message: "unused",
			dataPath: "/data/hermes_idea_v3.db",
			found: null,
			supported: null,
			step: "2: add_widgets",
			detail: "disk I/O error",
		};
		render(<StartupProblemScreen problem={failed} onQuit={() => {}} locale="ja" />);
		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toHaveAccessibleName("Hermes はデータを更新できませんでした");
		expect(dialog).toHaveAccessibleDescription(/ステップ 2: add_widgets.*disk I\/O error/);
	});

	it("shows the backend's own wording for a problem it does not know", () => {
		const unknown = { ...newerData, kind: "something-new", title: "Backend title", message: "Backend message" } as unknown as StartupProblem;
		render(<StartupProblemScreen problem={unknown} onQuit={() => {}} locale="de" />);
		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toHaveAccessibleName("Backend title");
		expect(dialog).toHaveAccessibleDescription("Backend message");
	});
});
