import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import allowlist from "../../eslint-rules/source-reading-tests.allowlist.json";

// Runs the repository's real ESLint config against small snippets, so this
// proves what `npx eslint .` does in CI — not what the rule file says.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RULE = "hermes/no-source-reading-tests";

// The allowlist may only shrink. Lower this when you remove entries; never raise it.
const ALLOWLIST_CEILING = 29;

async function lint(code: string, filePath: string, eslint = new ESLint({ cwd: REPO_ROOT })) {
	const [result] = await eslint.lintText(code, { filePath });
	return result.messages.filter((m) => m.ruleId === RULE);
}

const NEW_TEST = "src/__tests__/some-new-feature.test.ts";

describe("no-source-reading-tests lint rule", () => {
	it("fails a new test that reads a file under src/", async () => {
		const code = [
			'import { readFileSync } from "fs";',
			'const text = readFileSync("src/components/SplitPane.tsx", "utf8");',
			"export const x = text.includes(\"onClick\");",
		].join("\n");
		const messages = await lint(code, NEW_TEST);
		expect(messages).toHaveLength(1);
		expect(messages[0].severity).toBe(2);
		expect(messages[0].message).toContain("Tests must not read files");
	});

	it.each([
		['import * as fs from "node:fs";\nfs.readFileSync("src/a.ts", "utf8");', "namespace import"],
		['import fs from "fs";\nfs.promises.readFile("src/a.ts", "utf8");', "fs.promises"],
		['import { readFile } from "node:fs/promises";\nawait readFile("src/a.ts");', "fs/promises"],
		['const fs = require("fs");', "require"],
		['import src from "../components/SplitPane.tsx?raw";\nexport default src;', "?raw import"],
		['const all = import.meta.glob("../**/*.ts", { query: "?raw", eager: true });\nexport default all;', "raw glob"],
		['const fs = await import("node:fs");\nexport default fs;', "dynamic import"],
		['import { promises as fs } from "node:fs";\nawait fs.readFile("src/a.ts", "utf8");', "promises as fs"],
		['import { promises } from "fs";\nawait promises.readFile("src/a.ts", "utf8");', "promises named import"],
		['import * as fs from "fs";\nconst f = fs;\nf.readFileSync("src/a.ts", "utf8");', "aliased namespace"],
		['import fs from "fs";\nconst p = fs.promises;\nawait p.readFile("src/a.ts");', "aliased fs.promises"],
		['import fs from "fs";\nconst { readFileSync } = fs;\nreadFileSync("src/a.ts");', "destructured read API"],
		['import fs from "fs";\nconst { promises: p } = fs;\nawait p.readFile("src/a.ts");', "destructured promises"],
		['const all = import.meta.glob("../**/*.ts", { query: { raw: true }, eager: true });\nexport default all;', "raw glob, object query"],
	])("flags %#: %s", async (code, _label) => {
		const messages = await lint(code, "src/components/__tests__/NewThing.test.tsx");
		expect(messages.length).toBeGreaterThan(0);
	});

	it("allows tests that exercise code and only check files exist", async () => {
		const code = [
			'import { existsSync } from "fs";',
			'import { clamp } from "../utils/clamp";',
			"export const ok = existsSync(\"x\") && clamp(1, 0, 2) === 1;",
		].join("\n");
		expect(await lint(code, NEW_TEST)).toEqual([]);
	});

	it("does not apply outside test files", async () => {
		const code = 'import { readFileSync } from "fs";\nexport const read = () => readFileSync("a");';
		expect(await lint(code, "src/utils/not-a-test.ts")).toEqual([]);
	});

	it("exempts files on the allowlist", async () => {
		const code = 'import { readFileSync } from "fs";\nexport const t = readFileSync("src/a.ts", "utf8");';
		expect(await lint(code, allowlist.files[0])).toEqual([]);
	});
});

describe("source-reading allowlist", () => {
	it("only shrinks", () => {
		expect(allowlist.files.length).toBeLessThanOrEqual(ALLOWLIST_CEILING);
		expect(new Set(allowlist.files).size).toBe(allowlist.files.length);
	});

	it("has no stale entries: every listed test still exists and still reads files", async () => {
		const strict = new ESLint({
			cwd: REPO_ROOT,
			overrideConfig: { rules: { [RULE]: ["error", { allowlist: [] }] } },
		});
		const results = await strict.lintFiles(allowlist.files);
		const stale = results
			.filter((r) => !r.messages.some((m) => m.ruleId === RULE))
			.map((r) => r.filePath);
		expect(results).toHaveLength(allowlist.files.length);
		expect(stale, "these files no longer read files — remove them from the allowlist").toEqual([]);
	}, 60_000);
});
