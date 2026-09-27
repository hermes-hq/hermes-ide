import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jsonLines, kit, sleep, start, tmpDir } from "./proc.mjs";

// POSIX signals (SIGTERM, SIGHUP, SIGWINCH, a signal-reported SIGKILL) do not
// exist on Windows; these cases run on macOS and Linux only.
const posixIt = it.skipIf(process.platform === "win32");

const REPLAY = kit("replay-stdio.mjs");
const CLAUDE = (name) => kit("cassettes", "claude-bridge", "2.1.283", `${name}.jsonl`);
const ACP = kit("cassettes", "acp", "1", "edit-approval.jsonl");
const CODEX = kit("cassettes", "codex-app-server", "0.145.0", "command-approval.jsonl");

const replay = (cassette, args = [], env = {}) =>
	start(REPLAY, args, { env: { HERMES_FAKE_CASSETTE: cassette, HERMES_FAKE_SPEED: "0", ...env } });

function writeCassette(lines) {
	const f = path.join(tmpDir(), "c.jsonl");
	fs.writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
	return f;
}

const USER = { type: "user", message: { role: "user", content: "remove node_modules" } };

describe("replay-stdio: Claude bridge cassettes", () => {
	it("allow path: permission request, then tool result and a successful result", async () => {
		const p = replay(CLAUDE("approval-bash"), ["--session-id", "11111111-2222-4333-8444-555555555555", "--model", "m-test"]);
		const init = await p.nextJson((m) => m.type === "system");
		expect(init).toMatchObject({ subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", model: "m-test" });
		p.writeJson(USER);
		const req = await p.nextJson((m) => m.type === "_hermes_perm_request");
		expect(req).toMatchObject({ id: "perm-1", toolName: "Bash", input: { command: "rm -rf node_modules" } });
		p.writeJson({ type: "_hermes_perm_response", id: "perm-1", decision: { behavior: "allow" } });
		const result = await p.nextJson((m) => m.type === "result");
		expect(result).toMatchObject({ subtype: "success", is_error: false, session_id: "11111111-2222-4333-8444-555555555555" });
		const r = await p.done;
		expect(r.code).toBe(0);
		const types = jsonLines(r.stdout).map((m) => m.type);
		expect(types).toEqual(["system", "assistant", "_hermes_perm_request", "user", "result"]);
	});

	it("deny path: an error result and no tool result", async () => {
		const p = replay(CLAUDE("approval-bash"));
		p.writeJson(USER);
		await p.nextJson((m) => m.type === "_hermes_perm_request");
		p.writeJson({ type: "_hermes_perm_response", id: "perm-1", decision: { behavior: "deny", message: "no" } });
		const r = await p.done;
		expect(r.code).toBe(0);
		const out = jsonLines(r.stdout);
		expect(out.at(-1)).toMatchObject({ type: "result", subtype: "error_during_execution", is_error: true });
		expect(out.some((m) => m.type === "user")).toBe(false);
	});

	it("a response for another request id does not unblock the wait", async () => {
		const p = replay(CLAUDE("approval-bash"));
		p.writeJson(USER);
		await p.nextJson((m) => m.type === "_hermes_perm_request");
		p.writeJson({ type: "_hermes_perm_response", id: "perm-999", decision: { behavior: "allow" } });
		await sleep(200);
		expect(p.isRunning()).toBe(true);
		p.writeJson({ type: "_hermes_perm_response", id: "perm-1", decision: { behavior: "allow" } });
		expect((await p.done).code).toBe(0);
	});

	posixIt("crash path: stderr message, then death by SIGKILL mid-turn", async () => {
		const p = replay(CLAUDE("crash"));
		p.writeJson(USER);
		const r = await p.done;
		expect(r.signal).toBe("SIGKILL");
		expect(r.stderr).toContain("fatal: out of memory");
		expect(jsonLines(r.stdout).at(-1)).toMatchObject({ type: "assistant" });
	});

	posixIt("hang path: answers once, then stays alive and silent", async () => {
		const p = replay(CLAUDE("hang"));
		p.writeJson(USER);
		await p.nextJson((m) => m.type === "assistant");
		const before = (await Promise.race([p.done, sleep(500).then(() => null)])) ?? null;
		expect(before).toBeNull();
		expect(p.isRunning()).toBe(true);
		p.kill("SIGTERM");
		const r = await p.done;
		expect(r.signal).toBe("SIGTERM");
		expect(jsonLines(r.stdout).map((m) => m.type)).toEqual(["system", "assistant"]);
	});

	it("torn output: a non-JSON line, a stderr warning, a half line, exit 1", async () => {
		const p = replay(CLAUDE("torn-output"));
		p.writeJson(USER);
		const r = await p.done;
		expect(r.code).toBe(1);
		const text = r.stdout.toString();
		expect(text).toContain("\nWarning: something printed to stdout that is not JSON\n");
		expect(text.endsWith('{"type":"assistant","message":{"id":"msg_fa')).toBe(true);
		expect(r.stderr).toContain("[hermes-bridge] warning: slow network");
	});

	it("exits 97 with a clear message when stdin closes before the expected input", async () => {
		const p = replay(CLAUDE("approval-bash"));
		p.end();
		const r = await p.done;
		expect(r.code).toBe(97);
		expect(r.stderr).toContain("expected input never arrived");
		expect(r.stderr).toContain("stdin closed");
	});

	it("exits 97 when the expected input does not come in time", async () => {
		const f = writeCassette([{ kind: "expect", match: { type: "user" }, timeoutMs: 100 }, { kind: "exit", code: 0 }]);
		const p = replay(f);
		p.writeJson({ type: "something-else" });
		const r = await p.done;
		expect(r.code).toBe(97);
	});

	it("exits 98 on a missing cassette, bad JSON, an unknown kind or an unknown label", async () => {
		const missing = await replay(path.join(tmpDir(), "nope.jsonl")).done;
		expect(missing.code).toBe(98);
		const noneGiven = await start(REPLAY, [], { env: { HERMES_FAKE_CASSETTE: "" } }).done;
		expect(noneGiven.code).toBe(98);
		expect(noneGiven.stderr).toContain("no cassette");
		const bad = await replay(writeCassette(['{"kind":"emit"', '{"kind":"exit"}'])).done;
		expect(bad.code).toBe(98);
		expect(bad.stderr).toContain("cassette line 1");
		const kind = await replay(writeCassette([{ kind: "teleport" }])).done;
		expect(kind.code).toBe(98);
		const label = await replay(writeCassette([{ kind: "goto", label: "nowhere" }])).done;
		expect(label.code).toBe(98);
		expect(label.stderr).toContain('unknown label "nowhere"');
	});

	it("takes the cassette from --cassette, and skips // comments and blank lines", async () => {
		const f = writeCassette(["// a note", "", { kind: "emit", line: { hello: "${MODEL}" } }, { kind: "exit", code: 5 }]);
		const r = await start(REPLAY, ["--cassette", f], { env: { HERMES_FAKE_SPEED: "0" } }).done;
		expect(r.code).toBe(5);
		expect(jsonLines(r.stdout)).toEqual([{ hello: "fake-model" }]);
	});
});

describe("replay-stdio: JSON-RPC cassettes", () => {
	async function acpUntilPermission(ids) {
		const p = replay(ACP);
		p.writeJson({ jsonrpc: "2.0", id: ids[0], method: "initialize", params: { protocolVersion: 1 } });
		expect(await p.nextJson((m) => "result" in m)).toMatchObject({ id: ids[0], result: { protocolVersion: 1 } });
		p.writeJson({ jsonrpc: "2.0", id: ids[1], method: "session/new", params: { cwd: "/work/project", mcpServers: [] } });
		expect(await p.nextJson((m) => "result" in m)).toMatchObject({ id: ids[1], result: { sessionId: "sess_fake_001" } });
		p.writeJson({ jsonrpc: "2.0", id: ids[2], method: "session/prompt", params: { sessionId: "sess_fake_001", prompt: [] } });
		const call = await p.nextJson((m) => m.params?.update?.sessionUpdate === "tool_call");
		expect(call.params.update.content[0].path).toBe("/work/project/config.json");
		const perm = await p.nextJson((m) => m.method === "session/request_permission");
		return { p, perm };
	}

	it("ACP allow-once: tool call completes and the turn ends; ids keep their JSON type", async () => {
		const { p, perm } = await acpUntilPermission([0, "one", 2]);
		p.writeJson({ jsonrpc: "2.0", id: perm.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
		const upd = await p.nextJson((m) => m.params?.update?.sessionUpdate === "tool_call_update");
		expect(upd.params.update.status).toBe("completed");
		const end = await p.nextJson((m) => m.id === 2);
		expect(end.result.stopReason).toBe("end_turn");
		p.kill("SIGTERM");
		const out = jsonLines((await p.done).stdout);
		expect(out.find((m) => m.result?.sessionId).id).toBe("one");
	});

	it("ACP reject-once: tool call fails and the turn still ends", async () => {
		const { p, perm } = await acpUntilPermission([1, 2, 3]);
		p.writeJson({ jsonrpc: "2.0", id: perm.id, result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
		const upd = await p.nextJson((m) => m.params?.update?.sessionUpdate === "tool_call_update");
		expect(upd.params.update.status).toBe("failed");
		expect((await p.nextJson((m) => m.id === 3)).result.stopReason).toBe("end_turn");
		p.kill("SIGTERM");
		await p.done;
	});

	it("ACP cancel: the prompt ends with stopReason cancelled", async () => {
		const { p, perm } = await acpUntilPermission([1, 2, 3]);
		p.writeJson({ jsonrpc: "2.0", id: perm.id, result: { outcome: { outcome: "cancelled" } } });
		expect((await p.nextJson((m) => m.id === 3)).result.stopReason).toBe("cancelled");
		p.kill("SIGTERM");
		await p.done;
	});

	async function codexUntilApproval() {
		const p = replay(CODEX);
		p.writeJson({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "0" } } });
		expect(await p.nextJson((m) => m.id === 1)).toMatchObject({ result: { userAgent: expect.stringContaining("0.145.0") } });
		p.writeJson({ id: 2, method: "thread/start", params: {} });
		expect((await p.nextJson((m) => m.id === 2)).result.thread.id).toBe("thr_fake_001");
		p.writeJson({ id: 3, method: "turn/start", params: { threadId: "thr_fake_001", input: [] } });
		await p.nextJson((m) => m.method === "turn/started");
		const req = await p.nextJson((m) => m.method === "item/commandExecution/requestApproval");
		expect(req.params.command).toBe("touch canary.txt");
		return { p, req };
	}

	it("Codex accept: the turn completes", async () => {
		const { p, req } = await codexUntilApproval();
		p.writeJson({ id: req.id, result: { decision: "accept" } });
		const done = await p.nextJson((m) => m.method === "turn/completed");
		expect(done.params.turn.status).toBe("completed");
		p.kill("SIGTERM");
		await p.done;
	});

	it("Codex decline: the turn fails", async () => {
		const { p, req } = await codexUntilApproval();
		p.writeJson({ id: req.id, result: { decision: "decline" } });
		const done = await p.nextJson((m) => m.method === "turn/completed");
		expect(done.params.turn.status).toBe("failed");
		p.kill("SIGTERM");
		await p.done;
	});
});
