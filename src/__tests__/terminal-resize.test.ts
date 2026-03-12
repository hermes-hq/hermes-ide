/**
 * Terminal Resize Rendering — Invariant Tests
 *
 * These tests enforce the invariants that prevent three related rendering bugs:
 *
 * Mode 1 — Stale WebGL cells after resize:
 *   fitAddon.fit() updates terminal dimensions but the WebGL renderer's
 *   dirty-row bitmask skips rows whose content didn't change.  Without an
 *   explicit terminal.refresh(), stale glyphs remain at old pixel offsets.
 *   Fix: call terminal.refresh(0, rows - 1) after every fit().
 *
 * Mode 2 — Vertical text / readline garble (cols mismatch):
 *   If fit() is called while the container has degenerate dimensions (0 px
 *   wide before flex layout settles), xterm's internal buffer is irreversibly
 *   resized to cols=1 while the PTY stays at 80 cols → mismatch.  Readline
 *   then formats output for 80 cols on a 1-col terminal, causing vertical
 *   stacking, overlapping text, and stale remnants after history navigation.
 *   Fix: call proposeDimensions() BEFORE fit() and bail if degenerate.
 *   This prevents xterm from ever being resized to bad values.
 *
 * Mode 3 — History navigation leaves remnants:
 *   Same root cause as Mode 2.  Once PTY and xterm disagree on cols,
 *   pressing up/down to navigate shell history produces incomplete erases.
 *   Fix: same proposeDimensions() guard as Mode 2.
 *
 * Mode 4 — SIGWINCH lost during shell startup:
 *   The PTY starts at 80×24 (hardcoded in Rust).  attach() sends
 *   resizeSession() via double-rAF, but the shell may not have installed
 *   its SIGWINCH handler yet — the signal is silently lost and the shell
 *   keeps COLUMNS=80 while xterm uses the real width.  Readline then
 *   formats output for 80 cols on a different-width terminal.
 *   Fix: re-send resizeSession() when the session phase transitions to
 *   "shell_ready", guaranteeing the shell picks up the correct size.
 *
 * See: https://github.com/hermes-hq/hermes-ide/issues/112
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

const POOL_SRC: string = readFileSync(
	new URL("../terminal/pool.ts", import.meta.url),
	"utf-8",
);

const TERMINAL_POOL_SRC: string = readFileSync(
	new URL("../terminal/TerminalPool.ts", import.meta.url),
	"utf-8",
);

const TERMINAL_PANE_SRC: string = readFileSync(
	new URL("../components/TerminalPane.tsx", import.meta.url),
	"utf-8",
);

// ─── Helpers ──────────────────────────────────────────────────────────

/** Extract a top-level exported function body from source code. */
function extractFunction(src: string, name: string): string {
	const re = new RegExp(`export function ${name}[\\s\\S]*?\\n\\}`);
	const match = src.match(re);
	expect(match).not.toBeNull();
	return match![0];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 15: terminal.refresh() called after every fitAddon.fit()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 15: terminal.refresh() after every fitAddon.fit()", () => {
	it("refitActive calls terminal.refresh() after fit()", () => {
		const body = extractFunction(POOL_SRC, "refitActive");
		const fitIdx = body.indexOf("entry.fitAddon.fit()");
		const refreshIdx = body.indexOf("entry.terminal.refresh(0,");
		expect(fitIdx).toBeGreaterThan(-1);
		expect(refreshIdx).toBeGreaterThan(-1);
		expect(refreshIdx).toBeGreaterThan(fitIdx);
	});

	it("attach calls terminal.refresh() after fit()", () => {
		const body = extractFunction(POOL_SRC, "attach");
		const fitIdx = body.indexOf("entry.fitAddon.fit()");
		const refreshIdx = body.indexOf("entry.terminal.refresh(0,");
		expect(fitIdx).toBeGreaterThan(-1);
		expect(refreshIdx).toBeGreaterThan(-1);
		expect(refreshIdx).toBeGreaterThan(fitIdx);
	});

	it("updateSettings calls terminal.refresh() after fit()", () => {
		const body = extractFunction(TERMINAL_POOL_SRC, "updateSettings");
		const fitIdx = body.indexOf("entry.fitAddon.fit()");
		const refreshIdx = body.indexOf("entry.terminal.refresh(0,");
		expect(fitIdx).toBeGreaterThan(-1);
		expect(refreshIdx).toBeGreaterThan(-1);
		expect(refreshIdx).toBeGreaterThan(fitIdx);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 16: proposeDimensions() guard BEFORE fit() prevents mismatch
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 16: proposeDimensions() checked BEFORE fit() to prevent PTY/xterm mismatch", () => {
	it("refitActive calls proposeDimensions() before fit()", () => {
		const body = extractFunction(POOL_SRC, "refitActive");
		const proposeIdx = body.indexOf("entry.fitAddon.proposeDimensions()");
		const fitIdx = body.indexOf("entry.fitAddon.fit()");
		expect(proposeIdx).toBeGreaterThan(-1);
		expect(fitIdx).toBeGreaterThan(-1);
		// proposeDimensions must come BEFORE fit
		expect(proposeIdx).toBeLessThan(fitIdx);
	});

	it("refitActive bails with 'continue' on degenerate proposed dimensions", () => {
		const body = extractFunction(POOL_SRC, "refitActive");
		// Must check proposed.cols < 10 || proposed.rows < 2
		expect(body).toContain("proposed.cols < 10");
		expect(body).toContain("proposed.rows < 2");
		// Must use continue (not return) since it's inside a for loop
		const guardLine = body.split("\n").find(
			(l: string) => l.includes("proposed.cols < 10") || l.includes("proposed.rows < 2"),
		);
		expect(guardLine).toBeDefined();
		expect(guardLine).toContain("continue");
	});

	it("attach calls proposeDimensions() before fit()", () => {
		const body = extractFunction(POOL_SRC, "attach");
		const proposeIdx = body.indexOf("entry.fitAddon.proposeDimensions()");
		const fitIdx = body.indexOf("entry.fitAddon.fit()");
		expect(proposeIdx).toBeGreaterThan(-1);
		expect(fitIdx).toBeGreaterThan(-1);
		expect(proposeIdx).toBeLessThan(fitIdx);
	});

	it("attach bails with 'return' on degenerate proposed dimensions", () => {
		const body = extractFunction(POOL_SRC, "attach");
		expect(body).toContain("proposed.cols < 10");
		expect(body).toContain("proposed.rows < 2");
		const guardLine = body.split("\n").find(
			(l: string) => l.includes("proposed.cols < 10") || l.includes("proposed.rows < 2"),
		);
		expect(guardLine).toBeDefined();
		expect(guardLine).toContain("return");
	});

	it("updateSettings calls proposeDimensions() before fit()", () => {
		const body = extractFunction(TERMINAL_POOL_SRC, "updateSettings");
		const proposeIdx = body.indexOf("proposeDimensions()");
		const fitIdx = body.indexOf("entry.fitAddon.fit()");
		expect(proposeIdx).toBeGreaterThan(-1);
		expect(fitIdx).toBeGreaterThan(-1);
		expect(proposeIdx).toBeLessThan(fitIdx);
	});

	it("fit() is NEVER called without a preceding proposeDimensions() guard", () => {
		// In pool.ts, every fitAddon.fit() must have a proposeDimensions() before it
		const lines = POOL_SRC.split("\n");
		const fitLines: number[] = [];
		const proposeLines: number[] = [];

		lines.forEach((line: string, i: number) => {
			if (line.includes("fitAddon.fit()") && !line.trim().startsWith("//")) {
				fitLines.push(i);
			}
			if (line.includes("proposeDimensions()") && !line.trim().startsWith("//")) {
				proposeLines.push(i);
			}
		});

		expect(fitLines.length).toBeGreaterThan(0);
		for (const fitLine of fitLines) {
			const hasGuard = proposeLines.some(
				(p: number) => p < fitLine && fitLine - p < 10,
			);
			expect(hasGuard).toBe(true);
		}
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 17: attach() uses double-rAF (same as refitActive)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 17: attach() uses double-rAF for fit timing", () => {
	it("attach has nested requestAnimationFrame calls (double-rAF)", () => {
		const body = extractFunction(POOL_SRC, "attach");
		const rafMatches = body.match(/requestAnimationFrame\(/g);
		expect(rafMatches).not.toBeNull();
		// Must have at least 2 rAFs for the fit (plus 1 for mousedown handler = 3+)
		expect(rafMatches!.length).toBeGreaterThanOrEqual(3);
	});

	it("fit() call is inside the INNER requestAnimationFrame", () => {
		const body = extractFunction(POOL_SRC, "attach");
		const attachedIdx = body.indexOf("entry.attached = true");
		const afterAttached = body.slice(attachedIdx);
		const firstRaf = afterAttached.indexOf("requestAnimationFrame(");
		const secondRaf = afterAttached.indexOf("requestAnimationFrame(", firstRaf + 1);
		const fitIdx = afterAttached.indexOf("entry.fitAddon.fit()");
		expect(firstRaf).toBeGreaterThan(-1);
		expect(secondRaf).toBeGreaterThan(-1);
		expect(fitIdx).toBeGreaterThan(secondRaf);
	});

	it("TerminalPane ResizeObserver also uses double-rAF for refitActive", () => {
		const doRefitBlock = TERMINAL_PANE_SRC.match(/const doRefit[\s\S]*?};/);
		expect(doRefitBlock).not.toBeNull();
		const rafCount = (doRefitBlock![0].match(/requestAnimationFrame/g) || []).length;
		expect(rafCount).toBe(2);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 18: Every fit() call site has BOTH refresh AND proposeDimensions guard
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 18: No unguarded fitAddon.fit() call sites", () => {
	it("every fitAddon.fit() in pool.ts is followed by refresh()", () => {
		const lines = POOL_SRC.split("\n");
		const fitLines: number[] = [];
		const refreshLines: number[] = [];

		lines.forEach((line: string, i: number) => {
			if (line.includes("fitAddon.fit()") && !line.trim().startsWith("//")) {
				fitLines.push(i);
			}
			if (line.includes(".refresh(0,") && !line.trim().startsWith("//")) {
				refreshLines.push(i);
			}
		});

		expect(fitLines.length).toBeGreaterThan(0);
		for (const fitLine of fitLines) {
			const hasNearbyRefresh = refreshLines.some(
				(r: number) => r > fitLine && r - fitLine < 10,
			);
			expect(hasNearbyRefresh).toBe(true);
		}
	});

	it("every fitAddon.fit() in TerminalPool.ts is followed by refresh()", () => {
		const lines = TERMINAL_POOL_SRC.split("\n");
		const fitLines: number[] = [];
		const refreshLines: number[] = [];

		lines.forEach((line: string, i: number) => {
			if (line.includes("fitAddon.fit()") && !line.trim().startsWith("//")) {
				fitLines.push(i);
			}
			if (line.includes(".refresh(0,") && !line.trim().startsWith("//")) {
				refreshLines.push(i);
			}
		});

		expect(fitLines.length).toBeGreaterThan(0);
		for (const fitLine of fitLines) {
			const hasNearbyRefresh = refreshLines.some(
				(r: number) => r > fitLine && r - fitLine < 10,
			);
			expect(hasNearbyRefresh).toBe(true);
		}
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 19: setSessionPhase re-sends resize on shell_ready
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 19: setSessionPhase re-sends PTY resize on shell_ready", () => {
	it("setSessionPhase calls resizeSession when phase becomes shell_ready", () => {
		const body = extractFunction(POOL_SRC, "setSessionPhase");
		// Must contain a resizeSession call
		expect(body).toContain("resizeSession(");
		// Must check for "shell_ready" phase
		expect(body).toContain('"shell_ready"');
	});

	it("resize is gated on entry.attached && entry.opened", () => {
		const body = extractFunction(POOL_SRC, "setSessionPhase");
		expect(body).toContain("entry.attached");
		expect(body).toContain("entry.opened");
	});

	it("resize uses current terminal dimensions (entry.terminal.rows/cols)", () => {
		const body = extractFunction(POOL_SRC, "setSessionPhase");
		expect(body).toContain("entry.terminal.rows");
		expect(body).toContain("entry.terminal.cols");
	});

	it("tracks previous phase to only fire on transition INTO shell_ready", () => {
		const body = extractFunction(POOL_SRC, "setSessionPhase");
		// Must store the previous phase before updating
		expect(body).toMatch(/prevPhase/);
		// Must compare prevPhase !== "shell_ready"
		expect(body).toContain('prevPhase !== "shell_ready"');
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 20: NaN guard on proposeDimensions (xterm.js issue #4338)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 20: isFinite() guard on proposeDimensions to catch NaN", () => {
	it("refitActive checks isFinite on proposed dimensions", () => {
		const body = extractFunction(POOL_SRC, "refitActive");
		expect(body).toContain("isFinite(proposed.cols)");
		expect(body).toContain("isFinite(proposed.rows)");
	});

	it("attach checks isFinite on proposed dimensions", () => {
		const body = extractFunction(POOL_SRC, "attach");
		expect(body).toContain("isFinite(proposed.cols)");
		expect(body).toContain("isFinite(proposed.rows)");
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 21: Ghost text cleared before resize
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 21: Ghost text cleared in refitActive before resize", () => {
	it("refitActive calls clearGhostText before fit()", () => {
		const body = extractFunction(POOL_SRC, "refitActive");
		const clearIdx = body.indexOf("clearGhostText(");
		const fitIdx = body.indexOf("entry.fitAddon.fit()");
		expect(clearIdx).toBeGreaterThan(-1);
		expect(fitIdx).toBeGreaterThan(-1);
		expect(clearIdx).toBeLessThan(fitIdx);
	});
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INVARIANT 22: estimateInitialDimensions provides sane defaults
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Invariant 22: estimateInitialDimensions exists and is exported", () => {
	it("pool.ts exports estimateInitialDimensions", () => {
		expect(POOL_SRC).toContain("export function estimateInitialDimensions");
	});

	it("estimateInitialDimensions returns rows and cols with min bounds", () => {
		const body = extractFunction(POOL_SRC, "estimateInitialDimensions");
		// Must enforce minimum bounds
		expect(body).toContain("Math.max(10,");
		expect(body).toContain("Math.max(2,");
	});
});
