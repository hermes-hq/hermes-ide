import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPrivacy,
	findEmails,
	findPersonalPaths,
	isForbiddenNewFile,
	parseAddedLines,
	// @ts-expect-error — plain ESM script without type declarations
} from "../../scripts/privacy-check.mjs";

// Home-path prefixes are assembled at runtime so this file itself never
// contains a literal home path (the privacy job scans every added line).
const MAC = "/" + "Users/";
const LINUX = "/" + "home/";
const WIN = "C:" + "\\\\" + "Users" + "\\\\";
// A made-up real-looking user name and address. Assembled for the same reason.
const PERSON = "jdoe" + "smith";
const PERSON_EMAIL = PERSON + "@" + "mailbox" + ".org";

const SCRIPT = fileURLToPath(new URL("../../scripts/privacy-check.mjs", import.meta.url));

const allow = {
	userNames: ["test", "dev", "runner", "Shared"],
	emailDomains: ["example.com", "*.internal"],
	emailLocalParts: ["git", "noreply"],
	emailFiles: ["LICENSE", "CLA.md"],
	dataFileDirs: ["public/", "src/assets/", "src-tauri/icons/", "docs/design-system/"],
	files: [] as string[],
};

function run(input: Partial<Parameters<typeof checkPrivacy>[0]>) {
	return checkPrivacy({ added: [], newFiles: [], commitMessages: [], existingEmails: new Set(), allow, ...input }) as {
		file?: string;
		line?: number;
		message: string;
	}[];
}

describe("privacy check: personal paths", () => {
	it("flags a real-looking home path on macOS, Linux and Windows", () => {
		expect(findPersonalPaths(`cwd: "${MAC}${PERSON}/code/app"`, allow)).toEqual([MAC + PERSON]);
		expect(findPersonalPaths(`${LINUX}${PERSON}/.config`, allow)).toEqual([LINUX + PERSON]);
		expect(findPersonalPaths(`"${WIN}${PERSON}\\\\AppData"`, allow)).toHaveLength(1);
	});

	it("allows synthetic names, case-insensitively, and placeholders", () => {
		expect(findPersonalPaths(`${MAC}test/proj ${MAC}DEV/x ${LINUX}runner/work ${MAC}Shared`, allow)).toEqual([]);
		expect(findPersonalPaths(`${MAC}<name>/proj ${LINUX}$USER/x ${MAC}.../y`, allow)).toEqual([]);
	});

	it("ignores relative paths that merely contain a Users folder", () => {
		expect(findPersonalPaths(`import List from "./components${MAC}${PERSON}";`, allow)).toEqual([]);
	});

	it("reports the file and line of an added personal path", () => {
		const findings = run({ added: [{ file: "src/a.ts", line: 7, text: `const p = "${MAC}${PERSON}";` }] });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ file: "src/a.ts", line: 7 });
		expect(findings[0].message).toContain(PERSON);
	});

	it("checks commit messages for personal paths", () => {
		const findings = run({ commitMessages: ["Fix build", `Repro: cd ${MAC}${PERSON}/repo`] });
		expect(findings).toHaveLength(1);
		expect(findings[0].message).toMatch(/commit message 2/);
	});
});

describe("privacy check: email addresses", () => {
	const none = new Set<string>();

	it("flags a real-looking address", () => {
		expect(findEmails(`contact ${PERSON_EMAIL}`, "README.md", allow, none)).toEqual([PERSON_EMAIL]);
	});

	it("allows synthetic domains, wildcard domains and SSH-style local parts", () => {
		const text = "alice@example.com admin@db.internal git@github.com noreply@anything.org";
		expect(findEmails(text, "src/a.ts", allow, none)).toEqual([]);
	});

	it("allows addresses in allowlisted files and addresses already in the repository", () => {
		expect(findEmails(PERSON_EMAIL, "CLA.md", allow, none)).toEqual([]);
		expect(findEmails(PERSON_EMAIL.toUpperCase(), "SPONSORS.md", allow, new Set([PERSON_EMAIL]))).toEqual([]);
	});

	it("does not mistake retina asset names or package versions for addresses", () => {
		expect(findEmails("icons/128x128@2x.png react@19.1.0 @tauri-apps/api@next", "a.md", allow, none)).toEqual([]);
	});
});

describe("privacy check: new binary and data files", () => {
	it("flags data files outside the asset directories", () => {
		for (const f of ["evidence/shot.png", "src/data.sqlite", "hermes.db", "logs/run.log", "demo.cast", "dump.zip", ".env", "config/.env.local", "src-tauri/prod.env"]) {
			expect(isForbiddenNewFile(f, false, allow), f).toBe(true);
		}
	});

	it("allows images in asset directories and env templates", () => {
		for (const f of ["public/logo.png", "src/assets/bg.jpg", "src-tauri/icons/icon.ico", "docs/design-system/x.png", "scripts/release-local.env.example"]) {
			expect(isForbiddenNewFile(f, false, allow), f).toBe(false);
		}
	});

	it("flags any file git reports as binary, unless explicitly allowlisted", () => {
		expect(isForbiddenNewFile("tools/helper.bin", true, allow)).toBe(true);
		expect(isForbiddenNewFile("tools/helper.bin", true, { ...allow, files: ["tools/helper.bin"] })).toBe(false);
		expect(isForbiddenNewFile("src/ok.ts", false, allow)).toBe(false);
	});
});

describe("privacy check: diff parsing", () => {
	it("returns only added lines with their new line numbers", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -3,0 +4,2 @@ ctx",
			"+first",
			"+second",
			"@@ -10 +12 @@",
			"-old",
			"+new",
			"diff --git a/gone.ts b/gone.ts",
			"--- a/gone.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-bye",
		].join("\n");
		expect(parseAddedLines(diff)).toEqual([
			{ file: "src/a.ts", line: 4, text: "first" },
			{ file: "src/a.ts", line: 5, text: "second" },
			{ file: "src/a.ts", line: 12, text: "new" },
		]);
	});
});

describe("privacy check: end to end on a git repository", () => {
	function git(cwd: string, ...args: string[]) {
		return execFileSync("git", args, { cwd, encoding: "utf8" });
	}

	function repoWith(change: (dir: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), "privacy-check-"));
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "test@example.com");
		git(dir, "config", "user.name", "test");
		git(dir, "config", "commit.gpgsign", "false");
		writeFileSync(join(dir, "README.md"), "hello\n");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "base");
		change(dir);
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "change");
		return dir;
	}

	function check(dir: string) {
		return spawnSync("node", [SCRIPT, "--base", "HEAD~1"], { cwd: dir, encoding: "utf8" });
	}

	it("passes a clean change and fails one that adds personal data", () => {
		const clean = repoWith((dir) => writeFileSync(join(dir, "a.ts"), `export const p = "${MAC}test/proj";\n`));
		const dirty = repoWith((dir) => {
			writeFileSync(join(dir, "a.ts"), `export const p = "${MAC}${PERSON}/proj";\n// ${PERSON_EMAIL}\n`);
			mkdirSync(join(dir, "evidence"));
			writeFileSync(join(dir, "evidence", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
		});
		try {
			const ok = check(clean);
			expect(ok.status, ok.stdout + ok.stderr).toBe(0);
			expect(ok.stdout).toMatch(/privacy: PASS/);

			const bad = check(dirty);
			expect(bad.status).toBe(1);
			expect(bad.stdout).toMatch(/a\.ts:1: personal path/);
			expect(bad.stdout).toMatch(/a\.ts:2: email address/);
			expect(bad.stdout).toMatch(/evidence\/shot\.png: new binary or data file/);
		} finally {
			rmSync(clean, { recursive: true, force: true });
			rmSync(dirty, { recursive: true, force: true });
		}
	});
});
