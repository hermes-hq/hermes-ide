#!/usr/bin/env node
// Records a real line-delimited JSON agent session as a cassette that
// replay-stdio.mjs can play back. A transparent tee: the host and the agent
// see exactly the bytes they would see without it.
//
//   node record-stdio.mjs --out <cassette.jsonl> [--agent <name>] [--agent-version <v>] -- <command> [args...]
//
// To record what Hermes sends and receives, point HERMES_BRIDGE_PATH at this
// file and give the real command and the output file through the environment
// (Hermes passes the agent's own argv, which is forwarded untouched):
//
//   HERMES_BRIDGE_PATH=tools/fake-agents/record-stdio.mjs
//   HERMES_RECORD_CMD='["node","src-tauri/bridge/hermes-claude-bridge.mjs"]'
//   HERMES_RECORD_OUT=/tmp/session.jsonl
//
// Each agent stdout line becomes an "emit" (non-JSON lines become "garbage",
// a torn last line "partial"), each host stdin line an "expect" that matches
// on its type/method/id, stderr lines "stderr", and the end "exit" or
// "crash". The result is scrubbed (scrub.mjs) unless --no-scrub is given.
// Record only in a throwaway folder with made-up content.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline";
import { SCRUBBER_VERSION, scrub } from "./scrub.mjs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
let opts = {};
let command;
if (sep >= 0) {
	const own = argv.slice(0, sep);
	for (let i = 0; i < own.length; i++) {
		const a = own[i];
		if (a === "--no-scrub") opts.noScrub = true;
		else if (a.startsWith("--")) opts[a.slice(2)] = own[++i];
	}
	command = argv.slice(sep + 1);
} else if (process.env.HERMES_RECORD_CMD) {
	command = [...JSON.parse(process.env.HERMES_RECORD_CMD), ...argv];
	opts = { out: process.env.HERMES_RECORD_OUT, agent: process.env.HERMES_RECORD_AGENT };
}
if (!command?.length || !opts.out) {
	process.stderr.write("usage: record-stdio.mjs --out <cassette.jsonl> [--agent <name>] [--agent-version <v>] [--no-scrub] -- <command> [args...]\n");
	process.exit(2);
}

// Keys an "expect" matches on: enough to tell requests apart, not the payload.
const MATCH_KEYS = ["type", "method", "id", "subtype"];

const events = [];
let last = Date.now();
const push = (e) => {
	const now = Date.now();
	events.push({ kind: e.kind, dt: now - last, ...e });
	last = now;
};

const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
child.on("error", (e) => {
	process.stderr.write(`[record-stdio] could not start ${command[0]}: ${e.message}\n`);
	process.exit(127);
});

// Host -> agent
createInterface({ input: process.stdin, crlfDelay: Infinity })
	.on("line", (l) => {
		child.stdin.write(l + "\n");
		if (!l.trim()) return;
		try {
			const msg = JSON.parse(l);
			const match = Object.fromEntries(MATCH_KEYS.filter((k) => msg && msg[k] !== undefined).map((k) => [k, msg[k]]));
			push({ kind: "expect", match, timeoutMs: 10_000 });
		} catch {
			// Not JSON: forwarded, not recorded (the agent will complain on its own).
		}
	})
	.on("close", () => child.stdin.end());

// Agent -> host, keeping a torn last line.
let pending = "";
child.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
	pending += chunk.toString("utf8");
	let nl;
	while ((nl = pending.indexOf("\n")) >= 0) {
		const line = pending.slice(0, nl);
		pending = pending.slice(nl + 1);
		if (!line.trim()) continue;
		try {
			push({ kind: "emit", line: JSON.parse(line) });
		} catch {
			push({ kind: "garbage", text: line });
		}
	}
});
createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (l) => {
	process.stderr.write(l + "\n");
	push({ kind: "stderr", text: l });
});

// Forward signals so the agent ends the way it would without the recorder.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));

child.on("close", (code, signal) => {
	if (pending) push({ kind: "partial", text: pending });
	push(signal ? { kind: "crash", signal } : { kind: "exit", code: code ?? 0 });
	const header = {
		kind: "header",
		v: 1,
		origin: "recorded",
		agent: opts.agent ?? "unknown",
		recorded_with: { [opts.agent ?? "agent"]: opts["agent-version"] ?? "unknown", node: process.version, os: os.platform() },
		scrubbed: !opts.noScrub,
		scrubber: SCRUBBER_VERSION,
	};
	const text = [header, ...events].map((e) => JSON.stringify(e)).join("\n") + "\n";
	fs.writeFileSync(opts.out, opts.noScrub ? text : scrub(text));
	process.stdout.write("", () => {
		if (signal) {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
		} else process.exit(code ?? 0);
	});
});
