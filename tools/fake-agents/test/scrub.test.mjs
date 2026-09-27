import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findLeaks, localIdentity, scrub, TOKEN_PATTERNS } from "../scrub.mjs";
import { kit, start, tmpDir } from "./proc.mjs";

const NOBODY = { user: "", hosts: [] };
// Home folders, built at runtime so this file holds no literal home path.
const MAC = (u) => "/Users/" + u;
const LINUX = (u) => "/home/" + u;
const WIN = (u) => "C:\\Users\\" + u;
const ALICE = { user: "alice", hosts: ["alice-mbp.local", "alice-mbp"] };

// Credential-shaped strings, assembled at runtime so this file itself never
// contains one (the repository's own secret scanning stays quiet).
const t = (...parts) => parts.join("");
const SAMPLES = {
	"anthropic-key": t("sk-", "ant-", "api03-", "A".repeat(40)),
	"openai-key": t("sk-", "proj-", "B".repeat(40)),
	"github-token": t("gh", "p_", "C".repeat(36)),
	"github-pat": t("github_", "pat_", "D".repeat(40)),
	"google-api-key": t("AI", "za", "E".repeat(35)),
	jwt: t("ey", "J", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxIn0", ".", "sig_nature_x"),
	"slack-token": t("xo", "xb-", "1234567890-abcdef"),
	"aws-access-key": t("AK", "IA", "ABCDEFGHIJKLMNOP"),
	bearer: t("Bearer ", "F".repeat(32)),
};

describe("scrub", () => {
	it("has a sample for every token pattern it knows", () => {
		expect(Object.keys(SAMPLES).sort()).toEqual(TOKEN_PATTERNS.map((p) => p.kind).sort());
	});

	it.each(Object.entries(SAMPLES))("removes a %s and the leak check finds none left", (kind, secret) => {
		const input = `{"env":"TOKEN=${secret}","ok":true}`;
		expect(findLeaks(input, NOBODY).map((l) => l.kind)).toContain(kind);
		const out = scrub(input, NOBODY);
		expect(out).not.toContain(secret);
		expect(out).toContain(`[REDACTED:${kind}]`);
		expect(findLeaks(out, NOBODY)).toEqual([]);
	});

	it("maps home folders on every OS to the test user", () => {
		const input = [
			MAC("alice") + "/code/app",
			LINUX("bob") + "/.config/x",
			WIN("carol") + "\\proj",
			JSON.stringify({ cwd: WIN("carol") + "\\proj" }),
			`${MAC("Shared")}/ok ${MAC("test")}/ok ${LINUX("test")}/ok`,
		].join("\n");
		const out = scrub(input, NOBODY);
		expect(out).toBe(
			[
				MAC("test") + "/code/app",
				LINUX("test") + "/.config/x",
				WIN("test") + "\\proj",
				JSON.stringify({ cwd: WIN("test") + "\\proj" }),
				`${MAC("Shared")}/ok ${MAC("test")}/ok ${LINUX("test")}/ok`,
			].join("\n"),
		);
		expect(findLeaks(out, NOBODY)).toEqual([]);
	});

	it("replaces the recording user's name and host names, not generic words", () => {
		const out = scrub("alice@alice-mbp.local ran on alice-mbp as alice; root and runner stay", ALICE);
		expect(out).not.toMatch(/alice/);
		expect(out).toContain("test-host");
		expect(out).toContain("root and runner stay");
		expect(scrub("root on localhost", { user: "root", hosts: ["localhost"] })).toBe("root on localhost");
	});

	it("replaces e-mail addresses but keeps example.com ones", () => {
		const out = scrub("from jane.doe@test.com to user@example.com", NOBODY);
		expect(out).toBe("from user@example.com to user@example.com");
	});

	it("maps UUIDs to a stable fake set in order of first appearance, case-insensitively", () => {
		const a = "3f2c1b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f";
		const b = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
		const out = scrub(`${a} ${b} ${a.toUpperCase()} ${b.toLowerCase()}`, NOBODY);
		expect(out).toBe(
			"00000000-0000-4000-8000-000000000001 00000000-0000-4000-8000-000000000002 " +
				"00000000-0000-4000-8000-000000000001 00000000-0000-4000-8000-000000000002",
		);
	});

	it("keeps fake UUIDs already present and never reuses them", () => {
		const out = scrub("00000000-0000-4000-8000-000000000001 3f2c1b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f", NOBODY);
		expect(out).toBe("00000000-0000-4000-8000-000000000001 00000000-0000-4000-8000-000000000002");
	});

	it("is deterministic and idempotent", () => {
		const input = `${MAC("alice")} ${SAMPLES["anthropic-key"]} 3f2c1b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f a@test.com alice-mbp`;
		const once = scrub(input, ALICE);
		expect(scrub(input, ALICE)).toBe(once);
		expect(scrub(once, ALICE)).toBe(once);
	});

	it("CLI --check exits 1 on a leaky file and 0 on its scrubbed copy", async () => {
		const dir = tmpDir();
		const dirty = path.join(dir, "dirty.jsonl");
		const clean = path.join(dir, "clean.jsonl");
		fs.writeFileSync(dirty, `{"cwd":"${MAC("alice")}/x","key":"${SAMPLES["openai-key"]}"}\n`);
		const bad = await start(kit("scrub.mjs"), ["--check", dirty]).done;
		expect(bad.code).toBe(1);
		expect(bad.stdout.toString()).toContain("openai-key");
		expect(bad.stdout.toString()).toContain("home-path");
		const wrote = await start(kit("scrub.mjs"), [dirty, clean]).done;
		expect(wrote.code).toBe(0);
		expect(fs.readFileSync(dirty, "utf8")).toContain(MAC("alice"));
		const good = await start(kit("scrub.mjs"), ["--check", clean]).done;
		expect(good.code).toBe(0);
	});
});

// Words the fixtures use on purpose. A machine whose user or host name is one
// of them (a host called "claude", say) must not turn the gate red: the gate
// is about leaks, and these words are not.
const FIXTURE_WORDS = new Set(["claude", "codex", "acp", "bridge", "agent", "fake", "hermes", "node", "bash"]);

/** This machine's identity minus the fixture vocabulary. */
function gateIdentity(machine = localIdentity()) {
	const keep = (name) => !FIXTURE_WORDS.has(name.toLowerCase());
	return { user: keep(machine.user) ? machine.user : "", hosts: machine.hosts.filter(keep) };
}

describe("committed fixtures", () => {
	it("a machine named after a fixture word does not trip the gate; other names still do", () => {
		const machine = { user: "claude", hosts: ["claude.local", "claude", "alice-mbp"] };
		const id = gateIdentity(machine);
		expect(id).toEqual({ user: "", hosts: ["claude.local", "alice-mbp"] });
		expect(findLeaks("claude-bridge spoke", id)).toEqual([]);
		expect(findLeaks("recorded on alice-mbp", id).map((l) => l.kind)).toEqual(["hostname"]);
	});

	const files = [];
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(jsonl|json|cast)$/.test(e.name)) files.push(p);
		}
	};
	walk(kit("cassettes"));
	walk(kit("scenarios"));

	it("exist", () => {
		expect(files.length).toBeGreaterThanOrEqual(15);
	});

	// The gate: fails on any leftover token, home path, e-mail, or this
	// machine's user or host name in any committed cassette or scenario.
	it.each(files.map((f) => [path.relative(kit(), f), f]))("%s has nothing to scrub", (_rel, f) => {
		const text = fs.readFileSync(f, "utf8");
		expect(findLeaks(text, gateIdentity())).toEqual([]);
		expect(scrub(text, gateIdentity())).toBe(text);
	});
});
