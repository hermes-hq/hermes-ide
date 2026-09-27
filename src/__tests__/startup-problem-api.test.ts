/**
 * The frontend asks the backend, once at start, whether Hermes could open
 * its data. Anything but a recorded problem means "start normally".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { getStartupProblem, type StartupProblem } from "../api/startupProblem";

const newerData: StartupProblem = {
	kind: "newer-data",
	title: "Your data is from a newer version of Hermes",
	message: "This data was saved by a newer version of Hermes. Hermes has not opened or changed it.",
	dataPath: "/fixture-home/data/hermes_idea_v3.db",
};

describe("getStartupProblem", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("returns the problem the backend recorded", async () => {
		vi.mocked(invoke).mockResolvedValue(newerData);
		await expect(getStartupProblem()).resolves.toEqual(newerData);
		expect(invoke).toHaveBeenCalledWith("get_startup_problem");
	});

	it("returns null when the data opened normally", async () => {
		vi.mocked(invoke).mockResolvedValue(null);
		await expect(getStartupProblem()).resolves.toBeNull();
	});

	it("returns null when there is no backend to ask", async () => {
		vi.mocked(invoke).mockImplementation(() => Promise.reject(new Error("no backend")));
		await expect(getStartupProblem()).resolves.toBeNull();
	});
});
