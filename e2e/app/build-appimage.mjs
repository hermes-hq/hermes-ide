#!/usr/bin/env node
// Builds two TEST AppImages for the F25 update scenario (Linux only):
// the test app (the `e2e` feature, identifier com.hermes-ide.terminal.e2e)
// bundled as a real AppImage, once as version 0.9.0 ("old") and once as
// 0.9.1 ("new"), both signed for the updater with a throwaway key made
// here. Nothing here uses the release signing key.
//
//   node e2e/app/build-appimage.mjs            # → <HERMES_E2E_OUT>/appimage/
//   node e2e/app/build-appimage.mjs --out DIR
//
// Writes, into the output folder:
//   hermes-e2e-old.AppImage (+ .sig), hermes-e2e-new.AppImage (+ .sig)
//   the .deb of each version (+ .sig), so the scenario can publish a full
//   Linux release: the AppImage must pick its own entry, not the .deb's
//   appimages.json   { pubkey, old: { version, file, sig, deb, stamp, sha256 }, new: {…} }
//
// The bridge runtime is packed with a fast zstd level: the scenario is about
// the AppImage and its updater, not the archive size.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, outDir } from "./harness.mjs";
import { buildStamp, hashTree } from "./build-stamp.mjs";

export const APPIMAGE_VERSIONS = [
  { name: "old", version: "0.9.0" },
  { name: "new", version: "0.9.1" },
];

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", ...opts });
  if (res.status !== 0) {
    console.error(`\n[appimage build] '${cmd}' failed with status ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

function cargoTargetDir() {
  const res = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", join(REPO_ROOT, "src-tauri", "Cargo.toml")],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout).target_directory;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (platform() !== "linux") {
    console.error("[appimage build] AppImages are built on Linux only");
    process.exit(2);
  }
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx > 0 ? resolve(process.argv[outIdx + 1]) : join(outDir(), "appimage");
  mkdirSync(out, { recursive: true });

  // A throwaway updater key: the test AppImages trust it instead of the
  // release key, so the scenario can sign "updates" itself.
  const keyFile = join(out, "updater-test.key");
  run("npx", ["tauri", "signer", "generate", "--ci", "--force", "--write-keys", keyFile]);
  const pubkey = readFileSync(`${keyFile}.pub`, "utf8").trim();

  run("npx", ["vite", "build"], { env: { ...process.env, VITE_HERMES_E2E: "1" } });
  run(process.execPath, [join(REPO_ROOT, "scripts", "pack-bridge-runtime.mjs"), "--level", "3"]);

  const distHash = hashTree(join(REPO_ROOT, "dist"));
  const bundleDir = join(cargoTargetDir(), "debug", "bundle", "appimage");
  const debDir = join(cargoTargetDir(), "debug", "bundle", "deb");
  const info = { pubkey };
  for (const { name, version } of APPIMAGE_VERSIONS) {
    const stamp = `${buildStamp({ repoRoot: REPO_ROOT, distHash })}-${name}`;
    const conf = join(out, `appimage-${name}.conf.json`);
    writeFileSync(
      conf,
      JSON.stringify({
        version,
        // No spaces in the file name: release asset names never have any, and
        // the release manifest tools are run on these files as they are.
        productName: "Hermes-IDE-E2E",
        bundle: { active: true, targets: ["appimage", "deb"], createUpdaterArtifacts: true },
        plugins: { updater: { pubkey } },
      }),
    );
    run(
      "npx",
      ["tauri", "build", "--debug", "--features", "e2e", "--bundles", "appimage,deb", "--ignore-version-mismatches", "--config", "src-tauri/tauri.e2e.conf.json", "--config", conf],
      {
        env: {
          ...process.env,
          HERMES_E2E_BUILD_STAMP: stamp,
          TAURI_SIGNING_PRIVATE_KEY: keyFile,
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
        },
      },
    );
    const built = readdirSync(bundleDir).find((f) => f.endsWith(".AppImage") && f.includes(`_${version}_`));
    if (!built || !existsSync(join(bundleDir, `${built}.sig`))) {
      console.error(`[appimage build] no signed ${version} AppImage in ${bundleDir}: ${readdirSync(bundleDir).join(", ")}`);
      process.exit(1);
    }
    const deb = readdirSync(debDir).find((f) => f.endsWith(".deb") && f.includes(`_${version}_`));
    if (!deb || !existsSync(join(debDir, `${deb}.sig`))) {
      console.error(`[appimage build] no signed ${version} .deb in ${debDir}: ${readdirSync(debDir).join(", ")}`);
      process.exit(1);
    }
    const file = join(out, `hermes-e2e-${name}.AppImage`);
    copyFileSync(join(bundleDir, built), file);
    copyFileSync(join(bundleDir, `${built}.sig`), `${file}.sig`);
    const debFile = join(out, deb);
    copyFileSync(join(debDir, deb), debFile);
    copyFileSync(join(debDir, `${deb}.sig`), `${debFile}.sig`);
    info[name] = { version, file, sig: `${file}.sig`, builtAs: built, deb: debFile, debName: deb, stamp, sha256: sha256(file) };
    console.log(`[appimage build] ${name}: ${built} → ${file}`);
  }
  writeFileSync(join(out, "appimages.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(`\n[appimage build] ready: ${join(out, "appimages.json")}`);
}
