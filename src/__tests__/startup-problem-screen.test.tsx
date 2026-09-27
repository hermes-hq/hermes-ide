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
};

describe("StartupProblemScreen", () => {
	afterEach(cleanup);

	it("explains the problem and shows which file was left alone", () => {
		render(<StartupProblemScreen problem={newerData} onQuit={() => {}} />);
		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toHaveAccessibleName("Your data is from a newer version of Hermes");
		expect(dialog).toHaveAccessibleDescription(/has not opened or changed it/);
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
});
