import { describe, it, expect } from "vitest";
import { shouldDirectClick } from "../components/ActivityBar";

describe("shouldDirectClick", () => {
	it("returns true when reorder is disabled", () => {
		expect(shouldDirectClick(false, 5)).toBe(true);
	});

	it("returns true when reorder is enabled but only 1 tab exists", () => {
		expect(shouldDirectClick(true, 1)).toBe(true);
	});

	it("returns true when reorder is enabled but 0 tabs exist", () => {
		expect(shouldDirectClick(true, 0)).toBe(true);
	});

	it("returns false when reorder is enabled and 2+ tabs exist", () => {
		expect(shouldDirectClick(true, 2)).toBe(false);
	});

	it("returns false when reorder is enabled and many tabs exist", () => {
		expect(shouldDirectClick(true, 10)).toBe(false);
	});

	it("returns true when reorder is disabled regardless of tab count", () => {
		expect(shouldDirectClick(false, 0)).toBe(true);
		expect(shouldDirectClick(false, 1)).toBe(true);
		expect(shouldDirectClick(false, 100)).toBe(true);
	});
});
