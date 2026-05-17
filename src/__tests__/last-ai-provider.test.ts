import { describe, it, expect } from "vitest";
import { resolveDefaultAiProvider } from "../utils/lastAiProvider";

const KNOWN = ["claude", "codex", "gemini"] as const;

describe("resolveDefaultAiProvider", () => {
	it("returns null for missing input", () => {
		expect(resolveDefaultAiProvider(null, KNOWN)).toBeNull();
		expect(resolveDefaultAiProvider(undefined, KNOWN)).toBeNull();
		expect(resolveDefaultAiProvider("", KNOWN)).toBeNull();
	});

	it("returns null for whitespace-only input", () => {
		expect(resolveDefaultAiProvider("   ", KNOWN)).toBeNull();
		expect(resolveDefaultAiProvider("\t\n", KNOWN)).toBeNull();
	});

	it("returns a known provider id verbatim", () => {
		expect(resolveDefaultAiProvider("claude", KNOWN)).toBe("claude");
		expect(resolveDefaultAiProvider("codex", KNOWN)).toBe("codex");
	});

	it("trims surrounding whitespace before matching", () => {
		expect(resolveDefaultAiProvider("  claude  ", KNOWN)).toBe("claude");
	});

	it("returns null for an id not in the registry (silent fallback)", () => {
		expect(resolveDefaultAiProvider("deprecated-provider", KNOWN)).toBeNull();
	});

	it("is case-sensitive (registry IDs are canonical)", () => {
		expect(resolveDefaultAiProvider("CLAUDE", KNOWN)).toBeNull();
		expect(resolveDefaultAiProvider("Claude", KNOWN)).toBeNull();
	});

	it("works with an empty registry — everything falls back to null", () => {
		expect(resolveDefaultAiProvider("claude", [])).toBeNull();
	});
});
