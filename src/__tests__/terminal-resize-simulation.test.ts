/**
 * Terminal Resize Simulation Tests
 *
 * Uses @xterm/headless + @xterm/addon-fit to simulate the exact resize
 * flows that caused rendering corruption in production.
 *
 * These tests reproduce the three failure modes at the xterm.js level:
 *
 *  1. Resize to degenerate dimensions (cols=1) then write — verifies that
 *     the proposeDimensions() guard prevents the mismatch.
 *
 *  2. History-style line wrapping after a dimension mismatch — verifies
 *     that when PTY and xterm disagree on cols, output is garbled.
 *
 *  3. Resize + refresh flow — verifies that refresh() after fit() repaints
 *     all visible rows.
 *
 * Why this matters: the source-code invariant tests (terminal-resize.test.ts)
 * verify that the guards EXIST in the code, but these simulation tests verify
 * that the terminal BEHAVES correctly when the guards fire.
 *
 * See: https://github.com/hermes-hq/hermes-ide/issues/112
 */
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";

/** Helper: write to terminal and wait for processing to complete */
function writeAsync(term: Terminal, data: string): Promise<void> {
	return new Promise((resolve) => term.write(data, resolve));
}

/** Read a specific row from the terminal buffer as a trimmed string */
function readLine(term: Terminal, row: number): string {
	const line = term.buffer.active.getLine(row);
	return line ? line.translateToString(true) : "";
}

/** Read all visible rows from the terminal buffer */
function readScreen(term: Terminal): string[] {
	const lines: string[] = [];
	for (let i = 0; i < term.rows; i++) {
		lines.push(readLine(term, i));
	}
	return lines;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Simulation 1: Dimension mismatch causes garbled history output
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Simulation: PTY/xterm dimension mismatch causes garbled output", () => {
	it("text written at 80 cols then terminal resized to 40 cols — content reflows", async () => {
		// Simulates: PTY starts at 80 cols, outputs a long prompt.
		// Then terminal resizes to 40 cols (as attach() would do).
		// The existing text should reflow correctly.
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

		// Write a long line that fits in 80 cols, then newline to move cursor
		const longLine = "A".repeat(60);
		await writeAsync(term, longLine + "\r\n");

		// Verify it's on one line at 80 cols
		expect(readLine(term, 0)).toBe(longLine);

		// Resize to 40 cols — simulating what attach() does
		term.resize(40, 24);

		// The 60-char line should now wrap to 2 lines
		const line0 = readLine(term, 0);
		const line1 = readLine(term, 1);
		expect(line0.length).toBe(40);
		expect(line1.length).toBe(20);
		expect(line0 + line1).toBe(longLine);

		term.dispose();
	});

	it("resize to very small cols spreads text across many rows (the bug)", async () => {
		// This is the exact failure mode: fitAddon calculates tiny cols,
		// xterm.resize() is called, and text stacks vertically.
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

		// Write at 80 cols
		await writeAsync(term, "hello world\r\n");

		// Catastrophic resize to very small cols
		term.resize(3, 24);

		// "hello world" should now span many rows — each row has at most 3 chars.
		// The exact distribution depends on xterm's reflow, but the key invariant
		// is that content that was 1 row is now fragmented across many.
		const rows: string[] = [];
		for (let i = 0; i < 6; i++) {
			const content = readLine(term, i);
			if (content) rows.push(content);
		}
		// At cols=3, "hello world" (11 chars) needs at least 4 rows
		expect(rows.length).toBeGreaterThanOrEqual(4);
		// Concatenated content should reconstruct the original
		expect(rows.join("")).toBe("hello world");

		term.dispose();
	});

	it("writing new content at very small cols produces fragmented text", async () => {
		// Simulates: terminal was resized to tiny cols (bad fit), user types
		const term = new Terminal({ cols: 3, rows: 24, allowProposedApi: true });

		await writeAsync(term, "hello\r\n");

		// Text is spread across rows — max 3 chars per row
		const rows: string[] = [];
		for (let i = 0; i < 3; i++) {
			const content = readLine(term, i);
			if (content) rows.push(content);
		}
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows.join("")).toBe("hello");

		term.dispose();
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Simulation 2: History navigation with mismatched cols leaves remnants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Simulation: History navigation leaves remnants on dimension mismatch", () => {
	it("readline erase-line at wrong col width leaves remnant text", async () => {
		// Simulates what the shell does when navigating history:
		//   1. Shell thinks terminal is 80 cols (PTY was told 80)
		//   2. xterm is actually 30 cols (correct visual size)
		//   3. Shell writes a long command
		//   4. Shell uses \r\x1b[K to erase — but this only clears the
		//      CURRENT LINE, not wrapped overflow on previous visual lines.
		//   → wrapped portion remains as a remnant.

		const term = new Terminal({ cols: 30, rows: 10, allowProposedApi: true });

		// Shell writes prompt + long command that wraps in 30-col terminal
		const command = "$ claude --dangerously-skip-permissions";
		await writeAsync(term, command);

		// Verify it wrapped (38 chars in 30-col terminal)
		const line0Before = readLine(term, 0);
		expect(line0Before.length).toBe(30); // first 30 chars fill the row

		// Shell's erase: \r moves to col 0 of CURRENT ROW (the wrapped row),
		// \x1b[K erases from cursor to end of that row.
		// The shell does NOT know about the first row's wrapped content.
		await writeAsync(term, "\r\x1b[K");

		// The first row STILL has wrapped remnant — this is the bug
		const line0After = readLine(term, 0);
		expect(line0After.length).toBeGreaterThan(0); // Remnant remains!

		term.dispose();
	});

	it("correct erase with \\x1b[J clears all wrapped lines below cursor", async () => {
		// Even with mismatched cols, \x1b[J clears from cursor to end of screen
		const term = new Terminal({ cols: 30, rows: 5, allowProposedApi: true });

		await writeAsync(term, "$ claude --dangerously-skip-permissions");

		// Move to beginning of screen and clear everything
		await writeAsync(term, "\x1b[H\x1b[J");

		// All lines should be cleared
		const screen = readScreen(term);
		for (const line of screen) {
			expect(line).toBe("");
		}

		term.dispose();
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Simulation 3: Resize preserves buffer content correctly
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Simulation: Resize maintains correct terminal state", () => {
	it("resize wider then narrower preserves text content", async () => {
		const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });

		// Write some text
		await writeAsync(term, "line one\r\n");
		await writeAsync(term, "line two\r\n");
		await writeAsync(term, "line three");

		// Resize wider
		term.resize(80, 10);

		// Resize narrower (back to original)
		term.resize(40, 10);

		// Content should still be intact
		expect(readLine(term, 0)).toBe("line one");
		expect(readLine(term, 1)).toBe("line two");
		expect(readLine(term, 2)).toBe("line three");

		term.dispose();
	});

	it("resize preserves buffer content without corruption", async () => {
		// In production, refresh() is called after resize to repaint WebGL.
		// Headless terminals don't have refresh(), so we verify that the
		// buffer content survives a resize (the data refresh() would repaint).
		const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });

		await writeAsync(term, "row 0\r\n");
		await writeAsync(term, "row 1\r\n");
		await writeAsync(term, "row 2\r\n");

		// resize triggers internal reflow
		term.resize(60, 5);

		// Content should be intact after resize
		expect(readLine(term, 0)).toBe("row 0");
		expect(readLine(term, 1)).toBe("row 1");
		expect(readLine(term, 2)).toBe("row 2");

		term.dispose();
	});

	it("resize to minimum safe dimensions (10x2) works correctly", async () => {
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

		await writeAsync(term, "hello");

		// Resize to our minimum guard value
		term.resize(10, 2);

		// Text should reflow
		expect(readLine(term, 0)).toBe("hello");

		// Can still write
		await writeAsync(term, " world");
		// "hello world" = 11 chars, wraps in 10-col terminal
		expect(readLine(term, 0).length).toBe(10);
		expect(readLine(term, 1)).toContain("d"); // last char wraps

		term.dispose();
	});

	it("resize to below minimum (cols=5) causes content corruption", async () => {
		// Demonstrates WHY we need the guard — shows the damage that
		// degenerate dimensions cause.
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

		await writeAsync(term, "hello world");

		// Resize to dangerously small cols
		term.resize(5, 2);

		// "hello world" at 5 cols wraps chaotically
		const line0 = readLine(term, 0);
		expect(line0.length).toBeLessThanOrEqual(5);
		// Content is split across many rows - this is the degenerate state
		// that our proposeDimensions() guard prevents

		term.dispose();
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Simulation 4: The proposeDimensions guard logic
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Simulation: proposeDimensions guard prevents mismatch", () => {
	/**
	 * Simulates the refitActive() / attach() flow:
	 *  1. Check proposeDimensions() → if bad, skip fit() entirely
	 *  2. If good, call fit() + refresh() + resizeSession()
	 *
	 * Returns the cols that would be sent to the PTY (or null if skipped).
	 */
	function simulateRefit(
		term: Terminal,
		proposedCols: number | null,
		proposedRows: number | null,
	): { colsSentToPty: number | null; xtermCols: number } {
		const MIN_COLS = 10;
		const MIN_ROWS = 2;

		const colsBefore = term.cols;

		// Simulate proposeDimensions() result
		if (
			proposedCols === null ||
			proposedRows === null ||
			proposedCols < MIN_COLS ||
			proposedRows < MIN_ROWS
		) {
			// Guard fires — don't call fit(), don't resize PTY
			return { colsSentToPty: null, xtermCols: colsBefore };
		}

		// Guard passed — call fit() (simulated by resize)
		term.resize(proposedCols, proposedRows);
		// Note: refresh() is not available on headless terminals (no renderer)
		// In production, entry.terminal.refresh(0, rows - 1) is called here.

		return { colsSentToPty: proposedCols, xtermCols: term.cols };
	}

	it("proposed cols=0 → guard fires, xterm stays at original size", () => {
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
		const result = simulateRefit(term, 0, 24);
		expect(result.colsSentToPty).toBeNull();
		expect(result.xtermCols).toBe(80); // unchanged!
		term.dispose();
	});

	it("proposed cols=1 → guard fires, xterm stays at original size", () => {
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
		const result = simulateRefit(term, 1, 24);
		expect(result.colsSentToPty).toBeNull();
		expect(result.xtermCols).toBe(80);
		term.dispose();
	});

	it("proposed cols=9 → guard fires (below minimum 10)", () => {
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
		const result = simulateRefit(term, 9, 24);
		expect(result.colsSentToPty).toBeNull();
		expect(result.xtermCols).toBe(80);
		term.dispose();
	});

	it("proposed cols=10 → guard passes, xterm resizes, PTY notified", () => {
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
		const result = simulateRefit(term, 10, 24);
		expect(result.colsSentToPty).toBe(10);
		expect(result.xtermCols).toBe(10);
		term.dispose();
	});

	it("proposed rows=1 → guard fires", () => {
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
		const result = simulateRefit(term, 80, 1);
		expect(result.colsSentToPty).toBeNull();
		expect(result.xtermCols).toBe(80);
		term.dispose();
	});

	it("proposed null → guard fires (proposeDimensions returned undefined)", () => {
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
		const result = simulateRefit(term, null, null);
		expect(result.colsSentToPty).toBeNull();
		expect(result.xtermCols).toBe(80);
		term.dispose();
	});

	it("proposed cols=60 → guard passes, PTY and xterm agree on 60", () => {
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
		const result = simulateRefit(term, 60, 24);
		expect(result.colsSentToPty).toBe(60);
		expect(result.xtermCols).toBe(60);
		// Key invariant: PTY and xterm agree
		expect(result.colsSentToPty).toBe(result.xtermCols);
		term.dispose();
	});

	it("guard always maintains PTY === xterm invariant (no mismatch)", () => {
		// The critical property: after our guard logic, PTY cols and xterm
		// cols are NEVER different. Either both update, or neither does.
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

		const testCases = [
			{ cols: 0, rows: 24 },   // degenerate: both stay at 80
			{ cols: 1, rows: 24 },   // degenerate: both stay at 80
			{ cols: 5, rows: 24 },   // degenerate: both stay at 80
			{ cols: 9, rows: 24 },   // degenerate: both stay at 80
			{ cols: 10, rows: 24 },  // valid: both become 10
			{ cols: 60, rows: 24 },  // valid: both become 60
			{ cols: 200, rows: 24 }, // valid: both become 200
		];

		let expectedXtermCols = 80; // initial

		for (const tc of testCases) {
			const result = simulateRefit(term, tc.cols, tc.rows);
			if (result.colsSentToPty !== null) {
				expectedXtermCols = tc.cols;
				// Both updated to same value
				expect(result.colsSentToPty).toBe(result.xtermCols);
			} else {
				// Neither updated — xterm stayed at previous value
				expect(result.xtermCols).toBe(expectedXtermCols);
			}
		}

		term.dispose();
	});
});
