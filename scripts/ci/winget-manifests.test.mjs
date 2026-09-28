// winget manifests: generated from a synthetic release folder with the real
// generator, then read back with the repository's YAML reader.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYaml } from "../../e2e/app/acceptance.mjs";
import { MANIFEST_VERSION, PACKAGE_IDENTIFIER, buildWingetManifests, yamlScalar } from "./winget-manifests.mjs";

const TAG = "v1.4.1";
const REPO = "example-org/example-app";
let rel;
let out;

beforeEach(() => {
	rel = mkdtempSync(join(tmpdir(), "hermes-winget-rel-"));
	out = mkdtempSync(join(tmpdir(), "hermes-winget-out-"));
});
afterEach(() => {
	rmSync(rel, { recursive: true, force: true });
	rmSync(out, { recursive: true, force: true });
});

function installer(name, body = name) {
	writeFileSync(join(rel, name), body);
	return createHash("sha256").update(body).digest("hex").toUpperCase();
}

function read(dir, name) {
	return parseYaml(readFileSync(join(dir, name), "utf8"), name);
}

describe("winget manifests", () => {
	it("writes the three winget-pkgs files for both installers, with their hashes", () => {
		const x64 = installer("HERMES-IDE_1.4.1_x64-setup.exe");
		const arm = installer("HERMES-IDE_1.4.1_arm64-setup.exe");
		// Things that must not end up in the manifest.
		installer("windows-x86_64-HERMES-IDE_1.4.1_x64-setup.exe");
		installer("HERMES-IDE_1.4.1_amd64.deb");
		const { dir } = buildWingetManifests(rel, { tag: TAG, repo: REPO, outDir: out, releaseDate: "2026-09-28" });

		expect(dir).toBe(join(out, "manifests", "h", "HermesHQ", "HermesIDE", "1.4.1"));
		expect(readdirSync(dir).sort()).toEqual([
			`${PACKAGE_IDENTIFIER}.installer.yaml`,
			`${PACKAGE_IDENTIFIER}.locale.en-US.yaml`,
			`${PACKAGE_IDENTIFIER}.yaml`,
		]);

		const version = read(dir, `${PACKAGE_IDENTIFIER}.yaml`);
		expect(version).toEqual({
			PackageIdentifier: PACKAGE_IDENTIFIER,
			PackageVersion: "1.4.1",
			DefaultLocale: "en-US",
			ManifestType: "version",
			ManifestVersion: MANIFEST_VERSION,
		});

		const inst = read(dir, `${PACKAGE_IDENTIFIER}.installer.yaml`);
		expect(inst.InstallerType).toBe("nullsoft");
		expect(inst.Scope).toBe("user");
		expect(inst.ProductCode).toBe("HERMES-IDE");
		expect(inst.ReleaseDate).toBe("2026-09-28");
		expect(inst.ManifestType).toBe("installer");
		expect(inst.Installers).toEqual([
			{ Architecture: "x64", InstallerUrl: `https://github.com/${REPO}/releases/download/${TAG}/HERMES-IDE_1.4.1_x64-setup.exe`, InstallerSha256: x64 },
			{ Architecture: "arm64", InstallerUrl: `https://github.com/${REPO}/releases/download/${TAG}/HERMES-IDE_1.4.1_arm64-setup.exe`, InstallerSha256: arm },
		]);
		expect(inst.Installers[0].InstallerSha256).toMatch(/^[0-9A-F]{64}$/);

		const locale = read(dir, `${PACKAGE_IDENTIFIER}.locale.en-US.yaml`);
		expect(locale.PackageName).toBe("Hermes IDE");
		expect(locale.License).toBe("BUSL-1.1");
		expect(locale.ManifestType).toBe("defaultLocale");
		expect(locale.ShortDescription.length).toBeLessThanOrEqual(256);
		expect(locale.Tags.length).toBeGreaterThan(0);
		expect(locale.LicenseUrl).toBe(`https://github.com/${REPO}/blob/${TAG}/LICENSE`);
	});

	it("carries the schema header winget validate reads", () => {
		installer("HERMES-IDE_1.4.1_x64-setup.exe");
		const { files } = buildWingetManifests(rel, { tag: TAG, repo: REPO, outDir: out });
		for (const [name, text] of Object.entries(files)) {
			expect(text.split("\n")[0], name).toMatch(/^# yaml-language-server: \$schema=https:\/\/aka\.ms\/winget-manifest\.(version|installer|defaultLocale)\.1\.10\.0\.schema\.json$/);
		}
	});

	it("takes the app version separately for a dry-run tag, and URLs still point at that tag", () => {
		installer("HERMES-IDE_1.4.1_x64-setup.exe");
		const tag = "v0.0.0-dryrun-7";
		const { dir, installers } = buildWingetManifests(rel, { tag, repo: REPO, outDir: out, version: "1.4.1" });
		expect(dir.endsWith(join("HermesIDE", "1.4.1"))).toBe(true);
		expect(read(dir, `${PACKAGE_IDENTIFIER}.yaml`).PackageVersion).toBe("1.4.1");
		expect(installers[0].url).toBe(`https://github.com/${REPO}/releases/download/${tag}/HERMES-IDE_1.4.1_x64-setup.exe`);
		// Without it, the tag's own version must match the installer.
		expect(() => buildWingetManifests(rel, { tag, repo: REPO, outDir: out })).toThrow(/not the 0.0.0-dryrun-7 installer/);
		expect(() => buildWingetManifests(rel, { tag, repo: REPO, outDir: out, version: "nope" })).toThrow(/not a version/);
	});

	it("works with only the x64 installer (a partial build)", () => {
		installer("HERMES-IDE_1.4.1_x64-setup.exe");
		const { installers } = buildWingetManifests(rel, { tag: TAG, repo: REPO, outDir: out });
		expect(installers.map((i) => i.architecture)).toEqual(["x64"]);
	});

	it("refuses a release without an installer, or with one for another version", () => {
		expect(() => buildWingetManifests(rel, { tag: TAG, repo: REPO, outDir: out })).toThrow(/no NSIS installer/);
		installer("HERMES-IDE_1.4.0_x64-setup.exe");
		expect(() => buildWingetManifests(rel, { tag: TAG, repo: REPO, outDir: out })).toThrow(/not the 1.4.1 installer/);
	});

	it("quotes every value YAML could misread", () => {
		expect(yamlScalar("user")).toBe("user");
		expect(yamlScalar("1.4.1")).toBe('"1.4.1"');
		expect(yamlScalar("yes")).toBe('"yes"');
		expect(yamlScalar("a: b")).toBe('"a: b"');
		expect(yamlScalar("#hash")).toBe('"#hash"');
		expect(yamlScalar("https://example.test/x")).toBe("https://example.test/x");
		expect(yamlScalar("It's a terminal, for agents.")).toBe(JSON.stringify("It's a terminal, for agents."));
		for (const v of ["1.4.1", "yes", "a: b", "#hash", "It's a terminal, for agents.", "x64"]) {
			expect(parseYaml(`k: ${yamlScalar(v)}\n`).k).toBe(v);
		}
	});
});
