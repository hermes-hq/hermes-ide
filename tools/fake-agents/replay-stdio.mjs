#!/usr/bin/env node
// Replays a recorded agent session (a "cassette") over stdin/stdout.
//
// One replayer for every line-delimited JSON protocol Hermes speaks:
//   - the Claude bridge (drop-in for hermes-claude-bridge.mjs, selected with
//     HERMES_BRIDGE_PATH=<this file>; same argv, same stdio contract),
//   - ACP agents (JSON-RPC 2.0),
//   - the Codex app-server (JSON-RPC 2.0).
//
//   HERMES_FAKE_CASSETTE=<file.jsonl> [HERMES_FAKE_SPEED=0] node replay-stdio.mjs [agent argv]
//
// The cassette may also be given as --cassette <file>. Of the agent's argv,
// only --session-id/--resume, --working-dir/--cwd and --model are read; they
// fill ${SESSION_ID}, ${CWD} and ${MODEL}.
//
// Cassette lines (JSON, one per line; blank lines and lines starting with //
// are skipped):
//   {"kind":"header", ...}                    metadata, ignored when replaying
//   {"kind":"label","label":"denied"}         a jump target
//   {"kind":"emit","dt":10,"line":{...}}      write one JSON line to stdout
//   {"kind":"expect","match":{"a.b":v},"timeoutMs":5000,
//     "capture":{"VAR":"path"},"branch":[{"when":{"path":v},"goto":"label"}]}
//                                             wait for a matching stdin line
//   {"kind":"goto","label":"done"}            jump
//   {"kind":"stderr","text":"..."}            write a line to stderr
//   {"kind":"garbage","text":"not json"}      write a non-JSON line to stdout
//   {"kind":"partial","text":"{\"type\":"}    write without a newline (torn line)
//   {"kind":"hang"}                           stop responding, stay alive
//   {"kind":"crash","signal":"SIGKILL"}       die by a signal
//   {"kind":"exit","code":0}                  exit
// Strings may use ${VAR}; an object {"$var":"NAME"} is replaced by the raw
// captured value (so JSON-RPC ids keep their type).
//
// Exit 97 when an expected input never arrives (or stdin closes first);
// exit 98 when the cassette cannot be read.

import fs from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (n) => {
	const i = argv.indexOf(n);
	return i >= 0 ? argv[i + 1] : undefined;
};

const cassetteFile = flag("--cassette") ?? process.env.HERMES_FAKE_CASSETTE;
function fail(code, message) {
	process.stderr.write(`[fake-agent] ${message}\n`);
	process.stdout.write("", () => process.exit(code));
}

/** Parse cassette text into steps. Throws with the line number on bad JSON. */
function parseCassette(text) {
	const steps = [];
	text.split("\n").forEach((l, i) => {
		const t = l.trim();
		if (!t || t.startsWith("//")) return;
		try {
			steps.push(JSON.parse(t));
		} catch (e) {
			throw new Error(`cassette line ${i + 1}: ${e.message}`);
		}
	});
	return steps;
}

let cassette;
try {
	if (!cassetteFile) throw new Error("no cassette: set HERMES_FAKE_CASSETTE or pass --cassette <file>");
	cassette = parseCassette(fs.readFileSync(cassetteFile, "utf8"));
} catch (e) {
	fail(98, e.message);
}

if (cassette) {
	const vars = {
		SESSION_ID: flag("--resume") ?? flag("--session-id") ?? "00000000-0000-4000-8000-000000000000",
		CWD: flag("--working-dir") ?? flag("--cwd") ?? process.cwd(),
		MODEL: flag("--model") ?? "fake-model",
	};
	const speed = Number(process.env.HERMES_FAKE_SPEED ?? 1);
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));
	const subst = (o) => {
		if (typeof o === "string") return o.replace(/\$\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
		if (Array.isArray(o)) return o.map(subst);
		if (o && typeof o === "object") {
			if ("$var" in o) return vars[o.$var];
			return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, subst(v)]));
		}
		return o;
	};
	const get = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
	const matches = (line, m) => Object.entries(m).every(([k, v]) => JSON.stringify(get(line, k)) === JSON.stringify(subst(v)));

	const inbox = [];
	let wake = null;
	let closed = false;
	createInterface({ input: process.stdin, crlfDelay: Infinity })
		.on("line", (l) => {
			if (!l.trim()) return;
			try {
				inbox.push(JSON.parse(l));
			} catch {
				process.stderr.write(`[fake-agent] ignoring malformed stdin line: ${l.slice(0, 80)}\n`);
			}
			wake?.();
		})
		.on("close", () => {
			closed = true;
			wake?.();
		});
	const waitFor = async (m, timeoutMs = 10_000) => {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const i = inbox.findIndex((x) => matches(x, m));
			if (i >= 0) return inbox.splice(i, 1)[0];
			if (closed || Date.now() > end) return null;
			await new Promise((r) => {
				const t = setTimeout(r, Math.min(50, Math.max(1, end - Date.now())));
				wake = () => {
					clearTimeout(t);
					r();
				};
			});
			wake = null;
		}
	};
	const flushThen = (fn) => process.stdout.write("", fn);

	const labels = new Map();
	cassette.forEach((s, i) => {
		if (s.kind === "label") labels.set(s.label, i);
	});
	const jump = (label, from) => {
		if (!labels.has(label)) {
			fail(98, `cassette step ${from}: unknown label "${label}"`);
			return null;
		}
		return labels.get(label);
	};

	let pc = 0;
	for (; pc < cassette.length; pc++) {
		const s = cassette[pc];
		if (s.dt) await sleep(s.dt);
		if (s.kind === "header" || s.kind === "label") continue;
		if (s.kind === "emit") process.stdout.write(JSON.stringify(subst(s.line)) + "\n");
		else if (s.kind === "stderr") process.stderr.write(subst(s.text) + "\n");
		else if (s.kind === "garbage") process.stdout.write(subst(s.text) + "\n");
		else if (s.kind === "partial") process.stdout.write(subst(s.text));
		else if (s.kind === "hang") await new Promise(() => {});
		else if (s.kind === "exit") {
			await new Promise((r) => flushThen(r));
			process.exit(s.code ?? 0);
		} else if (s.kind === "crash") {
			await new Promise((r) => flushThen(r));
			process.kill(process.pid, s.signal ?? "SIGKILL");
			await new Promise(() => {});
		} else if (s.kind === "goto") {
			const to = jump(s.label, pc);
			if (to === null) break;
			pc = to;
		} else if (s.kind === "expect") {
			const got = await waitFor(s.match, s.timeoutMs);
			if (!got) {
				fail(97, `expected input never arrived at cassette step ${pc}: ${JSON.stringify(s.match)}${closed ? " (stdin closed)" : ""}`);
				break;
			}
			for (const [name, p] of Object.entries(s.capture ?? {})) vars[name] = get(got, p);
			const b = (s.branch ?? []).find((x) => matches(got, x.when));
			if (b) {
				const to = jump(b.goto, pc);
				if (to === null) break;
				pc = to;
			}
		} else {
			fail(98, `cassette step ${pc}: unknown kind "${s.kind}"`);
			break;
		}
	}
	if (pc >= cassette.length) flushThen(() => process.exit(0));
}
