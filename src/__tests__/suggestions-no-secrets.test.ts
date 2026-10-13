/**
 * Secrets never come back as suggestions or ghost text: lines that carry a
 * key, token, password or credentials are dropped from suggestion history,
 * whether they came from the shell's history file or were typed this session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	shellHistory: [] as string[],
	sessionCommands: [] as string[],
}));

vi.mock("../api/intelligence", () => ({
	readShellHistory: vi.fn(() => Promise.resolve(h.shellHistory)),
	getSessionCommands: vi.fn(() => Promise.resolve(h.sessionCommands)),
}));

import { looksSecret } from "../terminal/intelligence/secrets";
import { createHistoryProvider, loadHistory } from "../terminal/intelligence/historyProvider";

// Built from parts so this file holds no string a secret scanner would flag.
const fake = (prefix: string, n: number, ch = "a") => prefix + ch.repeat(n);

const SECRET_LINES: [string, string][] = [
	["OpenAI key", `export OPENAI_KEY_X=${fake("sk-proj-", 40)}`],
	["Anthropic key in a command", `claude --key ${fake("sk-ant-api03-", 40)}`],
	["GitHub token", `git clone https://${fake("ghp_", 36)}@github.com/o/r`],
	["GitHub fine-grained token", `echo ${fake("github_" + "pat_", 40)}`],
	["GitLab token", `curl ${fake("glpat-", 20)}`],
	["Slack token", `notify ${fake("xo" + "xb-", 30, "1")}`],
	["AWS access key id", `aws configure set aws_access_key_id ${fake("AKIA", 16, "A")}`],
	["Google API key", `gcloud x --k ${fake("AIza", 35)}`],
	["npm token", `npm config set //registry.npmjs.org/:_authToken ${fake("npm_", 36)}`],
	["Hugging Face token", `hf login ${fake("hf_", 34)}`],
	["Stripe live key", `stripe ${fake("sk_live_", 24)}`],
	["JWT", `curl -d ${fake("eyJ", 20)}.${"b".repeat(20)}.sig`],
	["private key", `echo '${"-----BEGIN OPENSSH"} ${"PRIVATE"} KEY-----' > k`],
	["export TOKEN", "export GITHUB_TOKEN=abc123"],
	["export API key", "export ANTHROPIC_API_KEY=whatever"],
	["inline PASSWORD", "PGPASSWORD=hunter2 psql -h db"],
	["lowercase password=", "curl -d 'user=me&password=hunter2' https://x.test/login"],
	["secret assignment", "MY_CLIENT_SECRET = value"],
	["PowerShell env", '$env:OPENAI_API_KEY = "abc"'],
	["fish set", "set -gx OPENAI_API_KEY abc"],
	["--password flag", "psql --password hunter2"],
	["--token= flag", "gh auth login --token=abc"],
	["openssl -pass", "openssl enc -aes256 -pass pass:hunter2"],
	["mysql -p glued", "mysql -u root -phunter2 db"],
	["sshpass", "sshpass -p hunter2 ssh me@host"],
	["docker login -p", "docker login -u me -p hunter2 registry.test"],
	["wget --user", "wget --user me:hunter2 https://api.test"],
	["Authorization header", 'wget --header="Authorization: Basic Zm9vOmJhcg==" https://api.test'],
	["Bearer token", "http GET api.test 'Bearer abcdefgh12345678'"],
	["x-api-key header", "curl -H 'x-api-key: abc' https://api.test"],
	["URL credentials", "git remote add origin https://me:hunter2@git.test/r.git"],
	["database URL", "psql postgres://admin:hunter2@db.test:5432/app"],
];

const PLAIN_LINES = [
	"git status",
	"git log --author=gabriel --oneline",
	"npm run dev",
	"mkdir -p src/components",
	"docker run -u 1000:1000 node",
	"ssh me@host",
	"cd ~/projects && ls -la",
	"git commit -m 'Fix the settings tab'",
	"curl https://api.test/health",
	"psql -h db -U app",
	"echo $PWD",
	"export PATH=$HOME/bin:$PATH",
	"git push origin main",
	"kubectl get pods -n default",
	"cargo test --lib",
];

describe("looksSecret", () => {
	for (const [what, line] of SECRET_LINES) {
		it(`hides a line with ${what}`, () => {
			expect(looksSecret(line)).toBe(true);
		});
	}

	for (const line of PLAIN_LINES) {
		it(`keeps an everyday command: ${line}`, () => {
			expect(looksSecret(line)).toBe(false);
		});
	}
});

describe("suggestion history never holds a secret", () => {
	beforeEach(() => {
		h.shellHistory = [];
		h.sessionCommands = [];
	});

	it("drops secret lines read from the shell's history file", async () => {
		h.shellHistory = ["git status", "export ANTHROPIC_API_KEY=whatever", "export PATH=$HOME/bin:$PATH"];
		const provider = createHistoryProvider();
		await loadHistory(provider, "s1", "zsh");
		expect(provider.match("export").map((m) => m.command)).toEqual(["export PATH=$HOME/bin:$PATH"]);
		expect(provider.match("git").map((m) => m.command)).toEqual(["git status"]);
	});

	it("drops secret lines from saved session commands", async () => {
		h.sessionCommands = ["mysql -u root -phunter2 db", "mysql -u root db"];
		const provider = createHistoryProvider();
		await loadHistory(provider, "s1", "zsh");
		expect(provider.match("mysql").map((m) => m.command)).toEqual(["mysql -u root db"]);
	});

	it("drops a secret line typed this session", () => {
		const provider = createHistoryProvider();
		provider.addCommand("wget --user me:hunter2 https://api.test");
		provider.addCommand("wget https://api.test/health");
		expect(provider.match("wget").map((m) => m.command)).toEqual(["wget https://api.test/health"]);
	});
});
