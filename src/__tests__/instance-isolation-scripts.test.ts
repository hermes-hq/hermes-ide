// Dev and test builds must never run as the installed app: the CI identifier
// check and the `npm run tauri` wrapper, exercised as real processes against
// synthetic repos.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..");
const CHECK = join(REPO, "scripts", "check-instance-identifiers.mjs");
const WRAPPER = join(REPO, "scripts", "tauri.mjs");
const PROD = "com.hermes-ide.terminal";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hermes-n02-test-"));
	made.push(dir);
	return dir;
}

type Overlays = Record<string, Record<string, unknown> | string>;

/** A minimal repo layout the check understands. */
function fakeRepo({
	overlays = {
		dev: { identifier: `${PROD}.dev` },
		e2e: { identifier: `${PROD}.e2e` },
		linux: { bundle: {} },
	},
	guardId = PROD,
	tauriScript = "node scripts/tauri.mjs",
	baseWindows,
}: { overlays?: Overlays; guardId?: string | null; tauriScript?: string; baseWindows?: unknown[] } = {}): string {
	const root = tempDir();
	mkdirSync(join(root, "src-tauri", "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { tauri: tauriScript } }));
	writeFileSync(
		join(root, "src-tauri", "tauri.conf.json"),
		JSON.stringify(baseWindows ? { identifier: PROD, app: { windows: baseWindows } } : { identifier: PROD }),
	);
	if (guardId !== null) {
		writeFileSync(
			join(root, "src-tauri", "src", "instance.rs"),
			`pub const PRODUCTION_IDENTIFIER: &str = "${guardId}";\n`,
		);
	}
	for (const [name, body] of Object.entries(overlays)) {
		const text = typeof body === "string" ? body : JSON.stringify(body);
		writeFileSync(join(root, "src-tauri", `tauri.${name}.conf.json`), text);
	}
	return root;
}

function runCheck(root: string) {
	const res = spawnSync(process.execPath, [CHECK, "--root", root], { encoding: "utf8" });
	return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("CI check: dev and test configs never use the production identifier", () => {
	it("passes on this repository", () => {
		const res = runCheck(REPO);
		expect(res.out).toContain("instance identifiers: OK");
		expect(res.code).toBe(0);
	});

	it("passes when dev, e2e and beta each have their own identifier", () => {
		const res = runCheck(
			fakeRepo({
				overlays: {
					dev: { identifier: `${PROD}.dev` },
					e2e: { identifier: `${PROD}.e2e` },
					beta: { identifier: `${PROD}.beta` },
					windows: { bundle: {} },
				},
			}),
		);
		expect(res.code).toBe(0);
	});

	it("fails when the e2e config uses the production identifier", () => {
		const res = runCheck(
			fakeRepo({ overlays: { dev: { identifier: `${PROD}.dev` }, e2e: { identifier: PROD } } }),
		);
		expect(res.code).toBe(1);
		expect(res.out).toContain(`src-tauri/tauri.e2e.conf.json: uses the production identifier "${PROD}"`);
	});

	it("fails when the dev config uses the production identifier in another letter case", () => {
		const res = runCheck(
			fakeRepo({
				overlays: { dev: { identifier: "COM.Hermes-IDE.Terminal" }, e2e: { identifier: `${PROD}.e2e` } },
			}),
		);
		expect(res.code).toBe(1);
		expect(res.out).toContain("tauri.dev.conf.json: uses the production identifier");
	});

	it("fails when an overlay leaves the identifier out (it would inherit production)", () => {
		const res = runCheck(
			fakeRepo({
				overlays: {
					dev: { identifier: `${PROD}.dev` },
					e2e: { productName: "no identifier" },
					beta: { productName: "no identifier" },
				},
			}),
		);
		expect(res.code).toBe(1);
		expect(res.out).toContain("tauri.e2e.conf.json: must set its own identifier");
		expect(res.out).toContain("tauri.beta.conf.json: must set its own identifier");
		expect(res.out).toContain("FAILED (2 problems)");
	});

	it("fails when the dev or e2e config is missing", () => {
		const res = runCheck(fakeRepo({ overlays: { beta: { identifier: `${PROD}.beta` } } }));
		expect(res.code).toBe(1);
		expect(res.out).toContain("src-tauri/tauri.dev.conf.json is missing");
		expect(res.out).toContain("src-tauri/tauri.e2e.conf.json is missing");
	});

	it("fails when a platform file changes the identifier", () => {
		const res = runCheck(
			fakeRepo({
				overlays: {
					dev: { identifier: `${PROD}.dev` },
					e2e: { identifier: `${PROD}.e2e` },
					linux: { identifier: "com.other" },
				},
			}),
		);
		expect(res.code).toBe(1);
		expect(res.out).toContain("tauri.linux.conf.json: a platform file must not change the identifier");
	});

	it("fails when the runtime guard protects a different identifier or is missing", () => {
		expect(runCheck(fakeRepo({ guardId: "com.renamed" })).out).toContain(
			`protects "com.renamed" but the production identifier is "${PROD}"`,
		);
		const missing = runCheck(fakeRepo({ guardId: null }));
		expect(missing.code).toBe(1);
		expect(missing.out).toContain("instance.rs is missing");
	});

	it("fails when `npm run tauri` bypasses the dev wrapper", () => {
		const res = runCheck(fakeRepo({ tauriScript: "tauri" }));
		expect(res.code).toBe(1);
		expect(res.out).toContain('"tauri" script must run scripts/tauri.mjs');
	});

	describe("dev and e2e windows stay in step with the base config", () => {
		const base = { title: "HERMES-IDE", width: 1200, height: 800, titleBarStyle: "Overlay" };
		const withWindows = (dev: unknown[], e2e: unknown[] = [{ ...base, title: "E2E", focus: false }]) =>
			fakeRepo({
				baseWindows: [base],
				overlays: {
					dev: { identifier: `${PROD}.dev`, app: { windows: dev } },
					e2e: { identifier: `${PROD}.e2e`, app: { windows: e2e } },
				},
			});

		it("passes when only the title differs and the overlay adds its own settings", () => {
			const res = runCheck(withWindows([{ ...base, title: "Dev" }]));
			expect(res.out).toContain("instance identifiers: OK");
			expect(res.code).toBe(0);
		});

		it("fails when the base window changes and the dev overlay was not updated", () => {
			const res = runCheck(withWindows([{ ...base, title: "Dev", width: 1000 }]));
			expect(res.code).toBe(1);
			expect(res.out).toContain('tauri.dev.conf.json: window 0 "width" is 1000, tauri.conf.json has 1200');
		});

		it("fails when an overlay drops a window setting (it would fall back to the Tauri default)", () => {
			const { titleBarStyle: _dropped, ...rest } = base;
			const res = runCheck(withWindows([{ ...rest, title: "Dev" }]));
			expect(res.code).toBe(1);
			expect(res.out).toContain('tauri.dev.conf.json: window 0 "titleBarStyle"');
		});

		it("fails when an overlay lists a different number of windows", () => {
			const res = runCheck(withWindows([{ ...base }], []));
			expect(res.code).toBe(1);
			expect(res.out).toContain("tauri.e2e.conf.json: app.windows must list the same 1 window(s)");
		});
	});

	it("fails on a config that is not valid JSON", () => {
		const res = runCheck(
			fakeRepo({ overlays: { dev: "{ not json", e2e: { identifier: `${PROD}.e2e` } } }),
		);
		expect(res.code).toBe(1);
		expect(res.out).toContain("cannot read it as JSON");
	});
});

describe("`npm run tauri` wrapper", () => {
	/**
	 * Runs the wrapper with a fake Tauri CLI that prints what it was given and,
	 * like the real CLI, the identifier of the first `--config` overlay.
	 */
	function runWrapper(args: string[], exitCode = 0) {
		const dir = tempDir();
		const fakeCli = join(dir, "fake-tauri.mjs");
		writeFileSync(
			fakeCli,
			`import { readFileSync } from "node:fs";
			 const argv = process.argv.slice(2);
			 const i = argv.indexOf("--config");
			 const identifier = i >= 0 ? JSON.parse(readFileSync(argv[i + 1], "utf8")).identifier : null;
			 process.stdout.write("\\nFAKE-TAURI " + JSON.stringify({ argv, cwd: process.cwd(), identifier }) + "\\n");
			 process.exit(${exitCode});`,
		);
		const res = spawnSync(process.execPath, [WRAPPER, ...args], {
			encoding: "utf8",
			env: { ...process.env, HERMES_TAURI_CLI: fakeCli },
		});
		const line = res.stdout.split("\n").find((l) => l.startsWith("FAKE-TAURI "));
		if (!line) throw new Error(`the fake Tauri CLI did not run: ${res.stdout}${res.stderr}`);
		const seen = JSON.parse(line.slice("FAKE-TAURI ".length)) as { argv: string[]; cwd: string; identifier: string | null };
		return { code: res.status, ...seen };
	}

	it("gives `tauri dev` the dev overlay and keeps the caller's own arguments after it", () => {
		const res = runWrapper(["dev", "--config", "extra.json", "--verbose"]);
		expect(res.argv).toEqual([
			"dev",
			"--config",
			join("src-tauri", "tauri.dev.conf.json"),
			"--config",
			"extra.json",
			"--verbose",
		]);
		expect(res.cwd).toBe(REPO);
		expect(res.code).toBe(0);
	});

	it("the dev overlay it passes names a non-production identifier", () => {
		const res = runWrapper(["dev"]);
		expect(res.identifier).toBe(`${PROD}.dev`);
	});

	it("passes every other command through unchanged, including the release build", () => {
		expect(runWrapper(["build", "--target", "aarch64-apple-darwin"]).argv).toEqual([
			"build",
			"--target",
			"aarch64-apple-darwin",
		]);
		expect(runWrapper(["info"]).argv).toEqual(["info"]);
		expect(runWrapper([]).argv).toEqual([]);
	});

	it("exits with the Tauri CLI's exit code", () => {
		expect(runWrapper(["build"], 3).code).toBe(3);
	});
});
