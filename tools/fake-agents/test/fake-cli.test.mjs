// The fake vendor CLI must behave like the real one at startup, or the
// launch-and-resume scenario proves nothing. These tests run it over pipes.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function hookSettings(dir) {
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

	it("declining the trust prompt exits without starting", async () => {
		const dir = tmp();
		const res = await run(["--session-id", "t-2"], { env: { HERMES_FAKE_DIR: dir, HERMES_FAKE_MODE: "trust-prompt" }, keys: "n" });
		expect(res.code).toBe(0);
		expect(res.stdout).not.toContain("ready");
		expect(records(dir)[0].exit.why).toBe("declined-trust");
	});

	it("a prompt is a turn whose stop a Stop hook can refuse with exit 2, like Claude Code", async () => {
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
			env: { HERMES_FAKE_DIR: dir },
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
	});
});
