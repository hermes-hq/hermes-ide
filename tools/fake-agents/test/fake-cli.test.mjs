// The fake vendor CLI must behave like the real one at startup, or the
// launch-and-resume scenario proves nothing. These tests run it over pipes.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const FAKE = fileURLToPath(new URL("../fake-cli.mjs", import.meta.url));
const dirs = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp() {
	const d = mkdtempSync(join(tmpdir(), "fake-cli-"));
	dirs.push(d);
	return d;
}

/** Runs the fake with the given args; `keys` are written to stdin after `afterMs`. */
function run(args, { env = {}, keys = "", afterMs = 300, cwd } = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [FAKE, ...args], {
			env: { ...process.env, ...env },
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => child.kill(), 10_000);
		setTimeout(() => {
			if (keys) child.stdin.write(keys);
		}, afterMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/** A settings file whose hooks append the event name and stdin to a file. */
function hookSettings(dir, extraEvents = []) {
	const marks = join(dir, "hooks.log");
	const script = join(dir, "hook.mjs");
	writeFileSync(
		script,
		[
			"import fs from 'node:fs';",
			"let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',(d)=>s+=d);",
			`process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(marks)}, process.argv[2]+' '+s+'\\n');});`,
		].join("\n"),
	);
	const cmd = (event) => `"${process.execPath}" "${script}" ${event}`;
	const file = join(dir, "settings.json");
	writeFileSync(
		file,
		JSON.stringify({
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: cmd("SessionStart"), timeout: 5 }] }],
				SessionEnd: [{ hooks: [{ type: "command", command: cmd("SessionEnd"), timeout: 5 }] }],
				...Object.fromEntries(extraEvents.map((ev) => [ev, [{ hooks: [{ type: "command", command: cmd(ev), timeout: 5 }] }]])),
			},
		}),
	);
	return { file, marks };
}

const records = (dir) =>
	readdirSync(dir)
		.filter((f) => f.startsWith("launch-"))
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

describe("fake vendor CLI", () => {
	it("takes the pre-assigned session id, runs the SessionStart hook with it, and records the launch", async () => {
		const dir = tmp();
		const { file, marks } = hookSettings(dir);
		const res = await run(["--session-id", "sid-123", "--settings", file, "--permission-mode", "plan", "hello world"], {
			env: { HERMES_FAKE_DIR: dir, HERMES_SESSION_ID: "hermes-1" },
			keys: "q",
			afterMs: 800,
		});
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("session sid-123 (new)");
		expect(res.stdout).toContain("prompt: hello world");

		const log = readFileSync(marks, "utf8");
		const start = JSON.parse(log.split("\n").find((l) => l.startsWith("SessionStart ")).slice("SessionStart ".length));
		expect(start).toMatchObject({ hook_event_name: "SessionStart", session_id: "sid-123", source: "startup", permission_mode: "plan" });
		expect(log).toContain("SessionEnd ");

		const [rec] = records(dir);
		expect(rec.argv).toEqual(["--session-id", "sid-123", "--settings", file, "--permission-mode", "plan", "hello world"]);
		expect(rec.env.HERMES_SESSION_ID).toBe("hermes-1");
		expect(rec.settings.hooks.SessionStart).toHaveLength(1);
		expect(rec.hooksRan.map((h) => h.event)).toEqual(["SessionStart", "SessionEnd"]);
		expect(rec.exit).toMatchObject({ code: 0, why: "q" });
	});

	it("resumes a conversation with --resume, and rejects it at once in resume-fails mode", async () => {
		const dir = tmp();
		const ok = await run(["--resume", "old-1"], { env: { HERMES_FAKE_DIR: dir }, keys: "q" });
		expect(ok.code).toBe(0);
		expect(ok.stdout).toContain("session old-1 (resumed from old-1)");

		writeFileSync(join(dir, "mode"), "resume-fails\n");
		const rejected = await run(["--resume", "old-1"], { env: { HERMES_FAKE_DIR: dir } });
		expect(rejected.code).toBe(1);
		expect(rejected.stderr).toContain("No conversation found with session ID: old-1");
		expect(rejected.stdout).not.toContain("resumed");

		// A fresh start is unaffected by that mode.
		const fresh = await run(["--session-id", "new-1"], { env: { HERMES_FAKE_DIR: dir }, keys: "q" });
		expect(fresh.code).toBe(0);
		expect(fresh.stdout).toContain("session new-1 (new)");
	});

	it("in ignore-resume mode it accepts --resume but starts a new conversation under a new id", async () => {
		const dir = tmp();
		const res = await run(["--resume", "old-1"], { env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "ignore-resume" }, keys: "q" });
		expect(res.code).toBe(0);
		expect(res.stdout).not.toContain("resumed from");
		expect(res.stdout).toMatch(/session [0-9a-f-]{36} \(new\)/);
		expect(res.stdout).not.toContain("session old-1");
	});

	it("holds every hook back while the trust prompt waits, then starts on y", async () => {
		const dir = tmp();
		const { file, marks } = hookSettings(dir);
		const env = { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "trust-prompt" };

		// Nothing answers: the prompt is on screen, no hook ran.
		const child = spawn(process.execPath, [FAKE, "--session-id", "t-1", "--settings", file], { env: { ...process.env, ...env } });
		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d));
		await new Promise((r) => setTimeout(r, 1200));
		expect(stdout).toContain("Do you trust the files in this folder?");
		expect(stdout).not.toContain("ready");
		let hookLog = "";
		try {
			hookLog = readFileSync(marks, "utf8");
		} catch {
			/* no hook ran: no file */
		}
		expect(hookLog).toBe("");

		// Answering starts it: banner, SessionStart hook, ready.
		child.stdin.write("y");
		await new Promise((r) => setTimeout(r, 1500));
		expect(stdout).toContain("session t-1 (new)");
		expect(stdout).toContain("fake-cli: ready");
		expect(readFileSync(marks, "utf8")).toContain("SessionStart ");
		child.stdin.write("q");
		const code = await new Promise((r) => child.on("close", r));
		expect(code).toBe(0);
	});

	it("Ctrl-C at the trust prompt exits 130 (or 1 with interrupt-exit-1) without a hook or a not-found message", async () => {
		const dir = tmp();
		const { file, marks } = hookSettings(dir);
		const env = { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "trust-prompt" };
		const res = await run(["--resume", "old-1", "--settings", file], { env, keys: "\x03" });
		expect(res.code).toBe(130);
		expect(res.stdout).toContain("Do you trust the files in this folder?");
		expect(res.stdout).not.toContain("ready");

		const res1 = await run(["--resume", "old-1", "--settings", file], {
			env: { ...env, HERMES_FAKE_MODE: "trust-prompt interrupt-exit-1" },
			keys: "\x03",
		});
		expect(res1.code).toBe(1);
		expect(res1.stdout + res1.stderr).not.toContain("No conversation found");
		let hookLog = "";
		try {
			hookLog = readFileSync(marks, "utf8");
		} catch {
			/* no hook ran: no file */
		}
		expect(hookLog).toBe("");
		expect(records(dir).map((r) => r.exit.why).sort()).toEqual(["ctrl-c-at-trust-prompt", "ctrl-c-at-trust-prompt"]);
	});

	it("a reader polling the launch record while the fake writes it never sees a half-written file", async () => {
		const dir = tmp();
		const { file } = hookSettings(dir);
		const child = spawn(process.execPath, [FAKE, "--session-id", "sid-poll", "--settings", file], {
			env: { ...process.env, HERMES_FAKE_DIR: dir },
			stdio: ["pipe", "ignore", "ignore"],
		});
		const closed = new Promise((r) => child.on("close", r));
		// Queued before the fake reads: it starts, runs its hooks, then quits
		// (running the end hooks) — a burst of record updates.
		child.stdin.write("q");
		let reads = 0;
		let halfWritten = 0;
		let exited = false;
		const deadline = Date.now() + 8_000;
		// A tight synchronous loop: the fake is another process, so this reads
		// as fast as the disk allows while it writes.
		while (!exited && Date.now() < deadline) {
			for (const f of readdirSync(dir).filter((n) => n.startsWith("launch-"))) {
				let text;
				try {
					text = readFileSync(join(dir, f), "utf8");
				} catch {
					continue; // not there yet
				}
				reads++;
				try {
					exited = JSON.parse(text).exit !== null;
				} catch {
					halfWritten++;
				}
			}
		}
		expect(await closed).toBe(0);
		expect(exited).toBe(true);
		expect(reads).toBeGreaterThan(10);
		expect(halfWritten).toBe(0);
		expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("SIGINT at the trust prompt is the same as the key", async () => {
		const dir = tmp();
		const child = spawn(process.execPath, [FAKE, "--resume", "old-1"], {
			env: { ...process.env, HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "trust-prompt interrupt-exit-1" },
		});
		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d));
		await new Promise((r) => setTimeout(r, 800));
		expect(stdout).toContain("Do you trust the files in this folder?");
		child.kill("SIGINT");
		const code = await new Promise((r) => child.on("close", r));
		expect(code).toBe(1);
		expect(records(dir)[0].exit.why).toBe("sigint-at-trust-prompt");
	});

	it("no-start-hook: past the prompt it starts without running the SessionStart hook", async () => {
		const dir = tmp();
		const { file, marks } = hookSettings(dir);
		const child = spawn(process.execPath, [FAKE, "--session-id", "t-3", "--settings", file], {
			env: { ...process.env, HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "trust-prompt no-start-hook" },
		});
		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d));
		await new Promise((r) => setTimeout(r, 800));
		child.stdin.write("y");
		await new Promise((r) => setTimeout(r, 1000));
		expect(stdout).toContain("fake-cli: ready");
		let hookLog = "";
		try {
			hookLog = readFileSync(marks, "utf8");
		} catch {
			/* no hook ran: no file */
		}
		expect(hookLog).not.toContain("SessionStart");
		child.stdin.write("q");
		expect(await new Promise((r) => child.on("close", r))).toBe(0);
		expect(records(dir)[0].events.map((e) => e.ev)).toContain("start-hook-skipped");
	});

	it("a pasted line followed by Enter is a prompt that runs the UserPromptSubmit hook with it", async () => {
		const dir = tmp();
		const { file, marks } = hookSettings(dir, ["UserPromptSubmit"]);
		const pasted = "\x1b[200~[hermes-review #3] Please read /fixture/review-3.md\x1b[201~\r";
		const res = await run(["--session-id", "p-1", "--settings", file], {
			env: { HERMES_FAKE_DIR: dir },
			keys: `${pasted}q`,
			afterMs: 800,
		});
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("fake-cli: prompt received (51 chars)");
		const log = readFileSync(marks, "utf8");
		const submit = JSON.parse(log.split("\n").find((l) => l.startsWith("UserPromptSubmit ")).slice("UserPromptSubmit ".length));
		expect(submit).toMatchObject({ hook_event_name: "UserPromptSubmit", session_id: "p-1", prompt: "[hermes-review #3] Please read /fixture/review-3.md" });
		const [rec] = records(dir);
		expect(rec.prompts).toEqual(["[hermes-review #3] Please read /fixture/review-3.md"]);
		// The turn ends at once: Stop follows the prompt.
		expect(rec.hooksRan.map((h) => h.event)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
	});

	it("in the prompts mode `work <ms>` keeps the agent on its turn; input typed meanwhile is read only after Stop", async () => {
		const dir = tmp();
		const { file, marks } = hookSettings(dir, ["UserPromptSubmit", "Stop"]);
		// The second line arrives while the agent works; it becomes a prompt only after the turn.
		const res = await run(["--session-id", "p-3", "--settings", file], {
			env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "prompts" },
			keys: "work 600\rlater\rq",
			afterMs: 1500,
		});
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("fake-cli: working for 600 ms");
		const events = readFileSync(marks, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
		expect(events).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "UserPromptSubmit", "Stop", "SessionEnd"]);
		const [rec] = records(dir);
		expect(rec.prompts).toEqual(["work 600", "later"]);
		const evs = rec.events.map((e) => e.ev);
		const working = evs.indexOf("working");
		const turnEnd = evs.indexOf("turn-end", working);
		const secondPrompt = evs.indexOf("prompt", working);
		expect(working).toBeGreaterThan(-1);
		expect(turnEnd).toBeGreaterThan(working);
		expect(secondPrompt).toBeGreaterThan(turnEnd);
		expect(rec.events[turnEnd].t - rec.events[working].t).toBeGreaterThanOrEqual(550);
	});

	it("in no-prompt-hooks mode the prompt is taken but no hook runs (the receipt's negative control)", async () => {
		const dir = tmp();
		const { file, marks } = hookSettings(dir, ["UserPromptSubmit"]);
		const res = await run(["--session-id", "p-2", "--settings", file], {
			env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "no-prompt-hooks" },
			keys: "typed prompt\rq",
			afterMs: 800,
		});
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("fake-cli: prompt received (12 chars)");
		expect(readFileSync(marks, "utf8")).not.toContain("UserPromptSubmit ");
		expect(records(dir)[0].prompts).toEqual(["typed prompt"]);
	});

	it("declining the trust prompt exits without starting", async () => {
		const dir = tmp();
		const res = await run(["--session-id", "t-2"], { env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "trust-prompt" }, keys: "n" });
		expect(res.code).toBe(0);
		expect(res.stdout).not.toContain("ready");
		expect(records(dir)[0].exit.why).toBe("declined-trust");
	});

	it("runs exec-form hooks without a shell, honours matchers, and drives every signal path by key (F11)", async () => {
		const dir = tmp();
		const marks = join(dir, "hooks.log");
		const script = join(dir, "hook.mjs");
		writeFileSync(
			script,
			[
				"import fs from 'node:fs';",
				"let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',(d)=>s+=d);",
				`process.stdin.on('end',()=>{const p=JSON.parse(s); fs.appendFileSync(${JSON.stringify(marks)}, process.argv.slice(2).join(' ')+' '+p.hook_event_name+' '+(p.tool_name||'')+'\\n');});`,
			].join("\n"),
		);
		// Exec form: `command` is the program, `args` its arguments; a matcher
		// narrows PreToolUse to two tools, like the file Hermes writes.
		const hook = (...args) => ({ type: "command", command: process.execPath, args: [script, ...args], timeout: 5 });
		const file = join(dir, "settings.json");
		writeFileSync(
			file,
			JSON.stringify({
				hooks: {
					SessionStart: [{ hooks: [hook("signal")] }],
					PreToolUse: [{ matcher: "AskUserQuestion|ExitPlanMode", hooks: [hook("signal")] }],
					PermissionRequest: [{ hooks: [hook("signal")] }],
					PostToolUse: [{ hooks: [hook("signal")] }],
					Stop: [{ hooks: [hook("signal")] }],
					SubagentStart: [{ hooks: [hook("signal")] }],
					SessionEnd: [{ hooks: [hook("signal")] }],
				},
			}),
		);
		const res = await run(["--session-id", "k-1", "--settings", file], {
			env: { HERMES_FAKE_DIR: dir, HERMES_SIGNAL_NONCE: "n0nce" },
			keys: "pyt?usomxq",
			afterMs: 600,
		});
		expect(res.code).toBe(0);
		const log = readFileSync(marks, "utf8").split("\n").filter((l) => l !== "");
		expect(log).toEqual([
			"signal SessionStart ",
			"signal PermissionRequest Bash",
			"signal PostToolUse Bash",
			"signal PreToolUse AskUserQuestion",
			"signal SubagentStart ",
			"signal Stop ",
			"signal SessionEnd ",
		]);
		const rec = records(dir)[0];
		// `t` (PreToolUse Bash) reached the fake but matched no hook.
		expect(rec.hooksRan.find((h) => h.event === "PreToolUse" && h.tool === "Bash").results).toEqual([]);
		expect(rec.hooksRan.every((h) => h.results.every((r) => r.exec === true && r.code === 0))).toBe(true);
		// The notification and the markers went to the terminal, not to a hook.
		expect(res.stdout).toContain("\x1b]9;Approval requested: rm -rf node_modules\x07");
		expect(res.stdout).toContain("\x1b]777;notify;hermes-signal;v1:n0nce:Stop\x07");
		expect(res.stdout).toContain("\x1b]777;notify;hermes-signal;v1:deadbeefdeadbeef:PermissionRequest\x07");
		expect(rec.events.filter((e) => e.ev === "marker").map((e) => e.nonce)).toEqual(["env", "forged"]);
	});

	it("in the prompts mode a prompt is a turn whose stop a Stop hook can refuse with exit 2, like Claude Code", async () => {
		const dir = tmp();
		const work = tmp();
		// Refuses the first two stops (stderr is the feedback), then allows.
		const hook = join(dir, "stop.mjs");
		const counter = join(dir, "stops");
		const payloads = join(dir, "payloads.log");
		writeFileSync(
			hook,
			[
				"import fs from 'node:fs';",
				"let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',(d)=>s+=d);",
				"process.stdin.on('end',()=>{",
				`  fs.appendFileSync(${JSON.stringify(payloads)}, s+'\\n');`,
				`  let n=0; try { n=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8')); } catch {}`,
				`  fs.writeFileSync(${JSON.stringify(counter)}, String(n+1));`,
				"  if (n < 2) { process.stderr.write('nope '+(n+1)+'\\nmore detail\\n'); process.exit(2); }",
				"});",
			].join("\n"),
		);
		const settings = join(dir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${hook}"`, timeout: 5 }] }] } }),
		);
		const res = await run(["--session-id", "t-3", "--settings", settings], {
			env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "prompts work-log" },
			keys: "fix it\rq",
			afterMs: 600,
			cwd: work,
		});
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("Stop hook feedback: nope 1");
		expect(res.stdout).toContain("Stop hook feedback: nope 2");
		expect(res.stdout).toContain("fake-cli: turn done");
		expect(readFileSync(join(work, ".fake-work.log"), "utf8").trim().split("\n")).toEqual([
			"turn 1: fix it",
			"continue 1",
			"continue 2",
		]);
		const sent = readFileSync(payloads, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(sent.map((p) => [p.hook_event_name, p.stop_hook_active])).toEqual([
			["Stop", false],
			["Stop", true],
			["Stop", true],
		]);
		const [rec] = records(dir);
		expect(rec.turns).toHaveLength(1);
		expect(rec.turns[0].prompt).toBe("fix it");
		expect(rec.turns[0].stops).toEqual([
			{ active: false, codes: [2] },
			{ active: true, codes: [2] },
			{ active: true, codes: [0] },
		]);
	});

	it("a bracketed paste and Enter is one prompt; q inside a line does not quit", async () => {
		const dir = tmp();
		const work = tmp();
		const res = await run(["--session-id", "t-4"], {
			env: { HERMES_FAKE_DIR: dir },
			keys: "\x1b[200~quick fix\nsecond line\x1b[201~\rq",
			afterMs: 500,
			cwd: work,
		});
		expect(res.code).toBe(0);
		const [rec] = records(dir);
		expect(rec.turns.map((t) => t.prompt)).toEqual(["quick fix\nsecond line"]);
		expect(rec.turns[0].stops).toEqual([{ active: false, codes: [] }]);
		expect(rec.exit.why).toBe("q");
		// Without the work-log mode nothing is written into the agent's folder.
		expect(readdirSync(work)).toEqual([]);
	});
});

describe("fake vendor CLI: agent doctor probes", () => {
	it("answers --version with the version it was given and records no launch", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "version-codex"), "0.150.2\n");
		const res = await run(["--version"], { env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_AGENT: "codex" } });
		expect(res.code).toBe(0);
		expect(res.stdout.trim()).toBe("0.150.2 (fake codex)");
		expect(readdirSync(dir).filter((f) => f.startsWith("launch-"))).toEqual([]);
	});

	it("reports signed in (exit 0) or signed out (exit 1) for each vendor's check", async () => {
		const dir = tmp();
		const signedIn = await run(["auth", "status"], { env: { HERMES_FAKE_DIR: dir } });
		expect(signedIn.code).toBe(0);
		writeFileSync(join(dir, "auth-codex"), "out\n");
		const out = await run(["login", "status"], { env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_AGENT: "codex" } });
		expect(out.code).toBe(1);
		expect(out.stdout).toContain("Not signed in");
		const env = await run(["providers", "list"], { env: { HERMES_FAKE_AUTH: "out", HERMES_FAKE_AGENT: "opencode" } });
		expect(env.code).toBe(1);
	});

	it("a launch whose prompt is a probe word is still a launch", async () => {
		const dir = tmp();
		const res = await run(["--session-id", "p-1", "status"], { env: { HERMES_FAKE_DIR: dir }, keys: "q" });
		expect(res.code).toBe(0);
		expect(records(dir)[0].prompt).toBe("status");
	});
});

describe("fake vendor CLI: usage limits (N19)", () => {
	/** Settings like the ones Hermes writes for Claude (N19): limit hooks with matchers and a status line. */
	function limitSettings(dir) {
		const marks = join(dir, "hooks.log");
		const script = join(dir, "hook.mjs");
		writeFileSync(
			script,
			[
				"import fs from 'node:fs';",
				"let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',(d)=>s+=d);",
				`process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(marks)}, process.argv[2]+' '+s.replace(/\\n/g,' ')+'\\n');});`,
			].join("\n"),
		);
		const hook = (tag) => [{ type: "command", command: `"${process.execPath}" "${script}" ${tag}`, timeout: 5 }];
		const file = join(dir, "settings.json");
		writeFileSync(
			file,
			JSON.stringify({
				hooks: {
					StopFailure: [{ matcher: "rate_limit", hooks: hook("StopFailure") }],
					Notification: [
						{ matcher: "quota_auto_resume_fired", hooks: hook("QuotaFired") },
						{ matcher: "permission_prompt", hooks: hook("PermissionPrompt") },
					],
				},
				statusLine: { type: "command", command: `"${process.execPath}" "${script}" StatusLine` },
			}),
		);
		return { file, marks };
	}
	const logLines = (marks, tag) =>
		readFileSync(marks, "utf8")
			.split("\n")
			.filter((l) => l.startsWith(`${tag} `))
			.map((l) => JSON.parse(l.slice(tag.length + 1)));

	it("rate-limit mode: edits files, reports its windows through the status line, ends the turn on its limit; r resumes", async () => {
		const dir = tmp();
		const work = tmp();
		writeFileSync(join(work, "README.md"), "# repo\n");
		writeFileSync(join(dir, "resets_at"), "1790007200\n");
		const { file, marks } = limitSettings(dir);
		const res = await run(["--session-id", "rl-1", "--settings", file], {
			env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "rate-limit" },
			keys: "rq",
			afterMs: 2500,
			cwd: work,
		});
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("fake-cli: usage limit reached");
		expect(readFileSync(join(work, "src", "login.ts"), "utf8")).toContain("login");
		expect(readFileSync(join(work, "README.md"), "utf8")).toContain("in progress");
		const [status] = logLines(marks, "StatusLine");
		expect(status.rate_limits.five_hour).toEqual({ used_percentage: 100, resets_at: 1790007200 });
		const [stop] = logLines(marks, "StopFailure");
		expect(stop).toMatchObject({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "rl-1" });
		const [fired] = logLines(marks, "QuotaFired");
		expect(fired.notification_type).toBe("quota_auto_resume_fired");
		// A matcher that does not match keeps its hook from running.
		expect(logLines(marks, "PermissionPrompt")).toEqual([]);
	});

	it("L ends another turn on the limit (status line and StopFailure again); q then runs SessionEnd", async () => {
		const dir = tmp();
		const work = tmp();
		const { file, marks } = limitSettings(dir);
		const res = await run(["--session-id", "rl-2", "--settings", file], {
			env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "normal" },
			keys: "Lq",
			afterMs: 2500,
			cwd: work,
		});
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("fake-cli: usage limit reached");
		expect(existsSync(join(work, "src"))).toBe(false); // no edits, only the limit
		expect(logLines(marks, "StatusLine")).toHaveLength(1);
		expect(logLines(marks, "StopFailure")[0]).toMatchObject({ error: "rate_limit", session_id: "rl-2" });
		expect(records(dir)[0].exit.why).toBe("q");
	});

	it("server-error mode ends the turn on another error, which the rate_limit matcher does not run for", async () => {
		const dir = tmp();
		const work = tmp();
		const { file, marks } = limitSettings(dir);
		const res = await run(["--session-id", "se-1", "--settings", file], {
			env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "server-error" },
			keys: "q",
			afterMs: 2500,
			cwd: work,
		});
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("fake-cli: the API failed");
		expect(logLines(marks, "StatusLine")).toHaveLength(1);
		expect(logLines(marks, "StopFailure")).toEqual([]);
		expect(records(dir)[0].hooksRan.find((h) => h.event === "StopFailure").results).toEqual([]);
	});
});
