import { describe, it, expect } from "vitest";
import {
	DEFAULT_EDITOR_FONT_PX,
	MIN_EDITOR_FONT_PX,
	MAX_EDITOR_FONT_PX,
	nextEditorFontSize,
	parseEditorFontSize,
} from "../editor/editorFontSize";

describe("parseEditorFontSize", () => {
	it("returns the default for missing input", () => {
		expect(parseEditorFontSize(undefined)).toBe(DEFAULT_EDITOR_FONT_PX);
		expect(parseEditorFontSize(null)).toBe(DEFAULT_EDITOR_FONT_PX);
		expect(parseEditorFontSize("")).toBe(DEFAULT_EDITOR_FONT_PX);
	});

	it("returns the default for unparseable input", () => {
		expect(parseEditorFontSize("not a number")).toBe(DEFAULT_EDITOR_FONT_PX);
		expect(parseEditorFontSize("NaN")).toBe(DEFAULT_EDITOR_FONT_PX);
	});

	it("accepts in-range integers", () => {
		expect(parseEditorFontSize("14")).toBe(14);
		expect(parseEditorFontSize("18")).toBe(18);
	});

	it("clamps below the minimum", () => {
		expect(parseEditorFontSize("1")).toBe(MIN_EDITOR_FONT_PX);
		expect(parseEditorFontSize("-100")).toBe(MIN_EDITOR_FONT_PX);
	});

	it("clamps above the maximum", () => {
		expect(parseEditorFontSize("999")).toBe(MAX_EDITOR_FONT_PX);
	});

	it("parses integer prefixes (parseInt semantics)", () => {
		expect(parseEditorFontSize("14px")).toBe(14);
	});
});

describe("nextEditorFontSize", () => {
	it("increments by 1 on increase", () => {
		expect(nextEditorFontSize(13, "increase")).toBe(14);
	});

	it("decrements by 1 on decrease", () => {
		expect(nextEditorFontSize(13, "decrease")).toBe(12);
	});

	it("snaps back to the default on reset", () => {
		expect(nextEditorFontSize(20, "reset")).toBe(DEFAULT_EDITOR_FONT_PX);
		expect(nextEditorFontSize(8, "reset")).toBe(DEFAULT_EDITOR_FONT_PX);
	});

	it("clamps at the upper bound on increase", () => {
		expect(nextEditorFontSize(MAX_EDITOR_FONT_PX, "increase")).toBe(MAX_EDITOR_FONT_PX);
	});

	it("clamps at the lower bound on decrease", () => {
		expect(nextEditorFontSize(MIN_EDITOR_FONT_PX, "decrease")).toBe(MIN_EDITOR_FONT_PX);
	});
});
