/**
 * Regression test: toast container must be positioned below the topbar.
 *
 * The `top` value in ToastContainer.css must reference `--topbar-h`
 * so toasts clear the title bar regardless of its height.
 *
 * See: https://github.com/hermes-hq/hermes-ide/issues/134
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(
	resolve(__dirname, "../styles/components/ToastContainer.css"),
	"utf-8",
);

describe("ToastContainer positioning", () => {
	it("uses --topbar-h token for top offset (not a hardcoded value)", () => {
		// Extract the .toast-container block
		const containerMatch = css.match(
			/\.toast-container\s*\{([^}]+)\}/,
		);
		expect(containerMatch).not.toBeNull();
		const block = containerMatch![1];

		// `top` must reference --topbar-h to stay in sync with the title bar
		const topLine = block.match(/top\s*:\s*(.+?);/);
		expect(topLine).not.toBeNull();
		expect(topLine![1]).toContain("var(--topbar-h)");
	});

	it("adds positive gap below the topbar", () => {
		const containerMatch = css.match(
			/\.toast-container\s*\{([^}]+)\}/,
		);
		const block = containerMatch![1];
		const topLine = block.match(/top\s*:\s*(.+?);/);

		// Should use calc() to add spacing beyond the topbar
		expect(topLine![1]).toMatch(/calc\(\s*var\(--topbar-h\)\s*\+/);
	});
});
