#!/usr/bin/env node
// Fake vendor CLI: a stand-in for `claude` (or any agent Hermes starts) that
// behaves like the real one at startup — and records exactly how it was
// started — so launch and resume can be tested without an account.
//
//   node fake-cli.mjs [--session-id <id>] [--resume <id>] [--settings <file>]
//                     [--permission-mode <m>] [--channels <c>]... [prompt]
//
// What it does, like the real CLI:
//   - takes `--session-id` as its conversation id, or invents one;
//   - `--resume <id>` continues that conversation;
//   - reads the `--settings` file and runs its `SessionStart` hooks (JSON on
//     the hook's stdin, the same shape Claude Code sends) — but only after a
//     startup prompt was answered, when it shows one;
//   - then behaves as a small TUI: echoes keys, `q` on an empty line or
//     Ctrl-C quits (running the `SessionEnd` hooks first); a bracketed paste
//     followed by Enter is a prompt. Hooks run in exec form (`args`) or
//     through the shell, with matchers, as Claude Code runs them.
//   - a prompt is one turn: the `UserPromptSubmit` hooks run with
//     `{prompt}` — the Review Desk's delivery receipt rides on that — then
//     the turn's "work", then a stop that the settings file's `Stop` hooks
//     may refuse with exit code 2, like Claude Code — the fake then shows
//     the feedback, works once more and stops again with
//     `stop_hook_active: true` (F27).
//
// One key per thing a real agent does, so a test can drive every signal
// path (F11): `p` PermissionRequest then y/n (PostToolUse / PermissionDenied),
// `?` PreToolUse AskUserQuestion, `t` PreToolUse Bash (no matcher hit),
// `l` PreToolUse ExitPlanMode, `w` UserPromptSubmit, `s` Stop, `e` StopFailure,
// `u`/`d` SubagentStart/SubagentStop, `n` Notification idle_prompt,
// `o` an OSC 9 notification (no hook), `m` the OSC 777 Hermes marker with this
// launch's nonce, `x` the same marker with a forged nonce.
//
// In the `prompts` mode (F21, F27) those keys are plain text instead: a line
// of typed text followed by Enter is a prompt too. A prompt of the form
// `work <ms>` keeps the agent on its turn for that long first; keys typed
// meanwhile are queued and read only after the turn, as the real CLI does
// (the Review Desk must not type into a working agent).
//
// Behaviour is chosen per launch with HERMES_FAKE_MODE, or the file
// `<HERMES_FAKE_DIR>/mode` (so a test can change it between app launches).
// The mode is one or more words:
//   normal        start at once (default)
//   trust-prompt  show a "Do you trust the files in this folder?" dialog and
//                 wait for a key before doing anything else — what a vendor
//                 does in a folder it has not seen. Ctrl-C there (the key or
//                 SIGINT) exits 130 without running any hook.
//   resume-fails  reject `--resume` at once (exit 1, "No conversation found
//                 with session ID: <id>"), as a vendor does for an id it does
//                 not know; a fresh start still works
//   ignore-resume accept `--resume` but start a new conversation under a new
//                 id anyway — a broken vendor, used as the negative control
//                 that proves the resume checks can fail
//   prompts       typed lines are prompts (see above), not signal keys
//   no-prompt-hooks
//                 take prompts (as `prompts`) but never run the
//                 `UserPromptSubmit` hooks — a vendor without that hook, the
//                 negative control that proves the Review Desk's "not
//                 delivered" is real
//   work-log      each turn's work appends a line to `.fake-work.log` in the
//                 folder the agent runs in, so a check can tell how far the
//                 agent got (F27)
//   ignore-stop-hooks runs the Stop hooks but stops even when one refuses
//                 (exit 2) — a vendor without blocking stops, the negative
//                 control of the Done-When scenario
// and, with trust-prompt:
//   interrupt-exit-1  Ctrl-C at the prompt exits 1 instead — the same code
//                 as a rejected resume, but without its message
//   no-start-hook once past the prompt, start without running the
//                 SessionStart hook (hooks turned off, or a start signal that
//                 never comes)
//
// Every launch is recorded to `<HERMES_FAKE_DIR>/launch-<n>.json` (argv, cwd,
// the Hermes environment it saw, the settings file's contents, which hooks
// ran, how it ended) when HERMES_FAKE_DIR is set.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RECORD_DIR = process.env.HERMES_FAKE_DIR || null;
const KEPT_ENV = [
	"HERMES_SESSION_ID",
	"HERMES_AGENT",
	"HERMES_SIGNAL_FILE",
	"HERMES_SIGNAL_NONCE",
	"HERMES_LAUNCH_DIR",
	"HERMES_BIN_DIR",
	"HERMES_CONTEXT",
	"HERMES_TERMINAL",
	"TERM_PROGRAM",
	"SHELL",
];

function parseArgs(argv) {
	const out = { sessionId: null, resumeId: null, settings: null, permissionMode: null, channels: [], positional: [], raw: argv };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--session-id") out.sessionId = next();
		else if (a === "--resume") out.resumeId = next();
		else if (a === "--settings") out.settings = next();
		else if (a === "--permission-mode") out.permissionMode = next();
		else if (a === "--channels") out.channels.push(next());
		else if (a.startsWith("--")) out.positional.push(a); // unknown flags are kept visible in the record
		else out.positional.push(a);
	}
	return out;
}

function readMode() {
	if (process.env.HERMES_FAKE_MODE) return process.env.HERMES_FAKE_MODE.trim();
	if (RECORD_DIR) {
		try {
			return fs.readFileSync(path.join(RECORD_DIR, "mode"), "utf8").trim() || "normal";
		} catch {
			/* no mode file: normal */
		}
	}
	return "normal";
}

// ─── Doctor probes (F16) ──────────────────────────────────────────────
//
// The agent doctor runs `<cli> --version` and the catalog's sign-in check
// (`claude auth status`, `codex login status`, `opencode providers list`,
// `hermes status`). The fake answers those at once and records nothing:
//   HERMES_FAKE_AGENT    which agent this shim stands in for (default claude)
//   version              HERMES_FAKE_VERSION, or <HERMES_FAKE_DIR>/version-<agent>
//   signed in or out     HERMES_FAKE_AUTH=in|out, or <HERMES_FAKE_DIR>/auth-<agent>
const FAKE_AGENT = (process.env.HERMES_FAKE_AGENT || "claude").trim();
const AUTH_CHECKS = [["auth", "status"], ["login", "status"], ["providers", "list"], ["status"]];

function fakeSetting(envName, file, fallback) {
	if (process.env[envName]) return process.env[envName].trim();
	if (RECORD_DIR) {
		try {
			const v = fs.readFileSync(path.join(RECORD_DIR, `${file}-${FAKE_AGENT}`), "utf8").trim();
			if (v) return v;
		} catch {
			/* not set */
		}
	}
	return fallback;
}

function answerDoctorProbe(argv) {
	if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
		process.stdout.write(`${fakeSetting("HERMES_FAKE_VERSION", "version", "0.1.0")} (fake ${FAKE_AGENT})\n`);
		return 0;
	}
	if (AUTH_CHECKS.some((c) => c.length === argv.length && c.every((w, i) => w === argv[i]))) {
		const signedIn = fakeSetting("HERMES_FAKE_AUTH", "auth", "in") !== "out";
		process.stdout.write(signedIn ? "Signed in (fake)\n" : "Not signed in (fake)\n");
		return signedIn ? 0 : 1;
	}
	return null;
}

const probeExit = answerDoctorProbe(process.argv.slice(2));
if (probeExit !== null) {
	process.exitCode = probeExit;
	process.stdout.write("", () => process.exit(probeExit));
	// Nothing below runs for a probe.
	await new Promise(() => {});
}

const args = parseArgs(process.argv.slice(2));
const mode = readMode();
const modeWords = new Set(mode.split(/\s+/).filter(Boolean));
const has = (word) => modeWords.has(word);
const interruptCode = has("interrupt-exit-1") ? 1 : 130;
let atTrustPrompt = false;
const startedAt = Date.now();
let settings = null;
let settingsError = null;
if (args.settings) {
	try {
		settings = JSON.parse(fs.readFileSync(args.settings, "utf8"));
	} catch (e) {
		settingsError = String(e.message || e);
	}
}

const record = {
	kind: "fake-cli-launch",
	pid: process.pid,
	mode,
	argv: args.raw,
	cwd: process.cwd(),
	env: Object.fromEntries(KEPT_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
	sessionIdArg: args.sessionId,
	resumeIdArg: args.resumeId,
	settingsFile: args.settings,
	settings,
	settingsError,
	prompt: args.positional.join(" ") || null,
	/** Prompts submitted while running (typed or pasted, then Enter). */
	prompts: [],
	hooksRan: [],
	turns: [],
	events: [],
	exit: null,
};
let recordFile = null;
if (RECORD_DIR) {
	fs.mkdirSync(RECORD_DIR, { recursive: true });
	recordFile = path.join(RECORD_DIR, `launch-${String(startedAt).padStart(15, "0")}-${process.pid}.json`);
}
// A test polls the record while the fake is still writing to it, so it is
// replaced whole (a temporary file renamed over it), never seen half-written.
// The temporary name does not start with "launch-", so a reader listing the
// records never picks it up.
const save = () => {
	if (!recordFile) return;
	const text = JSON.stringify(record, null, 2) + "\n";
	const tmp = path.join(path.dirname(recordFile), `.${path.basename(recordFile)}.tmp`);
	fs.writeFileSync(tmp, text);
	// Windows refuses the rename for a moment while a reader holds the file.
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tmp, recordFile);
			return;
		} catch (e) {
			if (attempt >= 20 || (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY")) throw e;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
};
const note = (ev, extra = {}) => {
	record.events.push({ t: Date.now() - startedAt, ev, ...extra });
	save();
};
save();

const out = (s) => process.stdout.write(s);
const ESC = "\x1b";

// ─── Terminal input ─────────────────────────────────────────────────

let restoreDone = false;
function restoreTerminal() {
	if (restoreDone) return;
	restoreDone = true;
	out(`${ESC}[?25h`);
	if (process.stdin.isTTY) {
		try {
			process.stdin.setRawMode(false);
		} catch {
			/* not a terminal any more */
		}
	}
}

function finish(code, why) {
	record.exit = { code, why, t: Date.now() - startedAt };
	save();
	restoreTerminal();
	process.exitCode = code;
	process.stdout.write("", () => process.exit(code));
}

let waiter = null;
let closed = false;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("latin1");
process.stdin.on("data", (chunk) => {
	for (const ch of chunk) {
		if (waiter) {
			const w = waiter;
			waiter = null;
			w(ch);
		} else {
			pendingKeys.push(ch);
		}
	}
});
process.stdin.on("end", () => {
	closed = true;
	if (waiter) {
		const w = waiter;
		waiter = null;
		w(null);
	}
});
process.on("SIGTERM", () => finish(143, "SIGTERM"));
process.on("SIGHUP", () => finish(129, "SIGHUP"));
process.on("SIGINT", () => {
	// Raw mode delivers Ctrl-C as a byte; this covers a real signal too (the
	// terminal may send both). At the trust prompt it is the same as the key.
	if (atTrustPrompt) {
		interruptTrustPrompt("sigint-at-trust-prompt");
		return;
	}
	void quit("SIGINT");
});
const pendingKeys = [];
function nextKey() {
	if (pendingKeys.length) return Promise.resolve(pendingKeys.shift());
	if (closed) return Promise.resolve(null);
	return new Promise((resolve) => {
		waiter = resolve;
	});
}

// ─── Hooks (the settings file's `hooks` block, Claude Code shape) ────

/**
 * The command hooks configured for `event`. Like Claude Code, an entry's
 * `matcher` (absent, "" or "*": everything; otherwise a regex, or exact
 * names joined by "|") is tested against the tool name for tool events.
 */
function hookCommands(event, matchContext = "") {
	const groups = settings?.hooks?.[event];
	if (!Array.isArray(groups)) return [];
	const cmds = [];
	for (const g of groups) {
		const matcher = typeof g?.matcher === "string" ? g.matcher.trim() : "";
		if (matcher && matcher !== "*") {
			let matches = false;
			try {
				matches = new RegExp(`^(?:${matcher})$`).test(matchContext);
			} catch {
				matches = matcher.split("|").map((m) => m.trim()).includes(matchContext);
			}
			if (!matches) continue;
		}
		for (const h of g?.hooks ?? []) {
			if (h && h.type === "command" && typeof h.command === "string") cmds.push(h);
		}
	}
	return cmds;
}

/**
 * Run one hook the way Claude Code does: exec form (`args` present) spawns
 * the command directly with no shell; otherwise the command string goes
 * through the shell. The JSON payload is on stdin; stdout is recorded so a
 * test can see that the hook printed nothing (Hermes never answers a hook).
 */
function runHook(hook, payload) {
	return new Promise((resolve) => {
		const timeoutMs = Math.max(1, Number(hook.timeout) || 5) * 1000;
		const exec = Array.isArray(hook.args);
		const child = exec
			? spawn(hook.command, hook.args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: process.env, cwd: process.cwd() })
			: spawn(hook.command, { shell: true, stdio: ["pipe", "pipe", "pipe"], env: process.env, cwd: process.cwd() });
		const started = Date.now();
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ command: hook.command, args: exec ? hook.args : undefined, exec, code, ms: Date.now() - started, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 2000) });
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ command: hook.command, args: exec ? hook.args : undefined, exec, code: null, error: String(e.message || e) });
		});
		child.stdin.end(JSON.stringify(payload));
	});
}

async function runHooks(event, extra = {}) {
	const payload = {
		hook_event_name: event,
		session_id: sessionId,
		transcript_path: `/fixture-home/.fake/${sessionId}.jsonl`,
		cwd: process.cwd(),
		permission_mode: args.permissionMode || "default",
		...extra,
	};
	const results = [];
	for (const hook of hookCommands(event, typeof extra.tool_name === "string" ? extra.tool_name : "")) results.push(await runHook(hook, payload));
	record.hooksRan.push({ event, tool: extra.tool_name, results });
	note("hooks", { event, count: results.length });
	return results;
}

// ─── Terminal notifications (the fallback path, no hook involved) ────

const BEL = "\x07";
const nonceFromEnv = () => process.env.HERMES_SIGNAL_NONCE || "";
/** The in-band marker a Hermes hook makes Claude print over SSH. */
const marker = (nonce, event) => `${ESC}]777;notify;hermes-signal;v1:${nonce}:${event}${BEL}`;

// ─── Behaviour ───────────────────────────────────────────────────────

const resumed = !!args.resumeId && !has("ignore-resume");
const sessionId = (resumed ? args.resumeId : args.sessionId) || randomUUID();
let quitting = false;

async function quit(why) {
	if (quitting) return;
	quitting = true;
	out(`\r\nfake-cli: bye (${why})\r\n`);
	await runHooks("SessionEnd", { reason: why });
	finish(0, why);
}

function interruptTrustPrompt(why) {
	if (!atTrustPrompt) return;
	atTrustPrompt = false;
	note("trust-prompt-interrupted");
	finish(interruptCode, why);
}

async function main() {
	note("start", { sessionId, resumed });

	if (resumed && has("resume-fails")) {
		process.stderr.write(`No conversation found with session ID: ${args.resumeId}\n`);
		finish(1, "resume-rejected");
		return;
	}

	if (has("trust-prompt")) {
		out(`${ESC}[?25l`);
		out("\r\n┌──────────────────────────────────────────────────────┐\r\n");
		out("│ Do you trust the files in this folder?               │\r\n");
		out(`│ ${process.cwd().slice(0, 52).padEnd(52)} │\r\n`);
		out("│                                                      │\r\n");
		out("│ Accessing untrusted files may pose security risks.   │\r\n");
		out("│ [y] Yes, proceed    [n] No, exit                     │\r\n");
		out("└──────────────────────────────────────────────────────┘\r\n");
		note("trust-prompt-shown");
		atTrustPrompt = true;
		for (;;) {
			const key = await nextKey();
			if (!atTrustPrompt) return; // interrupted by SIGINT meanwhile
			if (key === null) {
				atTrustPrompt = false;
				finish(1, "stdin-closed-at-trust-prompt");
				return;
			}
			if (key === "\x03") {
				interruptTrustPrompt("ctrl-c-at-trust-prompt");
				return;
			}
			if (key === "y" || key === "Y" || key === "\r" || key === "\n") {
				atTrustPrompt = false;
				note("trust-prompt-accepted");
				out("Trusted. Starting…\r\n");
				break;
			}
			if (key === "n" || key === "N") {
				atTrustPrompt = false;
				note("trust-prompt-declined");
				finish(0, "declined-trust");
				return;
			}
		}
	}

	out(`\r\nfake-cli 0.1 · session ${sessionId} (${resumed ? `resumed from ${args.resumeId}` : "new"})\r\n`);
	if (record.prompt) out(`prompt: ${record.prompt}\r\n`);
	out("fake-cli: type q to quit\r\n");
	if (has("no-start-hook")) note("start-hook-skipped");
	else await runHooks("SessionStart", { source: resumed ? "resume" : "startup" });
	out(`fake-cli: ready\r\n`);

	// A prompt: typed text, or a bracketed paste, submitted with Enter —
	// as the Review Desk's one visible line arrives. Like the real CLI it
	// runs the UserPromptSubmit hooks with the prompt, unless the mode says
	// this vendor has no such hook (the negative control of the receipt).
	const promptsMode = has("prompts") || has("no-prompt-hooks");
	let line = "";
	let escape = "";
	let pasting = false;
	let pasteStart = 0;
	for (;;) {
		const key = await nextKey();
		if (key === null || key === "\x04") {
			await quit("eof");
			return;
		}
		if (escape || key === ESC) {
			escape += key;
			if (escape === `${ESC}[200~`) {
				pasting = true;
				pasteStart = line.length;
				escape = "";
			} else if (escape === `${ESC}[201~`) {
				pasting = false;
				// Like the real CLI: a paste shows as a placeholder, not its text.
				out(`[pasted ${line.length - pasteStart} chars]`);
				escape = "";
			} else if (!`${ESC}[200~`.startsWith(escape) && !`${ESC}[201~`.startsWith(escape)) {
				escape = ""; // some other key sequence: dropped
			}
			continue;
		}
		if (!pasting && key === "\x03") {
			await quit("ctrl-c");
			return;
		}
		if (!pasting && line === "" && key === "q") {
			await quit("q");
			return;
		}
		// One key per thing a real agent does, so a test can drive every
		// signal path (see the header comment). Not inside a paste, not
		// in the middle of a line, and not in the `prompts` mode.
		if (!promptsMode && !pasting && line === "") switch (key) {
			case "p": {
				out("\r\nfake-cli: asking permission for Bash: rm -rf node_modules  [y/n]\r\n");
				await runHooks("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf node_modules" } });
				for (;;) {
					const answer = await nextKey();
					if (answer === null || answer === "\x03") {
						await quit("interrupted-at-permission");
						return;
					}
					if (answer === "y" || answer === "Y") {
						out("fake-cli: allowed\r\n");
						await runHooks("PostToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf node_modules" }, tool_response: {} });
						break;
					}
					if (answer === "n" || answer === "N") {
						out("fake-cli: denied\r\n");
						await runHooks("PermissionDenied", { tool_name: "Bash" });
						break;
					}
				}
				continue;
			}
			case "?":
				out("\r\nfake-cli: asking a question\r\n");
				await runHooks("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [] } });
				continue;
			case "t":
				out("\r\nfake-cli: running an ordinary tool\r\n");
				await runHooks("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
				continue;
			case "l":
				out("\r\nfake-cli: plan ready\r\n");
				await runHooks("PreToolUse", { tool_name: "ExitPlanMode", tool_input: {} });
				continue;
			case "w":
				out("\r\nfake-cli: prompt submitted\r\n");
				await runHooks("UserPromptSubmit", { prompt: "hello" });
				continue;
			case "s":
				out("\r\nfake-cli: turn done\r\n");
				await runHooks("Stop", { stop_hook_active: false, last_assistant_message: "done" });
				continue;
			case "e":
				out("\r\nfake-cli: turn failed\r\n");
				await runHooks("StopFailure", { error: "rate_limit", error_details: "429 Too Many Requests" });
				continue;
			case "u":
				out("\r\nfake-cli: sub-agent started\r\n");
				await runHooks("SubagentStart", { agent_id: "sub-1", agent_type: "Explore" });
				continue;
			case "d":
				out("\r\nfake-cli: sub-agent stopped\r\n");
				await runHooks("SubagentStop", { agent_id: "sub-1", agent_type: "Explore", last_assistant_message: "found it" });
				continue;
			case "n":
				out("\r\nfake-cli: idle notification\r\n");
				await runHooks("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input", title: "Claude Code" });
				continue;
			case "o":
				// A vendor notification, as any program could print it.
				out(`\r\nfake-cli: printing an OSC 9 notification\r\n${ESC}]9;Approval requested: rm -rf node_modules${BEL}`);
				note("osc9");
				continue;
			case "m":
				// The in-band marker with this launch's nonce (Claude over SSH).
				out(`\r\nfake-cli: printing the Hermes marker\r\n${marker(nonceFromEnv(), "Stop")}`);
				note("marker", { nonce: "env" });
				continue;
			case "x":
				// The same marker with a nonce Hermes never minted.
				out(`\r\nfake-cli: printing a forged marker\r\n${marker("deadbeefdeadbeef", "PermissionRequest")}`);
				note("marker", { nonce: "forged" });
				continue;
			default:
				break;
		}
		if (key === "\r" || key === "\n") {
			if (pasting) {
				line += "\n";
				continue;
			}
			out("\r\n");
			if (line.trim() !== "") await submitPrompt(line);
			line = "";
			continue;
		}
		if (key === "\x7f" || key === "\b") {
			if (line) {
				line = line.slice(0, -1);
				out("\b \b");
			}
			continue;
		}
		if (key >= " ") {
			// Outside the `prompts` mode only a paste builds a prompt; typed
			// text is echoed, as before.
			if (promptsMode || pasting) line += key;
			if (!pasting) out(key);
		}
	}
}

// ─── Turns (a prompt, some work, a stop the Stop hooks may refuse) ───
//
// Like Claude Code: each prompt runs the `UserPromptSubmit` hooks, does its
// "work" (with `work-log`, appends one line to `.fake-work.log` in the
// current folder, so a check can tell how far the agent got), then tries to
// stop. The `Stop` hooks run with `stop_hook_active` false the first time; a
// hook that exits 2 refuses the stop and its stderr is the feedback: the fake
// shows it, works once more and tries to stop again with `stop_hook_active`
// true.

/** Most stops a turn may have refused before the fake gives up by itself
 *  (only a broken hook would get here; Claude has no such cap). */
const MAX_REFUSED_STOPS = 10;

/** One step of work; returns how many steps the work log holds (0 without `work-log`). */
function workStep(label) {
	if (!has("work-log")) return 0;
	const file = path.join(process.cwd(), ".fake-work.log");
	fs.appendFileSync(file, `${label}\n`);
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

async function submitPrompt(text) {
	record.prompts.push(text);
	note("prompt", { chars: text.length });
	out(`fake-cli: prompt received (${text.length} chars)\r\n`);
	const entry = { prompt: text.slice(0, 2000), stops: [] };
	record.turns = record.turns ?? [];
	record.turns.push(entry);
	if (!has("no-prompt-hooks")) await runHooks("UserPromptSubmit", { prompt: text });
	// `work <ms>` keeps the agent busy (nothing is read from the terminal
	// meanwhile); every turn ends with the Stop hooks.
	const work = /^work (\d+)$/.exec(text.trim());
	if (work) {
		const ms = Number(work[1]);
		out(`fake-cli: working for ${ms} ms\r\n`);
		note("working", { ms });
		await new Promise((resolve) => setTimeout(resolve, ms));
	}
	let steps = workStep(`turn ${record.turns.length}: ${text.split("\n")[0].slice(0, 80)}`);
	out(`fake-cli: worked (step ${steps})\r\n`);
	let active = false;
	for (let i = 0; i <= MAX_REFUSED_STOPS; i++) {
		const results = await runHooks("Stop", { stop_hook_active: active, last_assistant_message: `step ${steps}` });
		// A vendor without blocking stops (the negative control) stops anyway.
		const refused = has("ignore-stop-hooks") ? undefined : results.find((r) => r.code === 2);
		entry.stops.push({ active, codes: results.map((r) => r.code) });
		save();
		if (!refused) break;
		const first = (refused.stderr || "").split("\n").find((l) => l.trim()) ?? "";
		out(`fake-cli: Stop hook feedback: ${first.slice(0, 160)}\r\n`);
		note("stop-refused", { attempt: i + 1 });
		active = true;
		steps = workStep(`continue ${i + 1}`);
		out(`fake-cli: worked (step ${steps})\r\n`);
	}
	note("turn-end");
	out("fake-cli: turn ended\r\n");
	out("fake-cli: turn done\r\n");
	note("turn-done", { stops: entry.stops.length });
}

main().catch((e) => {
	process.stderr.write(`fake-cli: ${e?.stack ?? e}\n`);
	finish(70, "crash");
});
