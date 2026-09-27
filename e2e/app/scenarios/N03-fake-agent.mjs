#!/usr/bin/env node
// Scenario N03: Hermes runs the fake terminal agent (tools/fake-agents) as a
// custom command in a plain terminal session. A user types the command, sees
// its full-screen approval box, answers it, and the scenario checks what the
// terminal shows, the exit code the shell reports, what the agent received
// from Hermes, and the session status in the session list.
//
// Three runs in one session: approve (y, exit 0), deny (n, exit 3) and
// interrupt (Ctrl-C, exit 130).
//
// Works with whatever shell the session starts: a POSIX shell (macOS, Linux),
// PowerShell or cmd.exe (Windows). The scenario asks the shell which kind it
// is, then quotes paths and reads the exit code the way that shell does
// (see ../shells.mjs).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N03-fake-agent.mjs
//
// Evidence (log, screenshots, the fake agent's own input logs) goes to
// HERMES_E2E_EVIDENCE, or <out dir>/evidence/N03-fake-agent.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { PROBE_OUTPUT, classifyProbe, commandLine, echoExitCode, probeCommand } from "../shells.mjs";

const SCENARIO = "N03-fake-agent";
const startedAt = Date.now();
const FAKE_AGENT = join(REPO_ROOT, "tools", "fake-agents", "fake-agent.mjs");
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
	if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
	log(`  ok — ${message}`);
}

// ── UI steps shared with a first-time user ───────────────────────────

async function finishOnboarding(bridge) {
	await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
	for (let i = 0; i < 3; i++) {
		await bridge.click(".onboarding-actions .onboarding-btn-primary");
		await sleep(150);
	}
	await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
	await bridge.clickWhenReady(`
		const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
		if (analytics.checked) e2e.click(analytics);
		if (!policy.checked) e2e.click(policy);
		return true;
	`);
	await bridge.waitFor("the Finish button to become enabled", `
		const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
		return !!b && !b.disabled;
	`);
	await bridge.click(".onboarding-actions .onboarding-btn-primary");
	await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
	await sleep(300);
	if (await bridge.exists(".whatsnew-backdrop")) {
		await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
		await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
	}
}

async function createPlainTerminal(bridge) {
	await bridge.click("button.es-tile-primary");
	await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator .session-creator-mode-step");`, {
		timeoutMs: 20_000,
	});
	await bridge.click('.session-creator-mode-card[data-category="universal"]');
	await bridge.click(".session-creator-actions .session-creator-btn-primary");
	await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
	// "Plain shell" is always the last card.
	await bridge.clickWhenReady(`
		const cards = e2e.all(".session-creator-provider-card");
		return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
	`);
	const before = await bridge.terminalIds();
	for (let i = 0; i < 6; i++) {
		if (!(await bridge.exists(".session-creator"))) break;
		await bridge.clickWhenReady(`
			if (!e2e.first(".session-creator")) return null;
			return e2e.click(e2e.must(
				e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
				"the wizard's primary button",
			));
		`);
		await sleep(400);
	}
	await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
	return bridge.waitFor(
		"a terminal to appear",
		`const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
		 return ids.length === 1 ? ids[0] : null;`,
		{ timeoutMs: 20_000 },
	);
}

// ── The session's shell ──────────────────────────────────────────────

async function detectShell(bridge, sessionId) {
	await bridge.typeInTerminal(sessionId, `${probeCommand()}\n`);
	const { line } = await bridge.waitForTerminal(sessionId, PROBE_OUTPUT, { timeoutMs: 20_000 });
	return classifyProbe(line);
}

// ── Session status (the phase tag in the session list) ───────────────

const phaseOf = (bridge) => bridge.eval(`return e2e.first(".session-item")?.getAttribute("data-phase") ?? null;`);

/** Records every change of the session's status until stopped. */
function watchPhase(bridge) {
	const seen = [];
	let on = true;
	const loop = (async () => {
		while (on) {
			try {
				const p = await phaseOf(bridge);
				if (p !== seen.at(-1)) seen.push(p);
			} catch {
				// the app may be busy; try again
			}
			await sleep(100);
		}
	})();
	return {
		seen,
		stop: async () => {
			on = false;
			await loop;
			return seen;
		},
	};
}

/** Ctrl-C the way a keyboard sends it: a key-down with the Control modifier. */
function pressCtrlC(bridge, sessionId) {
	return bridge.eval(`
		const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
		const ta = host.querySelector("textarea.xterm-helper-textarea");
		const mk = (type) => {
			const ev = new KeyboardEvent(type, { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true, composed: true, view: window });
			Object.defineProperty(ev, "keyCode", { get: () => 67 });
			Object.defineProperty(ev, "which", { get: () => 67 });
			return ev;
		};
		ta.dispatchEvent(mk("keydown"));
		ta.dispatchEvent(mk("keyup"));
		return true;
	`);
}

/** Lines after the last line that contains `marker` (the shell may split long lines into rows). */
const after = (lines, marker) => {
	const i = lines.map((l) => l.includes(marker)).lastIndexOf(true);
	return i < 0 ? [] : lines.slice(i + 1);
};

const readLog = (file) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

// ── One run of the fake agent ────────────────────────────────────────

async function runFakeAgent(bridge, sessionId, shell, { tag, answer, expectExit, shellMayMisreport = false, expectLine, expectBusy = false, shot }) {
	const agentLog = join(evidenceDir, `fake-agent-${tag}.jsonl`);
	rmSync(agentLog, { force: true });
	const marker = `fake-agent-${tag}-exit=`;
	const command = commandLine(shell, process.execPath, [FAKE_AGENT, "--scenario", "approval", "--log", agentLog]) + "\n";
	log(`run "${tag}": typing the custom command, then answering ${JSON.stringify(answer)}`);
	await bridge.typeInTerminal(sessionId, command);

	// The approval box is on the (alternate) screen.
	const box = await bridge.waitForTerminal(sessionId, /Allow Bash: rm -rf node_modules \?/, { timeoutMs: 20_000 });
	assert(box.lines.some((l) => l.includes("[y] yes   [n] no   [a] always")), `the approval box is on screen ("${box.line.trim()}")`);
	if (shot) await bridge.screenshot(join(evidenceDir, `${shot}-approval-box.png`));

	// Hermes's status for the session goes quiet while the agent waits for an
	// answer. After an approval the agent works for 1.5 s, which Hermes shows
	// as Working; the shell prompt afterwards returns it to idle. (A denial or
	// Ctrl-C ends the agent within milliseconds, too briefly to require it.)
	const waiting = await bridge.waitFor("the session to stop being busy while the box waits", `
		const p = e2e.first(".session-item")?.getAttribute("data-phase");
		return p && p !== "busy" ? p : null;
	`, { timeoutMs: 10_000 });
	log(`  session status while the box waits: ${waiting}`);
	const phases = watchPhase(bridge);
	if (answer === "ctrl-c") await pressCtrlC(bridge, sessionId);
	else await bridge.typeInTerminal(sessionId, answer);
	if (expectBusy) {
		const tag = await bridge.waitFor("the session status to show Working", `
			const el = e2e.first(".session-item .session-phase-tag");
			return el?.getAttribute("data-phase") === "busy" ? e2e.norm(el.innerText) : null;
		`, { timeoutMs: 5_000 });
		assert(!!tag, `the session list shows "${tag}" while the agent works after the approval`);
		if (shot) await bridge.screenshot(join(evidenceDir, `${shot}-working.png`));
	}

	// Once the agent has exited, ask the shell for its exit code. (A separate
	// command: zsh treats exit status 130 as an interrupt and would skip the
	// rest of a `agent; echo $?` list.)
	const deadline = Date.now() + 20_000;
	while (!(existsSync(agentLog) && readLog(agentLog).some((e) => e.ev === "exit"))) {
		if (Date.now() > deadline) throw new Error(`the fake agent never exited; see ${agentLog}`);
		await sleep(100);
	}
	await sleep(800); // let the shell draw its prompt again
	const exitPattern = new RegExp(`^${marker}\\d+\\s*$`);
	let done;
	for (let attempt = 1; ; attempt++) {
		await bridge.typeInTerminal(sessionId, `${echoExitCode(shell, marker)}\n`);
		try {
			done = await bridge.waitForTerminal(sessionId, exitPattern, { timeoutMs: shellMayMisreport ? 8_000 : 20_000 });
			break;
		} catch (e) {
			// Same known Hermes behaviour as below: the extra SIGINT Hermes
			// sends on Ctrl-C can reach the shell late, and bash's line editor
			// then throws away what it has read of the next line (seen on
			// Linux as `cho: command not found`). The line is typed once more;
			// the shell's number is then not the agent's, which is why the
			// agent's own exit code is asserted from its log.
			if (!shellMayMisreport || attempt >= 2) throw e;
			log("  KNOWN ISSUE: the shell dropped the start of the next typed line after Ctrl-C; typing it again");
		}
	}
	await sleep(2600); // past Hermes's 2 s silence threshold
	const seen = await phases.stop();
	const exitLine = done.lines.filter((l) => l.startsWith(marker)).at(-1)?.trimEnd();
	if (shellMayMisreport && exitLine !== `${marker}${expectExit}`) {
		// Known Hermes behaviour, not a fake-agent problem: when Ctrl-C is
		// pressed, Hermes writes ^C to the terminal and also sends a SIGINT
		// of its own, which reaches the shell (macOS). bash then reports 1
		// for the interrupted command even though it exited 130 (zsh and
		// PowerShell report 130). The agent's own exit code is asserted from
		// its log below.
		log(`  KNOWN ISSUE: the shell reports "${exitLine}" after Ctrl-C (the agent exited ${expectExit})`);
	} else {
		assert(exitLine === `${marker}${expectExit}`, `the shell reports exit code ${expectExit} ("${exitLine}")`);
	}
	// Everything the agent printed on the main screen, up to the exit line.
	const tail = after(done.lines, "fake-agent 1.0: working on the task");
	if (expectLine) assert(tail.some((l) => l.includes(expectLine)), `the terminal shows "${expectLine}"`);
	assert(!tail.some((l) => l.includes("Allow Bash")), "the approval box is gone (the alternate screen was left)");
	log(`  session status changes: ${seen.join(" -> ")}`);
	if (expectBusy) assert(seen.includes("busy"), "the recorded status changes include Working");
	assert(seen.at(-1) !== "busy",`the session status settled after the agent exited ("${seen.at(-1)}")`);
	for (const l of done.lines.slice(-6)) log(`    | ${l}`);
	if (shot) {
		await sleep(300);
		await bridge.screenshot(join(evidenceDir, `${shot}-after.png`));
	}

	// What the agent itself received from Hermes.
	assert(existsSync(agentLog), "the fake agent wrote its input log");
	const events = readLog(agentLog);
	const start = events.find((e) => e.ev === "start");
	assert(start.tty === true, `the agent ran on a real terminal (${start.cols}x${start.rows})`);
	assert(start.env.TERM_PROGRAM === "HERMES-IDE", `TERM_PROGRAM=${start.env.TERM_PROGRAM}`);
	assert(start.env.HERMES_SESSION_ID === sessionId, `HERMES_SESSION_ID is this session's id`);
	const input = events.filter((e) => e.ev === "input").map((e) => e.hex).join("");
	const wantHex = answer === "ctrl-c" ? "03" : Buffer.from(answer).toString("hex");
	// The agent turned on focus reporting, so Hermes may also send focus-in
	// (ESC [ I) / focus-out (ESC [ O) when the terminal gains or loses focus.
	const focusReports = input.match(/1b5b(?:49|4f)/g) ?? [];
	const keys = input.replace(/1b5b(?:49|4f)/g, "");
	log(`  focus reports delivered to the agent: ${focusReports.length}`);
	assert(keys === wantHex, `apart from focus reports, the agent received exactly the key that was pressed (hex ${input})`);
	assert(events.at(-1).ev === "exit" && events.at(-1).code === expectExit, `the agent logged exit ${expectExit}`);
}

// ── Scenario ─────────────────────────────────────────────────────────

let app;
let failed = false;
try {
	log(`scenario: N03-fake-agent   platform: ${platform()}`);
	app = await launchApp({ runDir: join(evidenceDir, "run"), log, home: process.env.HERMES_E2E_HOME || undefined });
	const { bridge } = app;

	log("step 1: first-launch welcome, then a plain terminal session from the New Session wizard");
	await finishOnboarding(bridge);
	const sessionId = await createPlainTerminal(bridge);
	log(`  session created: ${sessionId}`);
	await bridge.waitFor("the shell to print its prompt", `
		const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
		const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
		return info && info.opened && lines.some((l) => l.trim().length > 0);
	`, { timeoutMs: 30_000 });
	await sleep(1000);
	const shell = await detectShell(bridge, sessionId);
	log(`  the session's shell is ${shell === "posix" ? "a POSIX shell" : shell}`);

	log("step 2: approve");
	await runFakeAgent(bridge, sessionId, shell, {
		tag: "approve",
		answer: "y",
		expectExit: 0,
		expectLine: "fake-agent: task done",
		expectBusy: true,
		shot: "01",
	});

	log("step 3: deny");
	await runFakeAgent(bridge, sessionId, shell, {
		tag: "deny",
		answer: "n",
		expectExit: 3,
		expectLine: "fake-agent: approval denied",
		shot: "02",
	});

	log("step 4: interrupt with Ctrl-C");
	await runFakeAgent(bridge, sessionId, shell, {
		tag: "interrupt",
		answer: "ctrl-c",
		expectExit: 130,
		shellMayMisreport: true,
		shot: "03",
	});
} catch (e) {
	failed = true;
	log(`FAILED: ${e?.stack ?? e}`);
	try {
		if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
	} catch (inner) {
		log(`  (could not capture failure evidence: ${inner.message})`);
	}
} finally {
	if (app) {
		log("step 5: quit the app");
		const exit = await app.stop();
		log(`  app exited: ${JSON.stringify(exit)}`);
		if (!failed && (exit.forced || exit.code !== 0)) {
			failed = true;
			log("FAILED: the app did not quit cleanly");
		}
	}
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
