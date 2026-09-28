// Windows Package Manager (winget) manifests for a release.
//
//   node scripts/ci/winget-manifests.mjs <release dir> --tag vX.Y.Z --repo owner/name --out <dir> [--version X.Y.Z]
//
// --version is the app's version when the tag does not carry it (a dry run
// such as v0.0.0-dryrun-3 builds the app's real version).
//
// Reads the NSIS installers in <release dir> (HERMES-IDE_<v>_x64-setup.exe,
// HERMES-IDE_<v>_arm64-setup.exe), and writes the three files winget-pkgs
// expects, in its folder layout:
//
//   <out>/manifests/h/HermesHQ/HermesIDE/<version>/HermesHQ.HermesIDE.yaml
//   <out>/manifests/h/HermesHQ/HermesIDE/<version>/HermesHQ.HermesIDE.installer.yaml
//   <out>/manifests/h/HermesHQ/HermesIDE/<version>/HermesHQ.HermesIDE.locale.en-US.yaml
//
// The installers are unsigned (no Windows signing identity yet); winget
// accepts unsigned installers. Submitting to microsoft/winget-pkgs is a
// separate, human step (a one-time CLA): the release workflow only prepares
// these files and `winget validate`s them.
//
// Zero dependencies (Node 20+).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { versionFromTag } from "./release-manifests.mjs";

export const PACKAGE_IDENTIFIER = "HermesHQ.HermesIDE";
export const MANIFEST_VERSION = "1.10.0";
const SCHEMA = (kind) => `https://aka.ms/winget-manifest.${kind}.${MANIFEST_VERSION}.schema.json`;

/** NSIS installers winget installs, by winget architecture. */
export const WINGET_INSTALLERS = [
	{ architecture: "x64", pattern: /^HERMES-IDE_[^/]*_x64-setup\.exe$/ },
	{ architecture: "arm64", pattern: /^HERMES-IDE_[^/]*_arm64-setup\.exe$/ },
];

/** Package facts that do not change per release. */
export const PACKAGE = {
	publisher: "Hermes HQ",
	packageName: "Hermes IDE",
	// Tauri's NSIS installer registers the app under its product name.
	productCode: "HERMES-IDE",
	license: "BUSL-1.1",
	shortDescription: "AI-native terminal and IDE for coding agents.",
	description:
		"Hermes IDE is a terminal built for working with AI coding agents. It runs any shell and any agent CLI, " +
		"keeps sessions, projects and worktrees together, and shows what each agent is doing.",
	tags: ["terminal", "ide", "ai", "agents", "developer-tools"],
	homepage: "https://hermes-ide.com",
};

function sha256Upper(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

/** A YAML scalar, quoted whenever plain style could be misread. */
export function yamlScalar(value) {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const s = String(value);
	const plain =
		/^[A-Za-z0-9][A-Za-z0-9 ._/:+-]*$/.test(s) &&
		!/: |\s$|:$/.test(s) &&
		!/^(true|false|yes|no|on|off|null|~)$/i.test(s) &&
		!/^[0-9.+-]+$/.test(s);
	return plain ? s : JSON.stringify(s);
}

function yamlDoc(schemaKind, lines) {
	return [`# yaml-language-server: $schema=${SCHEMA(schemaKind)}`, "", ...lines, `ManifestType: ${schemaKind}`, `ManifestVersion: ${MANIFEST_VERSION}`, ""].join(
		"\n",
	);
}

const kv = (key, value, indent = "") => `${indent}${key}: ${yamlScalar(value)}`;

/**
 * Build the three manifests. Returns { dir, files: { name: text }, installers }.
 * `releaseDate` defaults to today (UTC).
 */
export function buildWingetManifests(releaseDir, { tag, repo, outDir, version = versionFromTag(tag), releaseDate = new Date().toISOString().slice(0, 10) }) {
	versionFromTag(tag); // the tag must still be well-formed
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) throw new Error(`not a version: ${JSON.stringify(version)}`);
	if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("--repo owner/name is required");
	const files = readdirSync(releaseDir).sort();
	const installers = [];
	for (const { architecture, pattern } of WINGET_INSTALLERS) {
		const matches = files.filter((f) => pattern.test(f));
		if (matches.length === 0) continue;
		if (matches.length > 1) throw new Error(`${architecture}: more than one installer: ${matches.join(", ")}`);
		const name = matches[0];
		if (!name.includes(`_${version}_`)) throw new Error(`${name} is not the ${version} installer`);
		installers.push({
			architecture,
			name,
			url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
			sha256: sha256Upper(join(releaseDir, name)),
		});
	}
	if (installers.length === 0) throw new Error(`no NSIS installer (HERMES-IDE_*_x64-setup.exe) in ${releaseDir}`);

	const base = `${PACKAGE_IDENTIFIER}`;
	const versionYaml = yamlDoc("version", [kv("PackageIdentifier", PACKAGE_IDENTIFIER), kv("PackageVersion", version), kv("DefaultLocale", "en-US")]);
	const installerYaml = yamlDoc("installer", [
		kv("PackageIdentifier", PACKAGE_IDENTIFIER),
		kv("PackageVersion", version),
		kv("InstallerLocale", "en-US"),
		kv("InstallerType", "nullsoft"),
		// Tauri's NSIS installer installs for the current user by default.
		kv("Scope", "user"),
		"InstallModes:",
		"- interactive",
		"- silent",
		"- silentWithProgress",
		kv("UpgradeBehavior", "install"),
		kv("ProductCode", PACKAGE.productCode),
		kv("ReleaseDate", releaseDate),
		"AppsAndFeaturesEntries:",
		`- ${kv("DisplayName", PACKAGE.productCode)}`,
		`  ${kv("ProductCode", PACKAGE.productCode)}`,
		"Installers:",
		...installers.flatMap((i) => [`- ${kv("Architecture", i.architecture)}`, `  ${kv("InstallerUrl", i.url)}`, `  ${kv("InstallerSha256", i.sha256)}`]),
	]);
	const localeYaml = yamlDoc("defaultLocale", [
		kv("PackageIdentifier", PACKAGE_IDENTIFIER),
		kv("PackageVersion", version),
		kv("PackageLocale", "en-US"),
		kv("Publisher", PACKAGE.publisher),
		kv("PublisherUrl", `https://github.com/${repo.split("/")[0]}`),
		kv("PublisherSupportUrl", `https://github.com/${repo}/issues`),
		kv("PackageName", PACKAGE.packageName),
		kv("PackageUrl", PACKAGE.homepage),
		kv("License", PACKAGE.license),
		kv("LicenseUrl", `https://github.com/${repo}/blob/${tag}/LICENSE`),
		kv("ShortDescription", PACKAGE.shortDescription),
		kv("Description", PACKAGE.description),
		kv("Moniker", "hermes-ide"),
		"Tags:",
		...PACKAGE.tags.map((t) => `- ${yamlScalar(t)}`),
		kv("ReleaseNotesUrl", `https://github.com/${repo}/releases/tag/${tag}`),
	]);

	const dir = join(outDir, "manifests", "h", "HermesHQ", "HermesIDE", version);
	const out = {
		[`${base}.yaml`]: versionYaml,
		[`${base}.installer.yaml`]: installerYaml,
		[`${base}.locale.en-US.yaml`]: localeYaml,
	};
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(out)) writeFileSync(join(dir, name), text);
	return { dir, files: out, installers };
}

// ─── CLI ─────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [releaseDir, ...rest] = process.argv.slice(2);
	const opts = {};
	for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, "")] = rest[i + 1];
	if (!releaseDir || !existsSync(releaseDir) || !opts.tag || !opts.repo || !opts.out) {
		console.error("usage: winget-manifests.mjs <release dir> --tag vX.Y.Z --repo owner/name --out <dir>");
		process.exit(2);
	}
	try {
		const { dir, installers } = buildWingetManifests(releaseDir, {
			tag: opts.tag,
			repo: opts.repo,
			outDir: opts.out,
			...(opts.version ? { version: opts.version } : {}),
		});
		console.log(`winget manifests for ${installers.map((i) => i.architecture).join(", ")} written to ${dir}`);
	} catch (e) {
		console.error(`winget manifests: ${e.message}`);
		process.exit(1);
	}
}
