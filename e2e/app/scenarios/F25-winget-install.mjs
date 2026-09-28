#!/usr/bin/env node
// Scenario F25 (Windows): "winget install" works with the manifests the
// release workflow prepares.
//
// Uses the newest published release's real (unsigned) NSIS installer, the
// same file users download:
//
//   1. the manifests are generated from that installer with
//      scripts/ci/winget-manifests.mjs, exactly as the release workflow does,
//      and `winget validate` accepts them;
//   2. negative control: a manifest whose installer hash is wrong is refused
//      by `winget install` and installs nothing;
//   3. `winget install --manifest` installs Hermes for the current user:
//      the executable is there and Windows lists the app under the product
//      code the manifest names, at the manifest's version;
//   4. `winget list` sees it under that product code, at that version.
//
// Submitting the manifests to microsoft/winget-pkgs is a human step (a
// one-time CLA) and is not done here.
//
// Needs `gh` (GH_TOKEN) to download the release asset, `winget`, and an
// administrator shell (to allow local manifests). CI runners have all three.
// HERMES_E2E_RELEASE_TAG picks the release (default: the newest stable one);
// the release workflow runs this against every release it publishes.
//
//   node e2e/app/scenarios/F25-winget-install.mjs

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, outDir } from "../harness.mjs";
import { PACKAGE, PACKAGE_IDENTIFIER, buildWingetManifests } from "../../../scripts/ci/winget-manifests.mjs";

const SCENARIO = "F25-winget-install";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const REPO = process.env.HERMES_E2E_RELEASE_REPO || "hermes-hq/hermes-ide";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

function sh(cmd, args, { allowFail = false, timeoutMs = 600_000 } = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`
    // winget draws progress bars with carriage returns and block characters.
    .replace(/\r(?!\n)/g, "\n")
    .split("\n")
    .filter((l) => l.trim() && !/^[\s\-\\|/█▒]+$/.test(l) && !/^\s*[█▒]+/.test(l))
    .join("\n");
  log(`  $ ${cmd} ${args.join(" ")}  → exit ${res.status}${res.error ? ` (${res.error.message})` : ""}`);
  if (out) log(out.split("\n").map((l) => `      ${l}`).join("\n"));
  if (!allowFail && res.status !== 0) throw new Error(`${cmd} ${args[0]} failed with exit ${res.status}`);
  return { code: res.status, out };
}

const exePath = () => join(process.env.LOCALAPPDATA ?? "", PACKAGE.productCode, "hermes-ide.exe");
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PACKAGE.productCode}`;
function registeredVersion() {
  const r = spawnSync("reg", ["query", UNINSTALL_KEY, "/v", "DisplayVersion"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  return /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(r.stdout)?.[1] ?? null;
}

const wingetArgs = ["--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"];

let failed = false;
const work = mkdtempSync(join(tmpdir(), "hermes-e2e-winget-"));
let installedDir = null;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  if (platform() !== "win32") throw new Error("winget runs on Windows only");
  assert(!existsSync(exePath()) && registeredVersion() === null, "Hermes is not installed for this user before the test");

  // ── 1. Manifests from the newest release's installer ─────────────
  log("step 1: generate the manifests from the newest release's NSIS installer and validate them");
  // The newest stable release, or the one the release workflow just published.
  const wanted = process.env.HERMES_E2E_RELEASE_TAG ? [process.env.HERMES_E2E_RELEASE_TAG] : [];
  const viewed = spawnSync("gh", ["release", "view", ...wanted, "--repo", REPO, "--json", "tagName,assets"], { encoding: "utf8", windowsHide: true });
  if (viewed.status !== 0) throw new Error(`gh release view failed: ${viewed.stderr}`);
  const view = JSON.parse(viewed.stdout);
  const tag = view.tagName;
  const asset = view.assets.map((a) => a.name).find((n) => /^HERMES-IDE_[^/]*_x64-setup\.exe$/.test(n));
  assert(!!asset, `release ${tag} has an x64 NSIS installer (${asset})`);
  const releaseDir = join(work, "release");
  mkdirSync(releaseDir, { recursive: true });
  sh("gh", ["release", "download", tag, "--repo", REPO, "--pattern", asset, "--dir", releaseDir]);
  const { dir, installers } = buildWingetManifests(releaseDir, { tag, repo: REPO, outDir: join(work, "winget") });
  cpSync(dir, join(evidenceDir, "manifests"), { recursive: true });
  assert(installers.length === 1 && installers[0].architecture === "x64", `x64 installer, sha256 ${installers[0].sha256.slice(0, 16)}…`);
  const version = tag.replace(/^v/, "");
  sh("winget", ["--version"]);
  const validated = sh("winget", ["validate", "--manifest", dir], { allowFail: true });
  assert(validated.code === 0, "winget validate accepts the manifests");
  sh("winget", ["settings", "--enable", "LocalManifestFiles"]);

  // ── 2. Negative control: wrong hash ──────────────────────────────
  log("step 2: negative control — an installer hash that does not match is refused");
  const bad = join(work, "bad");
  cpSync(dir, bad, { recursive: true });
  const installerYaml = readdirSync(bad).find((f) => f.endsWith(".installer.yaml"));
  const text = readFileSync(join(bad, installerYaml), "utf8");
  writeFileSync(join(bad, installerYaml), text.replace(/InstallerSha256: [0-9A-F]{64}/, `InstallerSha256: ${"0".repeat(64)}`));
  const refused = sh("winget", ["install", "--manifest", bad, ...wingetArgs], { allowFail: true });
  assert(refused.code !== 0, `winget refuses the installer (exit ${refused.code})`);
  assert(/hash/i.test(refused.out), "the reason given is the hash");
  assert(!existsSync(exePath()) && registeredVersion() === null, "nothing was installed");

  // ── 3. Install ───────────────────────────────────────────────────
  log(`step 3: winget install --manifest (${PACKAGE_IDENTIFIER} ${version})`);
  const wingetLog = join(evidenceDir, "winget-install.log");
  const install = sh("winget", ["install", "--manifest", dir, ...wingetArgs, "--verbose-logs", "--log", wingetLog], {
    allowFail: true,
    timeoutMs: 300_000,
  });
  if (install.code !== 0) {
    // What was still running (the installer, a WebView2 setup, the app?).
    sh("tasklist", ["/FO", "CSV", "/NH"], { allowFail: true });
    // winget's own diagnostic logs (written even when it is stopped midway).
    const diag = join(process.env.LOCALAPPDATA ?? "", "Packages", "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe", "LocalState", "DiagOutputDir");
    const logs = [wingetLog, ...(existsSync(diag) ? readdirSync(diag).sort().slice(-2).map((f) => join(diag, f)) : [])];
    for (const file of logs.filter((f) => existsSync(f))) {
      log(`  --- ${file} (last lines)`);
      log(readFileSync(file, "utf8").split(/\r?\n/).slice(-60).map((l) => `      | ${l}`).join("\n"));
    }
  }
  assert(install.code === 0, `winget install succeeds (exit ${install.code})`);
  installedDir = join(process.env.LOCALAPPDATA ?? "", PACKAGE.productCode);
  assert(existsSync(exePath()), `the app is installed for the current user (${exePath()})`);
  assert(registeredVersion() === version, `Windows lists ${PACKAGE.productCode} ${registeredVersion()} under the manifest's product code`);

  // ── 4. Uninstall ─────────────────────────────────────────────────
  // ── 4. winget sees the installed app ─────────────────────────────
  // What `winget upgrade` needs later: the Apps & features entry under the
  // manifest's product code, at the installed version.
  log("step 4: winget lists the installed app");
  const listed = sh("winget", ["list", "--name", PACKAGE.productCode, "--exact", "--accept-source-agreements", "--disable-interactivity"], {
    allowFail: true,
  });
  assert(listed.code === 0 && listed.out.includes(PACKAGE.productCode) && listed.out.includes(version), `winget lists ${PACKAGE.productCode} ${version}`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
} finally {
  // Never leave an install behind on a runner that continues with other steps.
  if (installedDir && existsSync(join(installedDir, "uninstall.exe"))) {
    spawnSync(join(installedDir, "uninstall.exe"), ["/S"], { timeout: 120_000, windowsHide: true });
  }
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
