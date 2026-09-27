import { describe, it, expect } from "vitest";
import { buildLaunchPreview } from "../catalog/agentCatalog";

describe("Kiro launch command (#295)", () => {
	it("default mode launches the chat subcommand", () => {
		expect(buildLaunchPreview("kiro", "default", "", "")).toBe("kiro-cli chat");
	});

	it("auto mode uses --trust-all-tools on the chat subcommand", () => {
		expect(buildLaunchPreview("kiro", "auto", "", "")).toBe("kiro-cli chat --trust-all-tools");
	});
});
