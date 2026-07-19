import { describe, it, expect } from "vitest";
import {
	MAX_AUTO_LABEL_CHARS,
	deriveSessionLabelFromMessage,
	isDefaultSessionLabel,
} from "../utils/autoSessionLabel";

describe("isDefaultSessionLabel", () => {
	it("treats null and empty as default (unnamed)", () => {
		expect(isDefaultSessionLabel(null)).toBe(true);
		expect(isDefaultSessionLabel(undefined)).toBe(true);
		expect(isDefaultSessionLabel("")).toBe(true);
	});

	it("matches the backend 'Session N' placeholder", () => {
		expect(isDefaultSessionLabel("Session 1")).toBe(true);
		expect(isDefaultSessionLabel("Session 42")).toBe(true);
		expect(isDefaultSessionLabel("Session 9999")).toBe(true);
	});

	it("treats user-chosen names as non-default — does not match", () => {
		expect(isDefaultSessionLabel("My Project")).toBe(false);
		expect(isDefaultSessionLabel("Session A")).toBe(false);
		expect(isDefaultSessionLabel("session 1")).toBe(false); // case-sensitive
		expect(isDefaultSessionLabel("Session")).toBe(false);
		expect(isDefaultSessionLabel("Session 1 extra")).toBe(false);
	});
});

describe("deriveSessionLabelFromMessage", () => {
	it("returns null for empty / whitespace-only drafts", () => {
		expect(deriveSessionLabelFromMessage("")).toBeNull();
		expect(deriveSessionLabelFromMessage("   ")).toBeNull();
		expect(deriveSessionLabelFromMessage("\n\n\n")).toBeNull();
	});

	it("uses a short single-line message verbatim", () => {
		expect(deriveSessionLabelFromMessage("fix the login bug")).toBe("fix the login bug");
	});

	it("trims surrounding whitespace from the line it picks", () => {
		expect(deriveSessionLabelFromMessage("   refactor the parser   ")).toBe(
			"refactor the parser",
		);
	});

	it("takes the first non-empty line of a multi-line message", () => {
		const draft = "\n\ndesign the auth flow\n\nbackground: we need OAuth";
		expect(deriveSessionLabelFromMessage(draft)).toBe("design the auth flow");
	});

	it("collapses internal whitespace runs", () => {
		expect(deriveSessionLabelFromMessage("look\tat   the\t\tlogs")).toBe(
			"look at the logs",
		);
	});

	it("truncates at the max-char limit with an ellipsis", () => {
		const long = "A".repeat(MAX_AUTO_LABEL_CHARS + 10);
		const label = deriveSessionLabelFromMessage(long);
		expect(label).not.toBeNull();
		expect(label!.length).toBeLessThanOrEqual(MAX_AUTO_LABEL_CHARS + 1); // +1 for "…"
		expect(label!.endsWith("…")).toBe(true);
	});

	it("prefers a nearby word boundary when truncating", () => {
		// Cut should land on the space before "failures" (char 33), not mid-word.
		const draft = "investigate the intermittent test failures in the CI pipeline";
		expect(deriveSessionLabelFromMessage(draft)).toBe(
			"investigate the intermittent test…",
		);
	});

	it("falls back to a hard cut when no word boundary is near the limit", () => {
		// A single 60-char run with no spaces — must still produce a truncated label.
		const draft = "X".repeat(60);
		const label = deriveSessionLabelFromMessage(draft);
		expect(label).not.toBeNull();
		expect(label!.endsWith("…")).toBe(true);
		expect(label!.slice(0, -1).length).toBeLessThanOrEqual(MAX_AUTO_LABEL_CHARS);
	});

	it("keeps slash commands as labels (a `/clear` session is at least identifiable)", () => {
		expect(deriveSessionLabelFromMessage("/help")).toBe("/help");
	});
});
