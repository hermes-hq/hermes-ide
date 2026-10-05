#!/usr/bin/env node
// Fake terminal agent: deterministic, no network, no accounts.
//
// Plays a scenario file (see scenarios/) to a terminal: prints a TUI, emits
// notifications (OSC 2/9/9;4/99/777, BEL), asks for approval and exits with
// the code the scenario chooses. Everything it receives (keys, pastes,
// resizes, signals) and the environment it saw goes to an optional JSONL log,
// so a test can check what the terminal really delivered.
//
//   node fake-agent.mjs --scenario approval [--log run.jsonl] [--speed 0]
//
// --scenario takes a path, or a bare name resolved against ./scenarios/.
// --speed scales every sleep (0 = no sleeps; waits for input are unaffected).
//
// Exit codes: the scenario's own, 124 on a waitKey/waitPaste/waitResize
// timeout, 130 on Ctrl-C or SIGINT, 143 on SIGTERM, 129 on SIGHUP, 2 on bad usage.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) args[a.slice(2)] = "1";
		else {
			args[a.slice(2)] = next;
			i++;
		}
	}
	return args;
}

function resolveScenario(value) {
	if (!value) return null;
	if (fs.existsSync(value)) return value;
	const named = path.join(HERE, "scenarios", value.endsWith(".json") ? value : `${value}.json`);
	return fs.existsSync(named) ? named : null;
}

const args = parseArgs(process.argv.slice(2));
const scenarioFile = resolveScenario(args.scenario);
if (!scenarioFile) {
	process.stderr.write(`fake-agent: scenario not found: ${args.scenario ?? "(none given)"}\n`);
	process.stderr.write("usage: fake-agent.mjs --scenario <file|name> [--log <file.jsonl>] [--speed <n>]\n");
	process.exit(2);
}
const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
const speed = args.speed === undefined ? 1 : Number(args.speed);
const logFd = args.log ? fs.openSync(args.log, "a") : null;
const t0 = Date.now();
const log = (o) => {
	if (logFd !== null) fs.writeSync(logFd, JSON.stringify({ t: Date.now() - t0, ...o }) + "\n");
};
const out = (s) => process.stdout.write(s);

const ESC = "\x1b";
const BEL = "\x07";
const ST = ESC + "\\";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const term = (st) => (st ? ST : BEL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));

let altOn = false;
let restoreOnExit = true;
const restore = () => {
	if (!restoreOnExit) return;
	if (altOn) out(`${ESC}[?1049l`);
	out(`${ESC}[?25h${ESC}[?2004l${ESC}[?1004l`);
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
};
let finishing = false;
const finish = (code) => {
	finishing = true;
	log({ ev: "exit", code });
	restore();
	process.exitCode = code;
	// Let stdout drain before leaving; a terminal must see every byte.
	process.stdout.write("", () => process.exit(code));
};

// ─── Input ───────────────────────────────────────────────────────────

let inbuf = "";
let waiter = null;
const wake = () => {
	if (waiter) {
		const w = waiter;
		waiter = null;
		w();
	}
};
let resizeWaiter = null;

process.on("SIGWINCH", () => {
	const size = { cols: process.stdout.columns, rows: process.stdout.rows };
	log({ ev: "resize", ...size });
	if (resizeWaiter) {
		const w = resizeWaiter;
		resizeWaiter = null;
		w(size);
	}
});
process.on("SIGTERM", () => {
	log({ ev: "signal", sig: "SIGTERM" });
	finish(143);
});
process.on("SIGHUP", () => {
	log({ ev: "signal", sig: "SIGHUP" });
	finish(129);
});
// An interrupt sent as a signal rather than typed (the way Hermes stops an
// agent at a spend cap on macOS and Linux). Ignored once the agent is
// already leaving, e.g. after a typed Ctrl-C that also raised one.
process.on("SIGINT", () => {
	if (finishing) return;
	log({ ev: "signal", sig: "SIGINT" });
	finish(130);
});

// Breadcrumb for a launch the shell reported "Stopped" (macOS CI): this
// process and its shell with their process groups and the terminal's
// foreground group, right before the first change to the terminal's
// settings (a process outside the foreground group is stopped there).
if (process.stdin.isTTY && logFd !== null && process.platform !== "win32") {
	const ps = spawnSync("ps", ["-o", "pid=,ppid=,pgid=,tpgid=,stat=,comm=", "-p", `${process.pid},${process.ppid}`], { encoding: "utf8", timeout: 2000 });
	log({ ev: "tty-owner", ps: (ps.stdout ?? "").trim().split("\n").map((l) => l.trim().replace(/\s+/g, " ")) });
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (b) => {
	const s = b.toString("latin1");
	log({ ev: "input", hex: b.toString("hex") });
	// Ctrl-C interrupts, except inside a bracketed paste (where it is data).
	const outsidePastes = (inbuf + s).replace(/\x1b\[200~[\s\S]*?(\x1b\[201~|$)/g, "");
	if (outsidePastes.includes("\x03")) {
		log({ ev: "ctrl-c" });
		finish(130);
		return;
	}
	inbuf += s;
	wake();
});
// Not a TTY and nothing more will come: let pending waits time out normally.
process.stdin.on("end", () => log({ ev: "stdin-end" }));

/** One key: a single character, or a whole CSI/SS3 escape sequence. */
function takeKey() {
	if (!inbuf) return null;
	if (inbuf[0] === ESC) {
		// An unfinished CSI or SS3 sequence: wait for the rest of it.
		if (/^\x1b(\[[0-9;?]*[ -/]*|O)$/.test(inbuf)) return null;
		const m = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/s.exec(inbuf);
		const k = m[0];
		inbuf = inbuf.slice(k.length);
		return k;
	}
	const k = inbuf[0];
	inbuf = inbuf.slice(1);
	return k;
}

/** Resolve when `ready()` returns non-null, or null after timeoutMs. */
function waitInput(ready, timeoutMs) {
	return new Promise((resolve) => {
		const first = ready();
		if (first !== null) return resolve(first);
		const to = timeoutMs ? setTimeout(() => {
			waiter = null;
			resolve(null);
		}, timeoutMs) : null;
		const check = () => {
			const v = ready();
			if (v !== null) {
				if (to) clearTimeout(to);
				resolve(v);
			} else waiter = check;
		};
		waiter = check;
	});
}

function takePaste() {
	const start = inbuf.indexOf(PASTE_START);
	if (start < 0) return null;
	const end = inbuf.indexOf(PASTE_END, start);
	if (end < 0) return null;
	const text = inbuf.slice(start + PASTE_START.length, end);
	inbuf = inbuf.slice(end + PASTE_END.length);
	return text;
}

// ─── Steps ───────────────────────────────────────────────────────────

const steps = {
	print: (s) => out(s.text.replace(/\r?\n/g, "\r\n")),
	sleep: (s) => sleep(s.ms),
	title: (s) => out(`${ESC}]2;${s.text}${BEL}`),
	osc9: (s) => out(`${ESC}]9;${s.text}${term(s.st)}`),
	// OSC 9;4 progress. state: 0 clear, 1 set, 2 error, 3 indeterminate, 4 paused.
	progress: (s) => out(`${ESC}]9;4;${s.state};${s.pct ?? ""}${term(s.st)}`),
	osc99: (s) => {
		const id = s.id ?? "h1";
		out(`${ESC}]99;i=${id}:d=0:p=title;${s.title}${ST}`);
		out(`${ESC}]99;i=${id}:p=body;${s.body}${ST}`);
		out(`${ESC}]99;i=${id}:d=1:a=focus;${ST}`);
	},
	osc777: (s) => out(`${ESC}]777;notify;${s.title};${s.body}${term(s.st)}`),
	// An OSC 9 whose payload is `bytes` long — for buffer-limit tests.
	bigOsc: (s) => out(`${ESC}]9;${(s.fill ?? "x").repeat(s.bytes)}${term(s.st)}`),
	bell: () => out(BEL),
	raw: (s) => out(Buffer.from(s.hex, "hex")),
	// One sequence split across several writes (hex parts).
	split: async (s) => {
		for (const part of s.parts) {
			out(Buffer.from(part, "hex"));
			await sleep(s.gapMs ?? 5);
		}
	},
	altScreen: (s) => {
		altOn = s.on;
		out(`${ESC}[?1049${s.on ? "h" : "l"}`);
		if (s.on) out(`${ESC}[2J${ESC}[H`);
	},
	modes: (s) => out(`${ESC}[?2004${s.bracketedPaste ? "h" : "l"}${ESC}[?1004${s.focus ? "h" : "l"}`),
	box: (s) => {
		const w = Math.max(...s.lines.map((l) => l.length)) + 2;
		out(`\r\n╭${"─".repeat(w)}╮\r\n` + s.lines.map((l) => `│ ${l.padEnd(w - 1)}│\r\n`).join("") + `╰${"─".repeat(w)}╯\r\n`);
	},
	size: () => out(`size ${process.stdout.columns ?? "?"}x${process.stdout.rows ?? "?"}\r\n`),
	// Without onOther, a key outside `expect` is ignored (like a real prompt)
	// and the wait goes on until the same deadline.
	waitKey: async (s) => {
		const deadline = s.timeoutMs ? Date.now() + s.timeoutMs : null;
		for (;;) {
			const left = deadline === null ? 0 : Math.max(1, deadline - Date.now());
			const got = await waitInput(takeKey, left);
			log({ ev: "waitKey", got, expect: s.expect ?? null });
			if (got === null) return s.onTimeout ?? { exit: 124 };
			if (s.expect && !s.expect.includes(got)) {
				if (s.onOther) return s.onOther;
				continue;
			}
			return s.branches?.[got] ?? null;
		}
	},
	waitPaste: async (s) => {
		const got = await waitInput(takePaste, s.timeoutMs);
		log({ ev: "waitPaste", got });
		if (got === null) return s.onTimeout ?? { exit: 124 };
		out(`pasted ${got.length} chars: ${JSON.stringify(got)}\r\n`);
		return null;
	},
	waitResize: async (s) => {
		const size = await new Promise((resolve) => {
			const to = s.timeoutMs ? setTimeout(() => {
				resizeWaiter = null;
				resolve(null);
			}, s.timeoutMs) : null;
			resizeWaiter = (v) => {
				if (to) clearTimeout(to);
				resolve(v);
			};
		});
		if (size === null) return s.onTimeout ?? { exit: 124 };
		out(`resized to ${size.cols}x${size.rows}\r\n`);
		return null;
	},
	// Run a command through the platform shell in the agent's own working
	// directory, the way an agent's Bash tool does (`posix` under sh,
	// `win32` under cmd.exe). Prints the exit code; `failExit` (optional)
	// ends the scenario with that code when the command fails.
	shell: (s) => {
		const command = process.platform === "win32" ? s.win32 : s.posix;
		if (!command) {
			out(`fake-agent: no shell command for ${process.platform}\r\n`);
			return s.failExit === undefined ? null : { exit: s.failExit };
		}
		const r = spawnSync(command, { shell: true, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
		const code = r.status ?? 1;
		log({ ev: "shell", command, code, stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8").slice(0, 2000) });
		out(`fake-agent: ran ${s.label ?? command} (exit ${code})\r\n`);
		return code !== 0 && s.failExit !== undefined ? { exit: s.failExit } : null;
	},
	// Never returns: only a signal or Ctrl-C ends it.
	hang: () => new Promise(() => {}),
	// Die by a signal (SIGKILL: the shell sees exit 137).
	kill: (s) => {
		log({ ev: "kill", sig: s.signal ?? "SIGKILL" });
		process.kill(process.pid, s.signal ?? "SIGKILL");
		return new Promise(() => {});
	},
	exit: (s) => {
		if (s.restore === false) restoreOnExit = false;
		return { exit: s.code };
	},
};

log({
	ev: "start",
	scenario: scenario.name ?? path.basename(scenarioFile),
	argv: process.argv.slice(2),
	env: {
		TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
		HERMES_SESSION_ID: process.env.HERMES_SESSION_ID ?? null,
		TERM: process.env.TERM ?? null,
	},
	tty: !!process.stdout.isTTY,
	cols: process.stdout.columns ?? null,
	rows: process.stdout.rows ?? null,
});

async function run(list) {
	for (const s of list) {
		const fn = steps[s.do];
		if (!fn) {
			process.stderr.write(`fake-agent: unknown step "${s.do}"\n`);
			return 2;
		}
		log({ ev: "step", do: s.do });
		const r = await fn(s);
		if (r?.steps) {
			const x = await run(r.steps);
			if (x !== undefined) return x;
		}
		if (r?.exit !== undefined) {
			if (r.restore === false) restoreOnExit = false;
			return r.exit;
		}
	}
	return undefined;
}

finish((await run(scenario.steps)) ?? 0);
