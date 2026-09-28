import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kit, sleep, start, tmpDir } from "./proc.mjs";

// POSIX signals (SIGTERM, SIGHUP, SIGWINCH, a signal-reported SIGKILL) do not
// exist on Windows; these cases run on macOS and Linux only.
const posixIt = it.skipIf(process.platform === "win32");

const AGENT = kit("fake-agent.mjs");
const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

/** Run a scenario, feed `input` (once `waitFor` has been printed, if given), wait for the end. */
async function run(scenario, { input, waitFor, args = [], env } = {}) {
	const p = start(AGENT, ["--scenario", scenario, "--speed", "0", ...args], { env });
	if (input !== undefined) {
		if (waitFor) await printed(p, waitFor);
		p.write(input);
	}
	const r = await p.done;
	return { ...r, text: r.stdout.toString("latin1") };
}

/** Resolve once the agent's stdout so far contains `text`. */
function printed(p, text) {
	return new Promise((resolve) => {
		let seen = "";
		const onData = (b) => {
			seen += b.toString("latin1");
			if (seen.includes(text)) {
				p.child.stdout.off("data", onData);
				resolve();
			}
		};
		p.child.stdout.on("data", onData);
	});
}

function scenarioFile(dir, steps) {
	const f = path.join(dir, "s.json");
	fs.writeFileSync(f, JSON.stringify({ name: "custom", steps }));
	return f;
}

const count = (hay, needle) => hay.split(needle).length - 1;

describe("fake-agent: approval scenario", () => {
	it("y approves: exit 0, with every notification kind on the way", async () => {
		const r = await run("approval", { input: "y" });
		expect(r.code).toBe(0);
		expect(r.text).toContain(`${ESC}]2;fake-agent${BEL}`);
		expect(r.text).toContain(`${ESC}]9;Approval requested: rm -rf node_modules${BEL}`);
		expect(r.text).toContain(`${ESC}]9;4;3;${BEL}`);
		expect(r.text).toContain(`${ESC}]9;4;1;80${BEL}`);
		expect(r.text).toContain(`${ESC}]9;4;0;${BEL}`);
		expect(r.text).toContain(`${ESC}]99;i=h1:d=0:p=title;fake-agent${ST}`);
		expect(r.text).toContain(`${ESC}]99;i=h1:p=body;Needs your permission${ST}`);
		expect(r.text).toContain(`${ESC}]99;i=h1:d=1:a=focus;${ST}`);
		expect(r.text).toContain(`${ESC}]777;notify;fake-agent;Needs your permission${ST}`);
		expect(count(r.text, `${ESC}[?1049h`)).toBe(1);
		expect(count(r.text, `${ESC}[?1049l`)).toBe(1);
		expect(r.text).toContain("Allow Bash: rm -rf node_modules ?");
		expect(r.text).toContain("fake-agent: approval granted\r\n");
		expect(r.text).toContain("fake-agent: task done\r\n");
		// Written in three pieces, arrives as one sequence.
		expect(r.text).toContain(`${ESC}]9;Agent turn complete${BEL}`);
		expect(r.text).not.toContain("approval denied");
	});

	it("a (always) approves too", async () => {
		const r = await run("approval", { input: "a" });
		expect(r.code).toBe(0);
		expect(r.text).toContain("approval granted");
	});

	it("n denies: exit 3 and an error progress state", async () => {
		const r = await run("approval", { input: "n" });
		expect(r.code).toBe(3);
		expect(r.text).toContain("fake-agent: approval denied\r\n");
		expect(r.text).toContain(`${ESC}]9;4;2;100${BEL}`);
		expect(r.text).not.toContain("approval granted");
		expect(count(r.text, `${ESC}[?1049l`)).toBe(1);
	});

	it("ignores keys it did not ask for, then takes the next valid one", async () => {
		const r = await run("approval", { input: "xq\x1b[Dn" });
		expect(r.code).toBe(3);
		expect(r.text).not.toContain("approval granted");
	});

	it("Ctrl-C interrupts with exit 130 and restores the terminal", async () => {
		const r = await run("approval", { input: "\x03", waitFor: "[a] always" });
		expect(r.code).toBe(130);
		expect(r.text).not.toContain("approval granted");
		// Leaves the alternate screen and turns bracketed paste back off.
		expect(r.text.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2004l${ESC}[?1004l`)).toBe(true);
	});

	posixIt("SIGTERM ends it with 143, SIGHUP with 129, SIGINT with 130", async () => {
		for (const [sig, code] of [
			["SIGTERM", 143],
			["SIGHUP", 129],
			["SIGINT", 130],
		]) {
			const p = start(AGENT, ["--scenario", "approval", "--speed", "0"]);
			await printed(p, "[a] always");
			p.kill(sig);
			expect((await p.done).code).toBe(code);
		}
	});
});

describe("fake-agent: other scenarios", () => {
	it("question: 1 and 2 answer with exit 0, anything else exits 4", async () => {
		const one = await run("question", { input: "1" });
		expect(one.code).toBe(0);
		expect(one.text).toContain("fake-agent: using postgres");
		const two = await run("question", { input: "2" });
		expect(two.code).toBe(0);
		expect(two.text).toContain("fake-agent: using sqlite");
		const other = await run("question", { input: "z" });
		expect(other.code).toBe(4);
		expect(other.text).toContain("please answer 1 or 2");
	});

	it("exit-error exits 1", async () => {
		const r = await run("exit-error");
		expect(r.code).toBe(1);
		expect(r.text).toContain("fake-agent: something went wrong");
	});

	posixIt("crash dies by SIGKILL after its last line reached the terminal", async () => {
		const r = await run("crash");
		expect(r.signal).toBe("SIGKILL");
		expect(r.text).toContain("fake-agent: about to crash");
	});

	it("hang never ends by itself; Ctrl-C ends it with 130", async () => {
		const p = start(AGENT, ["--scenario", "hang", "--speed", "0"]);
		const shown = printed(p, "thinking forever");
		await sleep(400);
		await shown;
		expect(p.isRunning()).toBe(true);
		p.write("\x03");
		const r = await p.done;
		expect(r.code).toBe(130);
		expect(r.stdout.toString()).toContain("thinking forever");
	});

	it("big-osc writes a 64 KB OSC 9 and keeps going", async () => {
		const r = await run("big-osc");
		expect(r.code).toBe(0);
		expect(r.text).toContain(`${ESC}]9;${"x".repeat(65536)}${BEL}`);
		expect(r.text).toContain("fake-agent: after big osc");
	});

	it("invalid-utf8 writes the raw bytes unchanged", async () => {
		const r = await run("invalid-utf8");
		expect(r.code).toBe(0);
		expect(r.stdout.includes(Buffer.from("c328a0a1e228a1f0288c28fffe", "hex"))).toBe(true);
		expect(r.text).toMatch(/before[\s\S]*\xc3\x28[\s\S]*after/);
	});

	it("alt-screen-left-on exits without leaving the alternate screen", async () => {
		const r = await run("alt-screen-left-on");
		expect(r.code).toBe(0);
		expect(r.text).toContain(`${ESC}[?1049h`);
		expect(r.text).not.toContain(`${ESC}[?1049l`);
		expect(r.text).not.toContain(`${ESC}[?2004l`);
	});

	it("bracketed-paste reports the paste; Ctrl-C inside a paste is data, not an interrupt", async () => {
		const r = await run("bracketed-paste", { input: `${ESC}[200~a\x03b${ESC}[201~` });
		expect(r.code).toBe(0);
		expect(r.text).toContain(`${ESC}[?2004h`);
		expect(r.text).toContain('pasted 3 chars: "a\\u0003b"');
	});

	posixIt("resize reports the new size after SIGWINCH", async () => {
		const p = start(AGENT, ["--scenario", "resize", "--speed", "0"]);
		await sleep(150);
		p.kill("SIGWINCH");
		const r = await p.done;
		expect(r.code).toBe(0);
		expect(r.stdout.toString()).toMatch(/^size .+\r\nresized to .+\r\n/);
	});

	it("waitKey times out with 124", async () => {
		const dir = tmpDir();
		const f = scenarioFile(dir, [{ do: "waitKey", expect: ["y"], timeoutMs: 100 }]);
		const p = start(AGENT, ["--scenario", f, "--speed", "0"]);
		const r = await p.done;
		expect(r.code).toBe(124);
	});

	it("an ignored key does not extend the waitKey deadline", async () => {
		const dir = tmpDir();
		const f = scenarioFile(dir, [{ do: "waitKey", expect: ["y"], timeoutMs: 300 }]);
		const p = start(AGENT, ["--scenario", f, "--speed", "0"]);
		const t0 = Date.now();
		await sleep(200);
		p.write("x");
		const r = await p.done;
		expect(r.code).toBe(124);
		expect(Date.now() - t0).toBeLessThan(1500);
	});

	it("sleeps follow --speed", async () => {
		const dir = tmpDir();
		const f = scenarioFile(dir, [{ do: "sleep", ms: 400 }, { do: "exit", code: 0 }]);
		const t0 = Date.now();
		const fast = start(AGENT, ["--scenario", f, "--speed", "0"]);
		await fast.done;
		const fastMs = Date.now() - t0;
		const t1 = Date.now();
		const slow = start(AGENT, ["--scenario", f, "--speed", "1"]);
		await slow.done;
		expect(Date.now() - t1).toBeGreaterThanOrEqual(400);
		expect(fastMs).toBeLessThan(Date.now() - t1);
	});
});

describe("fake-agent: log and usage", () => {
	it("logs the environment it saw, every input byte and the exit code", async () => {
		const dir = tmpDir();
		const logFile = path.join(dir, "run.jsonl");
		const r = await run("approval", {
			input: "xy",
			args: ["--log", logFile],
			env: { TERM_PROGRAM: "HERMES-IDE", HERMES_SESSION_ID: "sess-test-1" },
		});
		expect(r.code).toBe(0);
		const events = fs
			.readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const startEv = events.find((e) => e.ev === "start");
		expect(startEv.scenario).toBe("approval");
		expect(startEv.env).toMatchObject({ TERM_PROGRAM: "HERMES-IDE", HERMES_SESSION_ID: "sess-test-1" });
		expect(startEv.tty).toBe(false);
		const input = events
			.filter((e) => e.ev === "input")
			.map((e) => e.hex)
			.join("");
		expect(input).toBe("7879");
		expect(events.filter((e) => e.ev === "waitKey").map((e) => e.got)).toEqual(["x", "y"]);
		expect(events.at(-1)).toMatchObject({ ev: "exit", code: 0 });
	});

	it("waits for the rest of an escape sequence that arrives in pieces", async () => {
		const dir = tmpDir();
		const logFile = path.join(dir, "run.jsonl");
		const p = start(AGENT, ["--scenario", "approval", "--speed", "0", "--log", logFile]);
		await sleep(100);
		p.write("\x1b[");
		await sleep(100);
		p.write("Dy");
		const r = await p.done;
		expect(r.code).toBe(0);
		const keys = fs
			.readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.filter((e) => e.ev === "waitKey")
			.map((e) => e.got);
		expect(keys).toEqual(["\x1b[D", "y"]);
	});

	it("exits 2 with usage on a missing scenario or an unknown step", async () => {
		const missing = await run("no-such-scenario");
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("scenario not found");
		const dir = tmpDir();
		const f = scenarioFile(dir, [{ do: "teleport" }]);
		const unknown = await run(f);
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toContain('unknown step "teleport"');
	});

	it("every bundled scenario is valid JSON with only known steps", () => {
		const known = new Set([
			"print", "sleep", "title", "osc9", "progress", "osc99", "osc777", "bigOsc", "bell", "raw", "split",
			"altScreen", "modes", "box", "size", "waitKey", "waitPaste", "waitResize", "hang", "kill", "exit",
		]);
		const walk = (steps) => {
			for (const s of steps) {
				expect(known.has(s.do), `unknown step ${s.do}`).toBe(true);
				for (const b of Object.values(s.branches ?? {})) walk(b.steps ?? []);
				for (const k of ["onOther", "onTimeout"]) if (s[k]?.steps) walk(s[k].steps);
			}
		};
		const files = fs.readdirSync(kit("scenarios")).filter((f) => f.endsWith(".json"));
		expect(files.length).toBeGreaterThanOrEqual(10);
		for (const f of files) {
			const sc = JSON.parse(fs.readFileSync(kit("scenarios", f), "utf8"));
			expect(sc.name).toBe(f.replace(/\.json$/, ""));
			walk(sc.steps);
		}
	});
});

describe("fake-agent: shell step (an agent's Bash tool)", () => {
	it("runs the platform command in the agent's working directory and reports the exit code", async () => {
		const dir = tmpDir();
		const f = scenarioFile(dir, [
			{ do: "print", text: "editing\n" },
			{
				do: "shell",
				label: "sed -i",
				posix: "printf 'hello world\\n' > app.txt && mkdir -p notes && printf 'draft\\n' > notes/new.txt",
				win32: "echo hello world>app.txt & mkdir notes & echo draft>notes\\new.txt",
			},
			{ do: "shell", label: "a failing one", posix: "exit 7", win32: "exit /b 7" },
			{ do: "exit", code: 0 },
		]);
		const logFile = path.join(dir, "log.jsonl");
		const p = start(AGENT, ["--scenario", f, "--speed", "0", "--log", logFile], { cwd: dir });
		const r = await p.done;
		const text = r.stdout.toString("latin1");
		expect(r.code).toBe(0);
		expect(text).toContain("fake-agent: ran sed -i (exit 0)\r\n");
		expect(text).toContain("fake-agent: ran a failing one (exit 7)\r\n");
		expect(fs.readFileSync(path.join(dir, "app.txt"), "utf8").trim()).toBe("hello world");
		expect(fs.readFileSync(path.join(dir, "notes", "new.txt"), "utf8").trim()).toBe("draft");
		const events = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(events.filter((e) => e.ev === "shell").map((e) => e.code)).toEqual([0, 7]);
	});

	it("failExit ends the scenario with that code when the command fails, and a missing platform command is reported", async () => {
		const dir = tmpDir();
		const f = scenarioFile(dir, [
			{ do: "shell", label: "boom", posix: "exit 3", win32: "exit /b 3", failExit: 9 },
			{ do: "print", text: "never printed\n" },
			{ do: "exit", code: 0 },
		]);
		const r = await run(f);
		expect(r.code).toBe(9);
		expect(r.text).not.toContain("never printed");
		const g = scenarioFile(dir, [{ do: "shell", label: "elsewhere" }, { do: "exit", code: 5 }]);
		const r2 = await run(g);
		expect(r2.code).toBe(5);
		expect(r2.text).toContain(`fake-agent: no shell command for ${process.platform}`);
	});
});
