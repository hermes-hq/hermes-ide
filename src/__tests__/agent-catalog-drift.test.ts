/**
 * F06 — the nightly CLI drift check (scripts/agent-catalog-drift.mjs).
 *
 * Feeds the check synthetic --help texts and asserts it reports exactly the
 * flags and subcommands that disappeared, and nothing else.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs script without type declarations
import { requirementsOf, probesFor, helpMentions, findDrift, formatReport, stripAnsi, withRetries } from "../../scripts/agent-catalog-drift.mjs";
import catalog from "../catalog/agents.json";

type Probe = { path: string[]; kind: string; token: string; where: string; flag?: string };
const agent = (id: string) => catalog.agents.find((a) => a.id === id)!;

const CODEX_HELP: Record<string, string> = {
	codex: `Usage: codex [OPTIONS] [PROMPT]
Commands:
  login           Manage login
  app-server      [experimental] Run the app server
  resume          Resume a previous interactive session
Options:
  -c, --config <key=value>
  -s, --sandbox <SANDBOX_MODE>   [possible values: read-only, workspace-write, danger-full-access]
      --dangerously-bypass-approvals-and-sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>
          - untrusted: ...
          - on-request: The model decides
  -V, --version`,
	"codex resume": `Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]
      --last   Continue the most recent session`,
	"codex login": `Commands:
  status  Show login status`,
};

describe("drift check: what the catalog needs", () => {
	it("splits subcommands, flags, values and placeholders", () => {
		expect(requirementsOf(["codex"], ["resume", "--last"])).toEqual([
			{ path: ["codex"], kind: "subcommand", token: "resume" },
			{ path: ["codex", "resume"], kind: "flag", token: "--last" },
		]);
		expect(requirementsOf(["codex"], ["--sandbox", "workspace-write", "-c", "tui.x=true", "--resume={session_id}"])).toEqual([
			{ path: ["codex"], kind: "flag", token: "--sandbox" },
			{ path: ["codex"], kind: "value", token: "workspace-write", flag: "--sandbox" },
			{ path: ["codex"], kind: "flag", token: "-c" },
			{ path: ["codex"], kind: "flag", token: "--resume" },
		]);
		expect(requirementsOf(["goose", "session"], ["--resume", "--session-id", "{session_id}"])).toEqual([
			{ path: ["goose", "session"], kind: "flag", token: "--resume" },
			{ path: ["goose", "session"], kind: "flag", token: "--session-id" },
		]);
	});

	it("covers argv subcommands, resume, permissions, structured and auth for a real entry", () => {
		const probes = probesFor(agent("kiro")) as Probe[];
		expect(probes).toContainEqual({ path: ["kiro-cli"], kind: "subcommand", token: "chat", where: "terminal.argv" });
		expect(probes).toContainEqual({ path: ["kiro-cli", "chat"], kind: "flag", token: "--trust-all-tools", where: "terminal.permission_flags.auto" });
		expect(probes).toContainEqual({ path: ["kiro-cli", "chat"], kind: "flag", token: "--resume-id", where: "terminal.resume.by_id" });
		expect(probesFor(agent("codex"))).toContainEqual({ path: ["codex", "login"], kind: "subcommand", token: "status", where: "auth.check" });
		expect(probesFor(agent("custom"))).toEqual([]);
	});

	it("matches whole flags only (a prefix of a longer flag does not count)", () => {
		const help = "  --yes-always   Always say yes\n  -c, --continue\n";
		expect(helpMentions(help, "--yes-always", "flag")).toBe(true);
		expect(helpMentions(help, "--yes", "flag")).toBe(false);
		expect(helpMentions(help, "-c", "flag")).toBe(true);
		expect(helpMentions(help, "--continue", "flag")).toBe(true);
		expect(helpMentions("[choices: \"default\", \"auto_edit\"]", "auto_edit", "word")).toBe(true);
		expect(helpMentions("auto_editor", "auto_edit", "word")).toBe(false);
		expect(stripAnsi("\u001b[1m--resume\u001b[0m")).toBe("--resume");
	});
});

describe("drift check: reporting", () => {
	const helpFor = (path: string[]) => CODEX_HELP[path.join(" ")] ?? null;

	it("passes when every flag the Codex entry uses is in the help", () => {
		expect(findDrift(probesFor(agent("codex")), helpFor)).toEqual([]);
	});

	it("reports the flag Codex 0.145 removed when the catalog still uses it", () => {
		const old = JSON.parse(JSON.stringify(agent("codex")));
		old.terminal.permission_flags.auto = ["--full-auto"];
		const problems = findDrift(probesFor(old), helpFor);
		expect(problems.map((p: { where: string; token: string }) => `${p.where} ${p.token}`)).toEqual([
			"terminal.permission_flags.auto --full-auto",
		]);
		const report = formatReport([{ id: "codex", status: "drift", version: "codex-cli 0.146.0", problems, checked: 14 }]);
		expect(report).toContain("- codex terminal.permission_flags.auto: flag \"--full-auto\" is not in `codex --help`");
		expect(report).toContain("@@ codex (codex-cli 0.146.0) @@");
	});

	it("reports a removed subcommand, a removed choice and an unreadable help", () => {
		const moved = { ...CODEX_HELP, codex: CODEX_HELP.codex.replace("  resume  ", "  continue").replace("workspace-write, ", "") };
		const problems = findDrift(probesFor(agent("codex")), (p: string[]) => (p.join(" ") === "codex login" ? "" : moved[p.join(" ")] ?? null));
		const tokens = problems.map((p: { token: string }) => p.token);
		expect(tokens).toContain("resume");
		expect(tokens).toContain("workspace-write");
		expect(problems.find((p: { token: string }) => p.token === "status")?.reason).toMatch(/printed nothing/);
	});

	it("marks a CLI that could not be installed as a failure line", () => {
		const report = formatReport([{ id: "goose", status: "missing", installError: "exit 1", problems: [], checked: 0 }]);
		expect(report).toContain("- goose: CLI not found (install failed: exit 1)");
		expect(formatReport([{ id: "goose", status: "missing", problems: [], checked: 0 }], { requireAll: false })).toContain("skipped");
	});
});

describe("drift check: installing", () => {
	const quiet = { wait: () => {}, log: () => {} };

	it("tries a failed install again, so one bad download is not a missing CLI", () => {
		// The 2.0.0 push run: the install script came back as a compressed
		// body once (bash: syntax error), and passed on the next nightly run.
		const outcomes = ["exit 2", null];
		const waits: number[] = [];
		const error = withRetries(() => outcomes.shift() ?? null, { ...quiet, delayMs: 10, wait: (ms: number) => waits.push(ms) });
		expect(error).toBeNull();
		expect(outcomes).toEqual([]);
		expect(waits).toEqual([10]);
	});

	it("gives up after the last attempt and says how many it made", () => {
		let calls = 0;
		const waits: number[] = [];
		const error = withRetries(() => { calls++; return `exit ${calls}`; }, { ...quiet, attempts: 3, delayMs: 10, wait: (ms: number) => waits.push(ms) });
		expect(calls).toBe(3);
		expect(error).toBe("exit 3, 3 attempts");
		expect(waits).toEqual([10, 20]);
	});

	it("does not wait or retry after a success", () => {
		let calls = 0;
		expect(withRetries(() => { calls++; return null; }, quiet)).toBeNull();
		expect(calls).toBe(1);
	});
});
