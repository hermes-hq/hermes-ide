// Build and lint the two manifests a release ships:
//
//   latest.json     read by the in-app updater (Tauri updater format)
//   downloads.json  read by the website's download page
//
//   node scripts/ci/release-manifests.mjs build <dir> --tag vX.Y.Z --repo owner/name
//   node scripts/ci/release-manifests.mjs lint  <dir> --tag vX.Y.Z [--expect key,key] [--pubkey <b64>]
//
// `dir` holds every file the release will carry. Asset naming, as produced
// by the release workflow:
//   installers (unprefixed):   HERMES-IDE_1.4.1_aarch64.dmg, HERMES-IDE_1.4.1_x64.dmg,
//                              HERMES-IDE_1.4.1_amd64.deb (+ .sig), HERMES-IDE_1.4.1_arm64.deb (+ .sig),
//                              HERMES-IDE_1.4.1_amd64.AppImage (+ .sig), HERMES-IDE_1.4.1_aarch64.AppImage (+ .sig),
//                              HERMES-IDE_1.4.1_x64-setup.exe, HERMES-IDE_1.4.1_arm64-setup.exe
//   updater bundles (prefixed with the platform key, because the macOS
//   archive has the same name on both architectures):
//                              darwin-aarch64-HERMES-IDE.app.tar.gz (+ .sig)
//                              darwin-x86_64-HERMES-IDE.app.tar.gz (+ .sig)
//                              windows-x86_64-HERMES-IDE_1.4.1_x64-setup.exe (+ .sig)
//                              windows-aarch64-HERMES-IDE_1.4.1_arm64-setup.exe (+ .sig)
//   The .deb and the AppImage are their own updater bundles (Tauri signs
//   them at build time), so each is uploaded once and referenced by both
//   manifests.
//
// Zero dependencies (Node 20+).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyFile } from "./minisign.mjs";

/** Updater platform keys the Tauri client asks for, and the file each maps to. */
export const UPDATER_PLATFORMS = [
  { key: "darwin-aarch64", pattern: /^darwin-aarch64-.*\.app\.tar\.gz$/ },
  { key: "darwin-x86_64", pattern: /^darwin-x86_64-.*\.app\.tar\.gz$/ },
  // The updater looks up `{os}-{arch}-{bundle}` first, then `{os}-{arch}`.
  // A .deb install asks for `-deb`, an AppImage for `-appimage`. An
  // AppImage that does not report its bundle type (older builds) asks only
  // for the plain `linux-*` key, so that points at the AppImage too. The
  // lint makes sure a `-deb` key always exists next to a plain one, or .deb
  // installs would fall back to the plain key and fetch an AppImage.
  { key: "linux-x86_64-deb", pattern: /^[^/]*_amd64\.deb$/ },
  { key: "linux-aarch64-deb", pattern: /^[^/]*_arm64\.deb$/ },
  { key: "linux-x86_64-appimage", pattern: /^[^/]*_amd64\.AppImage$/ },
  { key: "linux-aarch64-appimage", pattern: /^[^/]*_aarch64\.AppImage$/ },
  { key: "linux-x86_64", pattern: /^[^/]*_amd64\.AppImage$/ },
  { key: "linux-aarch64", pattern: /^[^/]*_aarch64\.AppImage$/ },
  { key: "windows-x86_64", pattern: /^windows-x86_64-.*-setup\.exe$/ },
  { key: "windows-aarch64", pattern: /^windows-aarch64-.*-setup\.exe$/ },
];

/** Installers the download page lists. Prefixed updater copies are excluded. */
export const DOWNLOADS = [
  { platform: "macos", arch: "aarch64", format: "dmg", pattern: /_aarch64\.dmg$/ },
  // Tauri names the Intel build `_x64.dmg`; the old `_x86_64` pattern never matched.
  { platform: "macos", arch: "x86_64", format: "dmg", pattern: /_x64\.dmg$/ },
  { platform: "linux", arch: "x86_64", format: "deb", pattern: /_amd64\.deb$/ },
  { platform: "linux", arch: "aarch64", format: "deb", pattern: /_arm64\.deb$/ },
  { platform: "linux", arch: "x86_64", format: "appimage", pattern: /_amd64\.AppImage$/ },
  { platform: "linux", arch: "aarch64", format: "appimage", pattern: /_aarch64\.AppImage$/ },
  { platform: "windows", arch: "x86_64", format: "exe", pattern: /_x64-setup\.exe$/ },
  { platform: "windows", arch: "aarch64", format: "exe", pattern: /_arm64-setup\.exe$/ },
];

/** File name patterns that count as an installer a user could download. */
const INSTALLER_PATTERN = /\.(dmg|deb|msi|AppImage)$|-setup\.exe$/;
const UPDATER_PREFIX = /^(darwin|linux|windows)-(aarch64|x86_64)-/;

export function versionFromTag(tag) {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag || "").trim());
  if (!m) throw new Error(`tag must look like vX.Y.Z, got ${JSON.stringify(tag)}`);
  return m[1];
}

function listFiles(dir) {
  return readdirSync(dir).filter((f) => !f.startsWith(".")).sort();
}

function pick(files, pattern, { excludePrefixed = false } = {}) {
  return files.filter((f) => pattern.test(f) && !f.endsWith(".sig") && (!excludePrefixed || !UPDATER_PREFIX.test(f)));
}

// ─── build ───────────────────────────────────────────────────────────

export function buildManifests(dir, { tag, repo, pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), notes } = {}) {
  const version = versionFromTag(tag);
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("--repo owner/name is required");
  const files = listFiles(dir);
  const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

  const platforms = {};
  for (const { key, pattern } of UPDATER_PLATFORMS) {
    const matches = pick(files, pattern);
    if (matches.length === 0) continue;
    if (matches.length > 1) throw new Error(`${key}: more than one candidate file: ${matches.join(", ")}`);
    const name = matches[0];
    const sigFile = join(dir, `${name}.sig`);
    if (!existsSync(sigFile)) throw new Error(`${key}: ${name} has no ${name}.sig next to it`);
    platforms[key] = { signature: readFileSync(sigFile, "utf8").trim(), url: `${baseUrl}/${name}` };
  }

  const downloads = {};
  for (const { platform, arch, format, pattern } of DOWNLOADS) {
    const matches = pick(files, pattern, { excludePrefixed: true });
    if (matches.length === 0) continue;
    if (matches.length > 1) throw new Error(`${platform}/${arch}/${format}: more than one candidate file: ${matches.join(", ")}`);
    downloads[platform] ??= {};
    downloads[platform][arch] ??= {};
    downloads[platform][arch][format] = matches[0];
  }

  const latest = {
    version,
    notes: notes ?? `Hermes IDE ${version} — release notes: https://github.com/${repo}/releases/tag/${tag}`,
    pub_date: pubDate,
    platforms,
  };
  const downloadsJson = { version, platforms: downloads };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
  writeFileSync(join(dir, "downloads.json"), JSON.stringify(downloadsJson, null, 2) + "\n");
  return { latest, downloads: downloadsJson };
}

// ─── lint ────────────────────────────────────────────────────────────

/**
 * Returns the list of problems (empty = clean).
 * `expect`: updater keys that must be present (default: all six).
 * `pubkey`: Tauri updater public key; every signature is verified with it.
 */
export function lintManifests(dir, { tag, expect = UPDATER_PLATFORMS.map((p) => p.key), pubkey } = {}) {
  const problems = [];
  const version = versionFromTag(tag);
  const files = listFiles(dir);

  const readJson = (name) => {
    const p = join(dir, name);
    if (!existsSync(p)) {
      problems.push(`${name}: missing`);
      return null;
    }
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      problems.push(`${name}: not valid JSON (${e.message})`);
      return null;
    }
  };

  // latest.json
  const latest = readJson("latest.json");
  if (latest) {
    if (latest.version !== version) problems.push(`latest.json: version ${JSON.stringify(latest.version)} does not match tag ${tag}`);
    if (!latest.pub_date || Number.isNaN(Date.parse(latest.pub_date))) problems.push("latest.json: pub_date is missing or not a date");
    const platforms = latest.platforms && typeof latest.platforms === "object" ? latest.platforms : {};
    const keys = Object.keys(platforms);
    if (keys.length === 0) problems.push("latest.json: no platforms");
    for (const key of expect) {
      if (!keys.includes(key)) problems.push(`latest.json: missing platform ${key}`);
    }
    for (const key of keys) {
      if (/^linux-(x86_64|aarch64)$/.test(key) && !keys.includes(`${key}-deb`)) {
        problems.push(`latest.json: ${key} exists without ${key}-deb — .deb installs would fetch the wrong bundle`);
      }
      const entry = platforms[key] || {};
      if (typeof entry.url !== "string" || !entry.url.startsWith("https://")) {
        problems.push(`latest.json: ${key}: url must be https`);
        continue;
      }
      const name = basename(new URL(entry.url).pathname);
      if (!entry.url.includes(`/releases/download/${tag}/`)) problems.push(`latest.json: ${key}: url does not point at release ${tag}`);
      const def = UPDATER_PLATFORMS.find((p) => p.key === key);
      if (def && !def.pattern.test(name)) problems.push(`latest.json: ${key}: points at ${name}, which is not a bundle for ${key}`);
      if (!files.includes(name)) {
        problems.push(`latest.json: ${key}: ${name} is not among the release files`);
        continue;
      }
      if (typeof entry.signature !== "string" || entry.signature.trim() === "") {
        problems.push(`latest.json: ${key}: empty signature`);
        continue;
      }
      const sigFile = join(dir, `${name}.sig`);
      if (!existsSync(sigFile)) problems.push(`latest.json: ${key}: ${name}.sig is not among the release files`);
      else if (readFileSync(sigFile, "utf8").trim() !== entry.signature.trim()) problems.push(`latest.json: ${key}: signature differs from ${name}.sig`);
      if (pubkey) {
        const res = verifyFile(pubkey, entry.signature, join(dir, name));
        if (!res.ok) problems.push(`latest.json: ${key}: signature does not verify (${res.reason})`);
        else if (res.trustedComment && !res.trustedComment.includes(`file:${name.replace(UPDATER_PREFIX, "")}`)) {
          problems.push(`latest.json: ${key}: signature was made for another file (${res.trustedComment})`);
        }
      }
    }
  }

  // downloads.json
  const downloads = readJson("downloads.json");
  if (downloads) {
    if (downloads.version !== version) problems.push(`downloads.json: version ${JSON.stringify(downloads.version)} does not match tag ${tag}`);
    const listed = new Set();
    for (const [platform, archs] of Object.entries(downloads.platforms || {})) {
      for (const [arch, formats] of Object.entries(archs || {})) {
        for (const [format, name] of Object.entries(formats || {})) {
          listed.add(name);
          if (!files.includes(name)) problems.push(`downloads.json: ${platform}/${arch}/${format}: ${name} is not among the release files`);
        }
      }
    }
    for (const f of files) {
      if (INSTALLER_PATTERN.test(f) && !UPDATER_PREFIX.test(f) && !listed.has(f)) {
        problems.push(`downloads.json: installer ${f} is not listed`);
      }
    }
    for (const { platform, arch, format } of DOWNLOADS) {
      const wanted = expect.some((k) => k.startsWith(`${platform === "macos" ? "darwin" : platform}-${arch}`));
      if (wanted && !downloads.platforms?.[platform]?.[arch]?.[format]) {
        problems.push(`downloads.json: missing ${platform}/${arch}/${format}`);
      }
    }
  }

  // Every updater bundle present must have its signature file.
  for (const { key, pattern } of UPDATER_PLATFORMS) {
    for (const name of pick(files, pattern)) {
      if (!files.includes(`${name}.sig`)) problems.push(`${key}: ${name} has no signature file`);
    }
  }
  // Nothing we no longer ship.
  for (const f of files) {
    if (/\.msi(\.sig)?$/.test(f)) problems.push(`${f}: MSI installers are not shipped any more (the updater installs with NSIS)`);
  }
  // Checksums, when present, must cover every file.
  if (files.includes("SHA256SUMS.txt")) {
    const summed = new Set(
      readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+\*?/)[1])
        .filter(Boolean),
    );
    for (const f of files) {
      if (["SHA256SUMS.txt", "latest.json", "downloads.json"].includes(f)) continue;
      if (!summed.has(f)) problems.push(`SHA256SUMS.txt: ${f} is not listed`);
    }
  }
  return problems;
}

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const [command, dir, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    opts[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
  }
  return { command, dir, opts };
}

function readPubkeyFromConfig() {
  const conf = new URL("../../src-tauri/tauri.conf.json", import.meta.url);
  return JSON.parse(readFileSync(conf, "utf8")).plugins.updater.pubkey;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { command, dir, opts } = parseArgs(process.argv.slice(2));
  if (!dir || !existsSync(dir)) {
    console.error("usage: release-manifests.mjs <build|lint> <dir> --tag vX.Y.Z [--repo owner/name] [--expect a,b] [--pubkey b64]");
    process.exit(2);
  }
  if (command === "build") {
    const { latest, downloads } = buildManifests(dir, { tag: opts.tag, repo: opts.repo, notes: opts.notes });
    console.log("latest.json platforms:", Object.keys(latest.platforms).join(", ") || "(none)");
    console.log("downloads.json:", JSON.stringify(downloads.platforms));
  } else if (command === "lint") {
    const expect = opts.expect ? opts.expect.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const pubkey = opts.pubkey === "none" ? undefined : opts.pubkey || readPubkeyFromConfig();
    const problems = lintManifests(dir, { tag: opts.tag, expect, pubkey });
    if (problems.length) {
      console.error(`manifest lint: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`manifest lint: clean (${listFiles(dir).length} files, tag ${opts.tag})`);
  } else {
    console.error(`unknown command ${command}`);
    process.exit(2);
  }
}
