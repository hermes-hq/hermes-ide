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
// `<HERMES_FAKE_DIR>/mode` (so a test can change it between app launches):
//   normal        start at once (default)
//   trust-prompt  show a "Do you trust the files in this folder?" dialog and
//                 wait for a key before doing anything else — what a vendor
//                 does in a folder it has not seen
//   resume-fails  reject `--resume` at once (exit 1), as a vendor does for an
//                 id it does not know; a fresh start still works
//   ignore-resume accept `--resume` but start a new conversation under a new
//                 id anyway — a broken vendor, used as the negative control
//                 that proves the resume checks can fail
//   rate-limit    start, do some "work" in its folder (a new src/login.ts, a
//                 changed README.md), report its limit windows through the
//                 settings file's status line (five_hour used up, resetting
//                 at <HERMES_FAKE_DIR>/resets_at, epoch seconds, or in two
//                 hours) and end the turn on its usage limit: the
//                 `StopFailure` hooks with `error: "rate_limit"`, as Claude
//                 Code 2.1.283 does
//   server-error  the same, but the turn ends on `error: "server_error"` —
//                 not a limit (the negative control for the limit checks)
//
// In any mode, the key `r` stands for "the limit reset and the agent goes
// on": the `Notification` hooks with `quota_auto_resume_fired`; the key `l`
// for "another turn ended on the usage limit" (the status line and the
// `StopFailure` hooks again, no file edits).
//
// Hook groups with a `matcher` only run when it matches, like the real CLI
// (the error of a StopFailure, the notification type of a Notification, the
// tool of a tool event).
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
	// Raw mode delivers Ctrl-C as a byte; this covers a real signal too.
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

/** The payload field a hook group's matcher is tested against. */
function matcherField(event, payload) {
	if (event === "StopFailure") return payload.error;
	if (event === "Notification") return payload.notification_type;
	if (event === "SessionStart") return payload.source;
	return payload.tool_name;
}

function matches(matcher, value) {
	if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
	if (typeof value !== "string") return false;
	try {
		return new RegExp(`^(?:${matcher})$`).test(value);
	} catch {
		return matcher === value;
	}
}

function hookCommands(event, payload = {}) {
	const groups = settings?.hooks?.[event];
	if (!Array.isArray(groups)) return [];
	const cmds = [];
	for (const g of groups) {
		if (!matches(g?.matcher, matcherField(event, payload))) continue;
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
	for (const hook of hookCommands(event, payload)) results.push(await runHook(hook, payload));
	record.hooksRan.push({ event, results });
	note("hooks", { event, count: results.length });
	return results;
}

/** Runs the settings file's status line command with the given input, like
 *  Claude Code does after a turn. Returns what it printed, or null. */
async function runStatusLine(extra) {
	const cmd = settings?.statusLine;
	if (!cmd || cmd.type !== "command" || typeof cmd.command !== "string") {
		note("status-line", { configured: false });
		return null;
	}
	const input = {
		session_id: sessionId,
		transcript_path: `/fixture-home/.fake/${sessionId}.jsonl`,
		cwd: process.cwd(),
		model: { id: "fake-model-1", display_name: "Fake" },
		workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
		...extra,
	};
	const result = await runHook({ command: cmd.command, timeout: 5 }, input);
	record.hooksRan.push({ event: "statusLine", results: [result] });
	note("status-line", { configured: true, code: result.code });
	return result.stdout;
}

function readResetsAt() {
	const fromEnv = Number(process.env.HERMES_FAKE_RESETS_AT);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
	if (RECORD_DIR) {
		try {
			const n = Number(fs.readFileSync(path.join(RECORD_DIR, "resets_at"), "utf8").trim());
			if (Number.isFinite(n) && n > 0) return n;
		} catch {
			/* not set */
		}
	}
	return Math.floor(Date.now() / 1000) + 2 * 3600;
}

/** A turn that edits files and ends on an API error (rate-limit / server-error modes). */
async function workThenFail(error) {
	const cwd = process.cwd();
	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "src", "login.ts"), "export function login() {\n  // redirect after sign-in: work in progress\n}\n");
	const readme = path.join(cwd, "README.md");
	if (fs.existsSync(readme)) fs.appendFileSync(readme, "\nLogin: redirect after sign-in (in progress).\n");
	note("work", { files: ["src/login.ts", "README.md"] });
	out("fake-cli: editing src/login.ts, README.md\r\n");
	await failTurn(error);
}

/** The end of a turn on an API error: the status line's windows, then the StopFailure hooks. */
async function failTurn(error) {
	const resetsAt = readResetsAt();
	await runStatusLine({
		rate_limits: {
			five_hour: { used_percentage: 100, resets_at: resetsAt },
			seven_day: { used_percentage: 40, resets_at: resetsAt + 4 * 86400 },
		},
	});
	await runHooks("StopFailure", {
		error,
		error_details: error === "rate_limit" ? "429 Too Many Requests" : "500 Internal Server Error",
		last_assistant_message: error === "rate_limit" ? "API Error: Rate limit reached" : "API Error: 500",
	});
	out(error === "rate_limit" ? "fake-cli: usage limit reached\r\n" : "fake-cli: the API failed\r\n");
}

// ─── Behaviour ───────────────────────────────────────────────────────

const resumed = !!args.resumeId && mode !== "ignore-resume";
const sessionId = (resumed ? args.resumeId : args.sessionId) || randomUUID();
let quitting = false;

async function quit(why) {
	if (quitting) return;
	quitting = true;
	out(`\r\nfake-cli: bye (${why})\r\n`);
	await runHooks("SessionEnd", { reason: why });
	finish(0, why);
}

async function main() {
	note("start", { sessionId, resumed });

	if (resumed && mode === "resume-fails") {
		process.stderr.write(`No conversation found with session ID: ${args.resumeId}\n`);
		finish(1, "resume-rejected");
		return;
	}

	if (mode === "trust-prompt") {
		out(`${ESC}[?25l`);
		out("\r\n┌──────────────────────────────────────────────────────┐\r\n");
		out("│ Do you trust the files in this folder?               │\r\n");
		out(`│ ${process.cwd().slice(0, 52).padEnd(52)} │\r\n`);
		out("│                                                      │\r\n");
		out("│ Accessing untrusted files may pose security risks.   │\r\n");
		out("│ [y] Yes, proceed    [n] No, exit                     │\r\n");
		out("└──────────────────────────────────────────────────────┘\r\n");
		note("trust-prompt-shown");
		for (;;) {
			const key = await nextKey();
			if (key === null) {
				finish(1, "stdin-closed-at-trust-prompt");
				return;
			}
			if (key === "\x03") {
				note("trust-prompt-interrupted");
				finish(130, "ctrl-c-at-trust-prompt");
				return;
			}
			if (key === "y" || key === "Y" || key === "\r" || key === "\n") {
				note("trust-prompt-accepted");
				out("Trusted. Starting…\r\n");
				break;
			}
			if (key === "n" || key === "N") {
				note("trust-prompt-declined");
				finish(0, "declined-trust");
				return;
			}
		}
	}

	out(`\r\nfake-cli 0.1 · session ${sessionId} (${resumed ? `resumed from ${args.resumeId}` : "new"})\r\n`);
	if (record.prompt) out(`prompt: ${record.prompt}\r\n`);
	out("fake-cli: type q to quit\r\n");
	await runHooks("SessionStart", { source: resumed ? "resume" : "startup" });
	out(`fake-cli: ready\r\n`);
	if (mode === "rate-limit") await workThenFail("rate_limit");
	else if (mode === "server-error") await workThenFail("server_error");

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
		if (key === "r") {
			await runHooks("Notification", {
				notification_type: "quota_auto_resume_fired",
				message: "Usage limit reset, continuing automatically",
			});
			out("\r\nfake-cli: limit reset, continuing\r\n");
			continue;
		}
		if (key === "l") {
			await failTurn("rate_limit");
			continue;
		}
		if (key === "\r") out("\r\n");
		else if (key >= " ") out(key);
	}
}

main().catch((e) => {
	process.stderr.write(`fake-cli: ${e?.stack ?? e}\n`);
	finish(70, "crash");
});
