import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, listCassettes, MANIFEST_FILE, sha256, CASSETTE_DIR } from "../manifest.mjs";
import { findLeaks } from "../scrub.mjs";
import { jsonLines, kit, start, tmpDir } from "./proc.mjs";

// POSIX signals (SIGTERM, SIGHUP, SIGWINCH, a signal-reported SIGKILL) do not
// exist on Windows; these cases run on macOS and Linux only.
const posixIt = it.skipIf(process.platform === "win32");

const RECORD = kit("record-stdio.mjs");
const REPLAY = kit("replay-stdio.mjs");
const APPROVAL = kit("cassettes", "claude-bridge", "2.1.283", "approval-bash.jsonl");
const USER = { type: "user", message: { role: "user", content: "remove node_modules" } };
const ALLOW = { type: "_hermes_perm_response", id: "perm-1", decision: { behavior: "allow" } };

const readCassette = (f) =>
	fs
		.readFileSync(f, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

/** Drive a Claude-bridge-shaped agent through the allow path. */
async function driveAllow(p) {
	await p.nextJson((m) => m.type === "system");
	p.writeJson(USER);
	await p.nextJson((m) => m.type === "_hermes_perm_request");
	p.writeJson(ALLOW);
	return p.done;
}

describe("record-stdio", () => {
	it("is transparent, and its recording replays to the same output", async () => {
		const out = path.join(tmpDir(), "rec.jsonl");
		const recorded = await driveAllow(
			start(RECORD, ["--out", out, "--agent", "claude-bridge", "--agent-version", "9.9.9", "--", process.execPath, REPLAY, "--cassette", APPROVAL, "--working-dir", "/work/proj"], {
				env: { HERMES_FAKE_SPEED: "0" },
			}),
		);
		expect(recorded.code).toBe(0);
		const direct = await driveAllow(start(REPLAY, ["--cassette", APPROVAL, "--working-dir", "/work/proj"], { env: { HERMES_FAKE_SPEED: "0" } }));
		// What the host saw through the recorder is what it sees without it.
		expect(recorded.stdout.toString()).toBe(direct.stdout.toString());

		const cassette = readCassette(out);
		expect(cassette[0]).toMatchObject({
			kind: "header",
			v: 1,
			origin: "recorded",
			agent: "claude-bridge",
			recorded_with: { "claude-bridge": "9.9.9" },
			scrubbed: true,
		});
		expect(cassette.map((e) => e.kind)).toEqual(["header", "emit", "expect", "emit", "emit", "expect", "emit", "emit", "exit"]);
		expect(cassette.find((e) => e.kind === "expect" && e.match.type === "_hermes_perm_response").match).toEqual({
			type: "_hermes_perm_response",
			id: "perm-1",
		});

		// The recording is itself a working fake.
		const replayed = await driveAllow(start(REPLAY, ["--cassette", out, "--working-dir", "/work/proj"], { env: { HERMES_FAKE_SPEED: "0" } }));
		expect(replayed.code).toBe(0);
		expect(jsonLines(replayed.stdout)).toEqual(jsonLines(direct.stdout));
	});

	it("scrubs the recording but not the live stream", async () => {
		const out = path.join(tmpDir(), "rec.jsonl");
		const home = "/Users/" + "somebody";
		const key = ["sk-", "ant-", "x".repeat(30)].join("");
		const leaky = `process.stdout.write(JSON.stringify({type:"system",cwd:${JSON.stringify(home + "/proj")},key:${JSON.stringify(key)}})+"\\n");`;
		const r = await start(RECORD, ["--out", out, "--", process.execPath, "-e", leaky]).done;
		expect(r.code).toBe(0);
		expect(r.stdout.toString()).toContain(home);
		const text = fs.readFileSync(out, "utf8");
		expect(text).not.toContain(home);
		expect(text).not.toContain(key);
		expect(findLeaks(text)).toEqual([]);
		expect(readCassette(out)[1].line.key).toBe("[REDACTED:anthropic-key]");
	});

	posixIt("records non-JSON output, stderr, a torn last line and a crash", async () => {
		const out = path.join(tmpDir(), "rec.jsonl");
		const script = [
			'process.stdout.write("not json\\n");',
			'process.stderr.write("warn: x\\n");',
			'process.stdout.write("{\\"type\\":\\"half");',
			'setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);',
		].join("");
		const r = await start(RECORD, ["--out", out, "--", process.execPath, "-e", script]).done;
		expect(r.signal).toBe("SIGKILL");
		const kinds = readCassette(out).slice(1);
		expect(kinds.find((e) => e.kind === "garbage").text).toBe("not json");
		expect(kinds.find((e) => e.kind === "stderr").text).toBe("warn: x");
		expect(kinds.find((e) => e.kind === "partial").text).toBe('{"type":"half');
		expect(kinds.at(-1)).toMatchObject({ kind: "crash", signal: "SIGKILL" });
	});

	it("passes the exit code through and exits 2 on bad usage", async () => {
		const out = path.join(tmpDir(), "rec.jsonl");
		const r = await start(RECORD, ["--out", out, "--", process.execPath, "-e", "process.exit(7)"]).done;
		expect(r.code).toBe(7);
		expect(readCassette(out).at(-1)).toMatchObject({ kind: "exit", code: 7 });
		const usage = await start(RECORD, []).done;
		expect(usage.code).toBe(2);
	});

	it("can stand in for the bridge: command and output file from the environment", async () => {
		const out = path.join(tmpDir(), "rec.jsonl");
		const r = await driveAllow(
			start(RECORD, ["--cassette", APPROVAL], {
				env: {
					HERMES_RECORD_CMD: JSON.stringify([process.execPath, REPLAY]),
					HERMES_RECORD_OUT: out,
					HERMES_RECORD_AGENT: "claude-bridge",
					HERMES_FAKE_SPEED: "0",
				},
			}),
		);
		expect(r.code).toBe(0);
		expect(readCassette(out)[0]).toMatchObject({ kind: "header", agent: "claude-bridge" });
	});
});

describe("cassette manifest", () => {
	it("lists every cassette with its current hash", () => {
		const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
		expect(manifest.cassettes.map((c) => c.path)).toEqual(listCassettes());
		for (const c of manifest.cassettes) {
			expect(c.sha256, c.path).toBe(sha256(path.join(CASSETTE_DIR, c.path)));
		}
		expect(buildManifest(manifest)).toEqual(manifest);
	});

	it("covers one fake per protocol", () => {
		const agents = new Set(listCassettes().map((p) => p.split("/")[0]));
		expect([...agents].sort()).toEqual(["acp", "claude-bridge", "codex-app-server"]);
	});

	it("every cassette starts with a scrubbed v1 header", () => {
		for (const p of listCassettes()) {
			const [header] = readCassette(path.join(CASSETTE_DIR, p));
			expect(header, p).toMatchObject({ kind: "header", v: 1, scrubbed: true });
		}
	});
});
