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
// With no hook at all (for the OS layer): `z` runs a command (a shell
// child) for HERMES_FAKE_TOOL_MS (4000), `b` keeps a core busy as long.
// `a` is a tool call the way Antigravity makes one: PreToolUse (run_command),
// then it waits for the person's y/n without reporting that it waits; `y`
// runs the command (a shell child, as long as `z`) and then PostToolUse.
//
// As HERMES_FAKE_AGENT=antigravity, with no --settings, the hooks come from
// `.agents/hooks.json` in the folder it runs in, in Antigravity's shape: one
// entry per owner ({"enabled": true, "<Event>": [...]}), tool events as
// groups with a matcher, the others as flat lists of handlers.
//
// In the `prompts` mode (F21, F27) those keys are plain text instead: a line
// of typed text followed by Enter is a prompt too. A prompt of the form
// `work <ms>` keeps the agent on its turn for that long first; keys typed
// meanwhile are queued and read only after the turn, as the real CLI does
// (the Review Desk must not type into a working agent).
//
// Transcript (for the context gauge, F14): with HERMES_FAKE_DIR set, the
// conversation's transcript is `<HERMES_FAKE_DIR>/transcripts/<id>.jsonl`,
// and that is the `transcript_path` every hook receives (without it, a
// made-up path under /fixture-home). Keys in the TUI write to it like the
// real CLI does after a model call or a compaction:
//   c  one assistant record whose `message.usage` is read from
//      `<HERMES_FAKE_DIR>/usage-next.json` ({ input_tokens,
//      cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
//      model, isSidechain }); a default when the file is missing
//   k  one `system`/`compact_boundary` record (trigger "manual")
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
//   rate-limit    start, do some "work" in its folder (a new src/login.ts, a
//                 changed README.md), report its limit windows through the
//                 settings file's status line (five_hour used up, resetting
//                 at <HERMES_FAKE_DIR>/resets_at, epoch seconds, or in two
//                 hours) and end the turn on its usage limit: the
//                 `StopFailure` hooks with `error: "rate_limit"`, as Claude
//                 Code 2.1.283 does
//   server-error  the same, but the turn ends on `error: "server_error"` —
//                 not a limit (the negative control for the limit checks)
//   ask-at-start  once ready, ask permission for a command at once (the
//                 `PermissionRequest` hooks) and wait for y/n — an agent that
//                 is blocked on the person as soon as it starts or resumes
//                 (the morning view)
//
// In any mode but `prompts`, the key `r` stands for "the limit reset and the
// agent goes on": the `Notification` hooks with `quota_auto_resume_fired`;
// the key `L` for "another turn ended on the usage limit" (the status line
// and the `StopFailure` hooks again, no file edits).
//
// Hook groups with a `matcher` only run when it matches, like the real CLI
// (the error of a StopFailure, the notification type of a Notification, the
// tool of a tool event).
//
// Models, effort and accounts (2.0 launch contract). The fake takes the
// model and effort flags of the agent it stands in for (`--model`, `-m`,
// `--effort`, `-c model_reasoning_effort="…"`), reports the model it runs in
// its SessionStart hook (`model`) and status line (`model.id`), and answers
// the capability probes like the real CLIs (verbatim shapes from the
// capability matrix):
//   claude `auth status --json`   {"loggedIn":…,"subscriptionType":…}
//   codex  `login status`         "Logged in using ChatGPT" / "Not logged in"
//   codex  `debug models --bundled` a small model catalog (JSON)
//   agy    `models`               "slug<TAB>Name" lines, or "Authentication required"
//   `auth login` / `login`        signs the profile in (see below) and exits 0
// Sign-in per profile: with the agent's profile variable set
// (CLAUDE_CONFIG_DIR, CODEX_HOME, …) the state is the file `.fake-auth` in
// that folder ("in"; missing = signed out, like an empty profile); without
// it, HERMES_FAKE_AUTH / <HERMES_FAKE_DIR>/auth-<agent> as before. A login
// writes "in" there.
// (`refuse-signed-out` as a mode word refuses a signed-out default profile too.)
// A refused launch: a model listed in HERMES_FAKE_REJECT_MODELS or
// <HERMES_FAKE_DIR>/reject-models-<agent> (comma-separated; "*" = every
// model but the default), or a signed-out profile, makes the fake print the
// vendor's own refusal: Claude Code's "There's an issue with the selected
// model (…)" / "Not logged in · Please run /login" and then sit idle like
// the real TUI; Codex's 404 inside its minute-long "Reconnecting... n/5"
// loop; Antigravity's "error: invalid model selection …" and exit 1. It
// runs no hook and no turn, so a test can tell that nothing ran.
// A resumed conversation is refused like the real TUIs refuse it: the
// history is replayed and "ready" shown, and the refusal comes only when
// the first message is sent (Enter), since a resumed CLI asks its model
// nothing before that. Like Claude Code 2.1 signed out, it runs its
// SessionStart hooks at the start and its UserPromptSubmit hooks with that
// message, right before the refusal (nothing else runs).
//
// Conversation history (with HERMES_FAKE_DIR): what a conversation showed —
// its prompt, the answers of `quote-errors`, the prompts typed, a refusal —
// is kept in `<HERMES_FAKE_DIR>/history/<id>.txt` and replayed on resume,
// as the real CLIs replay a resumed conversation.
// Two more mode words for the refusal-safety scenario:
//   wrap-prompt   the first prompt is drawn in rows of at most 40
//                 characters (word-wrapped), as a TUI in a narrow pane does
//   quote-errors  once ready, the agent "answers" with its reply mark
//                 (Claude Code `⏺`, Codex `•`) quoting its CLI's own refusal
//                 words, as an agent explaining an error does
//
// Every launch is recorded to `<HERMES_FAKE_DIR>/launch-<n>.json` (argv, cwd,
// the Hermes environment it saw, the settings file's contents, which hooks
// ran, how it ended) when HERMES_FAKE_DIR is set.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RECORD_DIR = process.env.HERMES_FAKE_DIR || null;
// Keys `z` (a command) and `b` (CPU): how long they last, and whether the
// command runs through a shell as real agents run theirs. HERMES_FAKE_TOOL_SHELL=0
// runs it without one — the negative control of the OS-layer scenario.
const TOOL_MS = Number(process.env.HERMES_FAKE_TOOL_MS || 4000);
const TOOL_IN_SHELL = process.env.HERMES_FAKE_TOOL_SHELL !== "0";
function toolCommand() {
	const secs = Math.max(1, Math.ceil(TOOL_MS / 1000));
	const sleeper = [process.execPath, "-e", `setTimeout(() => {}, ${TOOL_MS})`];
	if (!TOOL_IN_SHELL) return sleeper;
	if (process.platform === "win32") return ["cmd.exe", "/d", "/c", `ping -n ${secs + 1} 127.0.0.1 >nul & rem`];
	return ["/bin/sh", "-c", `sleep ${secs}; true`];
}
function runChild(argv, doneText) {
	const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", windowsHide: true });
	child.on("exit", () => process.stdout.write(`fake-cli: ${doneText}\r\n`));
	child.on("error", () => {});
}
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
	// Set by a launch prefix in a test (`env HERMES_PREFIX_PROOF=... claude`).
	"HERMES_PREFIX_PROOF",
];

function parseArgs(argv) {
	const out = { sessionId: null, resumeId: null, settings: null, permissionMode: null, channels: [], model: null, effort: null, config: [], positional: [], raw: argv };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--model" || a === "-m") out.model = next();
		else if (a === "--effort" || a === "--reasoning-effort") out.effort = next();
		else if (a === "-c" || a === "--config") {
			const kv = next() ?? "";
			out.config.push(kv);
			const m = kv.match(/^model_reasoning_effort=\"?([^"]*)\"?$/);
			if (m) out.effort = m[1];
		} else if (a === "--session-id") out.sessionId = next();
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

/** The profile variable of the agent this fake stands in for. */
const PROFILE_ENV = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", gemini: "GEMINI_CLI_HOME", copilot: "COPILOT_HOME", goose: "GOOSE_PATH_ROOT", "hermes-agent": "HERMES_HOME" }[FAKE_AGENT] ?? null;
const profileDir = () => (PROFILE_ENV && process.env[PROFILE_ENV] ? process.env[PROFILE_ENV] : null);

/** Signed in: per profile folder when one is set, else the fake's setting. */
function isSignedIn() {
	const dir = profileDir();
	if (dir) {
		try {
			return fs.readFileSync(path.join(dir, ".fake-auth"), "utf8").trim() === "in";
		} catch {
			return false; // an empty profile is signed out, like the real CLI
		}
	}
	return fakeSetting("HERMES_FAKE_AUTH", "auth", "in") !== "out";
}

/** The models this fake refuses ("*": every one but the default). */
function refusedModels() {
	return fakeSetting("HERMES_FAKE_REJECT_MODELS", "reject-models", "")
		.split(",")
		.map((m) => m.trim())
		.filter(Boolean);
}

/** A small model catalog in Codex's `debug models` shape. */
const CODEX_CATALOG = {
	models: [
		{ slug: "gpt-fake-terra", display_name: "GPT-Fake-Terra", description: "Balanced fake model.", default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })), visibility: "list" },
		{ slug: "gpt-fake-luna", display_name: "GPT-Fake-Luna", description: "Fast fake model.", default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })), visibility: "list" },
		{ slug: "gpt-fake-old", display_name: "GPT-Fake-Old", description: "Older fake model.", default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })), visibility: "list" },
		{ slug: "gpt-fake-hidden", display_name: "Hidden", supported_reasoning_levels: [], visibility: "hide" },
	],
};

function answerDoctorProbe(argv) {
	const is = (...words) => words.length === argv.length && words.every((w, i) => w === argv[i]);
	if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
		process.stdout.write(`${fakeSetting("HERMES_FAKE_VERSION", "version", "0.1.0")} (fake ${FAKE_AGENT})\n`);
		return 0;
	}
	if (is("auth", "status", "--json")) {
		const plan = fakeSetting("HERMES_FAKE_PLAN", "plan", "max");
		const signedIn = isSignedIn();
		process.stdout.write(
			JSON.stringify(
				signedIn
					? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", configDirectory: profileDir() ?? "~/.claude", email: "fake@example.com", orgName: "Fake Org", subscriptionType: plan }
					: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
			) + "\n",
		);
		return signedIn ? 0 : 1;
	}
	if (is("login", "status")) {
		const signedIn = isSignedIn();
		process.stdout.write(signedIn ? "Logged in using ChatGPT\n" : "Not logged in\n");
		return signedIn ? 0 : 1;
	}
	if (is("debug", "models", "--bundled") || is("debug", "models")) {
		process.stdout.write(JSON.stringify(CODEX_CATALOG) + "\n");
		return 0;
	}
	if (is("models")) {
		if (!isSignedIn()) {
			process.stdout.write("Authentication required. Please visit the URL to log in:\nhttps://accounts.example.com/o/oauth2/auth?fake=1\n");
			return 1;
		}
		process.stdout.write("Fetching available models...\ngemini-fake-flash-low\tGemini Fake Flash (Low)\ngemini-fake-pro-high\tGemini Fake Pro (High)\nclaude-fake-sonnet\tClaude Fake Sonnet (Thinking)\n");
		return 0;
	}
	if (is("auth", "login") || is("login")) {
		// A sign-in in the profile Hermes created: remember it there.
		const dir = profileDir();
		process.stdout.write(`Signing in to fake ${FAKE_AGENT}… done.\n`);
		if (dir) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, ".fake-auth"), "in\n");
		}
		if (RECORD_DIR) {
			fs.mkdirSync(RECORD_DIR, { recursive: true });
			fs.writeFileSync(
				path.join(RECORD_DIR, `login-${Date.now()}-${process.pid}.json`),
				JSON.stringify({ kind: "fake-cli-login", agent: FAKE_AGENT, argv, profileEnv: PROFILE_ENV, profileDir: dir, hermesSession: process.env.HERMES_SESSION_ID ?? null }, null, 2) + "\n",
			);
		}
		return 0;
	}
	// Codex's app server (Hermes asks it which hook hashes to trust): the
	// fake has none, and says so at once.
	if (argv[0] === "app-server") {
		process.stderr.write("fake-cli: no app server here\n");
		return 2;
	}
	if (AUTH_CHECKS.some((c) => c.length === argv.length && c.every((w, i) => w === argv[i]))) {
		const signedIn = isSignedIn();
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
const TRANSCRIPT_DIR = RECORD_DIR ? path.join(RECORD_DIR, "transcripts") : null;
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
} else if (FAKE_AGENT === "antigravity") {
	const file = path.join(process.cwd(), ".agents", "hooks.json");
	try {
		settings = agyHooksAsSettings(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (e) {
		if (e.code !== "ENOENT") settingsError = String(e.message || e);
	}
}

/**
 * Antigravity's `.agents/hooks.json` as the settings shape the rest of this
 * fake reads: every enabled entry's events, a flat handler list becoming one
 * group without a matcher. A group where a flat list belongs (or the other
 * way round) is dropped, as agy silently runs nothing for it.
 */
function agyHooksAsSettings(file) {
	const hooks = {};
	const toolEvent = (event) => event === "PreToolUse" || event === "PostToolUse";
	for (const entry of Object.values(file ?? {})) {
		if (!entry || typeof entry !== "object" || entry.enabled === false) continue;
		for (const [event, list] of Object.entries(entry)) {
			if (event === "enabled" || !Array.isArray(list)) continue;
			const groups = toolEvent(event)
				? list.filter((g) => g && typeof g.matcher === "string" && Array.isArray(g.hooks))
				: list.every((h) => h && h.type === "command")
					? [{ hooks: list }]
					: [];
			(hooks[event] ??= []).push(...groups);
		}
	}
	return { hooks };
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
	model: args.model,
	effort: args.effort,
	profileDir: profileDir(),
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
		return matcher.split("|").map((m) => m.trim()).includes(value);
	}
}

/**
 * The command hooks configured for `event`. Like Claude Code, an entry's
 * `matcher` (absent, "" or "*": everything; otherwise a regex, or exact
 * names joined by "|") is tested against the tool name for tool events, the
 * error of a StopFailure and the type of a Notification.
 */
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
		transcript_path: transcriptPath(),
		cwd: process.cwd(),
		permission_mode: args.permissionMode || "default",
		...(event === "SessionStart" ? { model: reportedModel() } : {}),
		...extra,
	};
	const results = [];
	for (const hook of hookCommands(event, payload)) results.push(await runHook(hook, payload));
	record.hooksRan.push({ event, tool: extra.tool_name, results });
	note("hooks", { event, count: results.length });
	return results;
}

// ─── Terminal notifications (the fallback path, no hook involved) ────

const BEL = "\x07";
const nonceFromEnv = () => process.env.HERMES_SIGNAL_NONCE || "";
/** The in-band marker a Hermes hook makes Claude print over SSH. */
const marker = (nonce, event) => `${ESC}]777;notify;hermes-signal;v1:${nonce}:${event}${BEL}`;
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
		model: { id: reportedModel(), display_name: "Fake" },
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

// ─── Transcript (Claude Code's JSONL shape) ──────────────────────────

function transcriptPath() {
	return TRANSCRIPT_DIR ? path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`) : `/fixture-home/.fake/${sessionId}.jsonl`;
}

let transcriptLines = 0;
function appendTranscript(record) {
	if (!TRANSCRIPT_DIR) return false;
	fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
	transcriptLines++;
	const line = {
		uuid: `fake-${process.pid}-${transcriptLines}`,
		sessionId,
		cwd: process.cwd(),
		timestamp: new Date().toISOString(),
		...record,
	};
	fs.appendFileSync(transcriptPath(), JSON.stringify(line) + "\n");
	return true;
}

function nextUsage() {
	const fallback = { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 50, model: "claude-fake-1" };
	if (!RECORD_DIR) return fallback;
	try {
		return { ...fallback, ...JSON.parse(fs.readFileSync(path.join(RECORD_DIR, "usage-next.json"), "utf8")) };
	} catch {
		return fallback;
	}
}

function writeUsage() {
	const u = nextUsage();
	const ok = appendTranscript({
		type: "assistant",
		isSidechain: u.isSidechain === true,
		message: {
			id: `msg_fake_${transcriptLines + 1}`,
			type: "message",
			role: "assistant",
			model: u.model,
			content: [{ type: "text", text: "fake reply" }],
			stop_reason: "end_turn",
			usage: {
				input_tokens: u.input_tokens,
				cache_creation_input_tokens: u.cache_creation_input_tokens,
				cache_read_input_tokens: u.cache_read_input_tokens,
				output_tokens: u.output_tokens,
			},
		},
	});
	note("usage", { written: ok, usage: u });
	out(ok ? `\r\nfake-cli: model call (${u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens} input tokens)\r\n` : "\r\nfake-cli: no transcript folder\r\n");
}

function writeCompaction() {
	const ok = appendTranscript({
		type: "system",
		subtype: "compact_boundary",
		content: "Conversation compacted",
		isMeta: false,
		level: "info",
		compactMetadata: { trigger: "manual", preTokens: 150000 },
	});
	note("compact", { written: ok });
	out(ok ? "\r\nfake-cli: context compacted\r\n" : "\r\nfake-cli: no transcript folder\r\n");
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

/** The model the fake says it runs: the one it was started with, else its default. */
function reportedModel() {
	return args.model || process.env.HERMES_FAKE_DEFAULT_MODEL || "fake-default-model";
}

/** Refuse the launch the way the real CLI does (see the header). */
async function refuse(kind) {
	note("refused", { kind, model: args.model });
	const model = args.model ?? "default";
	if (FAKE_AGENT === "codex") {
		const line =
			kind === "signed-out"
				? "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"
				: `{"type":"error","message":"stream error: unexpected status 404 Not Found: The model \`${model}\` does not exist or you do not have access to it."}`;
		// Codex retries about five times over a minute before it gives up.
		for (let n = 1; n <= 30; n++) {
			out(`${ESC}[2K\rReconnecting... ${Math.min(n, 5)}/5\r\n`);
			if (n === 2) out(`${line}\r\n`);
			await new Promise((r) => setTimeout(r, 2000));
		}
		finish(1, `refused-${kind}`);
		return;
	}
	if (FAKE_AGENT === "antigravity") {
		out(
			kind === "signed-out"
				? "Authentication required. Please visit the URL to log in:\r\nhttps://accounts.example.com/o/oauth2/auth?fake=1\r\n"
				: `error: invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized as a known model or custom model in settings\r\nAvailable models:\r\n  Gemini Fake Flash (Low)\r\n`,
		);
		finish(1, `refused-${kind}`);
		return;
	}
	// Claude Code: the message, then the idle TUI (nothing is sent). A
	// conversation keeps the refusal in its history.
	const said =
		kind === "signed-out"
			? "Not logged in · Please run /login"
			: `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run --model to pick a different model.`;
	if (resumed) remember([said]);
	out(kind === "signed-out" ? `\r\n${said}\r\n` : `\r\n"${model}" isn't described by this version's model catalog; update Claude Code, or map it with behavesAs…\r\n${said}\r\n`);
	out("> ");
	for (;;) {
		const key = await nextKey();
		if (key === null || key === "\x03" || key === "q") {
			finish(1, `refused-${kind}`);
			return;
		}
	}
}

/** The conversation's history file (none without HERMES_FAKE_DIR). */
const historyFile = RECORD_DIR ? path.join(RECORD_DIR, "history", `${sessionId}.txt`) : null;
function remember(lines) {
	if (!historyFile) return;
	fs.mkdirSync(path.dirname(historyFile), { recursive: true });
	fs.appendFileSync(historyFile, lines.map((l) => `${l}\n`).join(""));
}
function history() {
	try {
		return historyFile ? fs.readFileSync(historyFile, "utf8").split("\n").filter(Boolean) : [];
	} catch {
		return [];
	}
}

/** Word-wrap at `width` columns, as a TUI draws a prompt in a narrow pane. */
function wrapRows(text, width = 40) {
	const rows = [];
	let row = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (row && row.length + 1 + word.length > width) {
			rows.push(row);
			row = word;
		} else row = row ? `${row} ${word}` : word;
	}
	if (row) rows.push(row);
	return rows;
}

/** What `quote-errors` answers: the CLI's refusal words, as a reply. */
function quotedErrors() {
	const mark = FAKE_AGENT === "codex" ? "\u2022" : "\u23fa";
	return FAKE_AGENT === "codex"
		? [`${mark} ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header`, `${mark} Not logged in`]
		: [`${mark} Not logged in · Please run /login`, `${mark} There's an issue with the selected model (opus). It may not exist or you may not have access to it.`];
}

/** Which refusal this launch gets, if any (see the header). */
function refusalKind() {
	const refused = refusedModels();
	if (args.model && (refused.includes(args.model) || refused.includes("*"))) return "model";
	// Signed out: refused in a profile Hermes added (an empty profile is
	// signed out), or anywhere with the mode word `refuse-signed-out`.
	if ((profileDir() || has("refuse-signed-out")) && !isSignedIn()) return "signed-out";
	return null;
}

async function main() {
	note("start", { sessionId, resumed });

	const refusal = refusalKind();
	if (refusal && !resumed) {
		await refuse(refusal);
		return;
	}

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
	if (resumed) {
		const earlier = history();
		if (earlier.length) out(`fake-cli: earlier in this conversation:\r\n${earlier.map((l) => `${l}\r\n`).join("")}`);
		note("replayed", { lines: earlier.length });
	}
	if (record.prompt) {
		const rows = has("wrap-prompt") ? wrapRows(record.prompt) : [`prompt: ${record.prompt}`];
		out(rows.map((r) => `${r}\r\n`).join(""));
		remember(rows);
	}
	if (refusal) {
		// A resumed conversation: refused at the first message.
		await runHooks("SessionStart", { source: "resume" });
		out("fake-cli: ready\r\n");
		let typed = "";
		for (;;) {
			const key = await nextKey();
			if (key === null || key === "\x03") {
				finish(1, "interrupted-before-refusal");
				return;
			}
			if (key === "\r" || key === "\n") break;
			typed += key;
			out(key);
		}
		await runHooks("UserPromptSubmit", { prompt: typed });
		await refuse(refusal);
		return;
	}
	out("fake-cli: type q to quit\r\n");
	if (has("no-start-hook")) note("start-hook-skipped");
	else await runHooks("SessionStart", { source: resumed ? "resume" : "startup" });
	out(`fake-cli: ready\r\n`);
	if (has("quote-errors")) {
		const reply = quotedErrors();
		out(`\r\n${reply.map((l) => `${l}\r\n`).join("")}`);
		remember(reply);
		note("quoted-errors");
	}
	if (has("ask-at-start")) {
		out("\r\nfake-cli: asking permission for Bash: npm install  [y/n]\r\n");
		await runHooks("PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm install" } });
		for (;;) {
			const answer = await nextKey();
			if (answer === null || answer === "\x03") {
				await quit("interrupted-at-permission");
				return;
			}
			if (answer === "y" || answer === "Y") {
				out("fake-cli: allowed\r\n");
				await runHooks("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm install" }, tool_response: {} });
				break;
			}
			if (answer === "n" || answer === "N") {
				out("fake-cli: denied\r\n");
				await runHooks("PermissionDenied", { tool_name: "Bash" });
				break;
			}
		}
	}
	if (mode === "rate-limit") await workThenFail("rate_limit");
	else if (mode === "server-error") await workThenFail("server_error");

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
				// An API error that is not a usage limit (for that, `L`).
				out("\r\nfake-cli: turn failed\r\n");
				await runHooks("StopFailure", { error: "server_error", error_details: "500 Internal Server Error" });
				continue;
			case "r":
				// N19: the usage limit reset and the agent goes on.
				await runHooks("Notification", {
					notification_type: "quota_auto_resume_fired",
					message: "Usage limit reset, continuing automatically",
				});
				out("\r\nfake-cli: limit reset, continuing\r\n");
				continue;
			case "L":
				// N19: another turn ends on the usage limit.
				await failTurn("rate_limit");
				continue;
			case "c":
				// F14: one model call in the transcript (its usage is read
				// from <HERMES_FAKE_DIR>/usage-next.json when present).
				writeUsage();
				continue;
			case "k":
				// F14: a compaction boundary in the transcript.
				writeCompaction();
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
			case "z":
				// A tool command running under the agent, with no hook at all: what
				// the OS layer sees (a shell child) and nothing else does.
				out(`\r\nfake-cli: running a command for ${TOOL_MS} ms (no hook)\r\n`);
				note("tool", { shell: TOOL_IN_SHELL, ms: TOOL_MS });
				runChild(toolCommand(), "command finished");
				continue;
			case "a": {
				// Antigravity's tool call: announced, then a wait for the
				// person that no hook reports.
				out("\r\nfake-cli: run_command wants to run a command  [y/n]\r\n");
				await runHooks("PreToolUse", { tool_name: "run_command", tool_input: { CommandLine: "make test" } });
				for (;;) {
					const answer = await nextKey();
					if (answer === null || answer === "\x03") {
						await quit("interrupted-at-approval");
						return;
					}
					if (answer === "y" || answer === "Y") {
						out(`fake-cli: approved, running the command for ${TOOL_MS} ms\r\n`);
						note("tool", { shell: TOOL_IN_SHELL, ms: TOOL_MS, approved: true });
						const argv = toolCommand();
						await new Promise((resolve) => {
							const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", windowsHide: true });
							child.on("exit", resolve);
							child.on("error", resolve);
						});
						out("fake-cli: command finished\r\n");
						await runHooks("PostToolUse", { tool_name: "run_command", tool_input: { CommandLine: "make test" }, tool_response: {} });
						break;
					}
					if (answer === "n" || answer === "N") {
						out("fake-cli: denied\r\n");
						break;
					}
				}
				continue;
			}
			case "b":
				// The agent keeping a core busy (a child that is not a shell, spinning).
				out(`\r\nfake-cli: busy for ${TOOL_MS} ms (no hook)\r\n`);
				note("busy", { ms: TOOL_MS });
				runChild([process.execPath, "-e", `const t=Date.now();while(Date.now()-t<${TOOL_MS}){}`], "no longer busy");
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
	remember([`> ${text.split("\n")[0].slice(0, 200)}`]);
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
