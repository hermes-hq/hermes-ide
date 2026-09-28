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
//   - then behaves as a small TUI: echoes keys, `q` or Ctrl-C quits (running
//     the `SessionEnd` hooks first).
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
	hooksRan: [],
	events: [],
	exit: null,
};
let recordFile = null;
if (RECORD_DIR) {
	fs.mkdirSync(RECORD_DIR, { recursive: true });
	recordFile = path.join(RECORD_DIR, `launch-${String(startedAt).padStart(15, "0")}-${process.pid}.json`);
}
const save = () => {
	if (recordFile) fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
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

function hookCommands(event) {
	const groups = settings?.hooks?.[event];
	if (!Array.isArray(groups)) return [];
	const cmds = [];
	for (const g of groups) {
		for (const h of g?.hooks ?? []) {
			if (h && h.type === "command" && typeof h.command === "string") cmds.push(h);
		}
	}
	return cmds;
}

function runHook(hook, payload) {
	return new Promise((resolve) => {
		const timeoutMs = Math.max(1, Number(hook.timeout) || 5) * 1000;
		const child = spawn(hook.command, { shell: true, stdio: ["pipe", "pipe", "pipe"], env: process.env, cwd: process.cwd() });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ command: hook.command, code, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) });
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ command: hook.command, code: null, error: String(e.message || e) });
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
	for (const hook of hookCommands(event)) results.push(await runHook(hook, payload));
	record.hooksRan.push({ event, results });
	note("hooks", { event, count: results.length });
	return results;
}

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

	for (;;) {
		const key = await nextKey();
		if (key === null || key === "\x04") {
			await quit("eof");
			return;
		}
		if (key === "\x03") {
			await quit("ctrl-c");
			return;
		}
		if (key === "q") {
			await quit("q");
			return;
		}
		if (key === "\r") out("\r\n");
		else if (key >= " ") out(key);
	}
}

main().catch((e) => {
	process.stderr.write(`fake-cli: ${e?.stack ?? e}\n`);
	finish(70, "crash");
});
