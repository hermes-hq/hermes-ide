/**
 * Release train scripts: manifest build + lint (with real signature
 * verification) and the version bump. Every test builds its own synthetic
 * release folder in a temp directory and runs the real functions on it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { keyPairFromSeed, signBytes, verifyBytes, parsePublicKey, parseSignature } from "../../scripts/ci/minisign.mjs";
import { buildManifests, lintManifests, versionFromTag } from "../../scripts/ci/release-manifests.mjs";
import { applyVersion, bumpCargoLock, bumpPackageLock, notesNameVersion, planVersion } from "../../scripts/bump-version.mjs";

const TAG = "v1.4.1";
const REPO = "example-org/example-app";
const keys = keyPairFromSeed(Buffer.alloc(32, 7));
const otherKeys = keyPairFromSeed(Buffer.alloc(32, 9), "fedcba9876543210");

let dir: string;
/** Bytes of every fake asset and signature this test wrote, by file name. */
let written: Map<string, Buffer | string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hermes-release-"));
  written = new Map();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a fake asset and, when `sign` is true, a matching .sig next to it. */
function asset(name: string, { sign = false, signer = keys, comment }: { sign?: boolean; signer?: typeof keys; comment?: string } = {}) {
  const data = Buffer.concat([Buffer.from(name), randomBytes(64)]);
  writeFileSync(join(dir, name), data);
  written.set(name, data);
  if (sign) {
    const plain = name.replace(/^(darwin|linux|windows)-(aarch64|x86_64)-/, "");
    const sig = signBytes(signer, data, comment ?? `timestamp:1700000000\tfile:${plain}`);
    writeFileSync(join(dir, `${name}.sig`), sig);
    written.set(`${name}.sig`, sig);
  }
  return data;
}

function fullRelease() {
  asset("HERMES-IDE_1.4.1_aarch64.dmg");
  asset("HERMES-IDE_1.4.1_x64.dmg");
  asset("HERMES-IDE_1.4.1_amd64.deb", { sign: true });
  asset("HERMES-IDE_1.4.1_arm64.deb", { sign: true });
  asset("HERMES-IDE_1.4.1_amd64.AppImage", { sign: true });
  asset("HERMES-IDE_1.4.1_aarch64.AppImage", { sign: true });
  asset("HERMES-IDE_1.4.1_x64-setup.exe");
  asset("HERMES-IDE_1.4.1_arm64-setup.exe");
  asset("darwin-aarch64-HERMES-IDE.app.tar.gz", { sign: true });
  asset("darwin-x86_64-HERMES-IDE.app.tar.gz", { sign: true });
  asset("windows-x86_64-HERMES-IDE_1.4.1_x64-setup.exe", { sign: true });
  asset("windows-aarch64-HERMES-IDE_1.4.1_arm64-setup.exe", { sign: true });
}

describe("minisign", () => {
  it("round-trips a Tauri-style signature and rejects the wrong key, data or comment", () => {
    const data = Buffer.from("hello installer");
    const sig = signBytes(keys, data, "timestamp:1\tfile:x");
    expect(verifyBytes(keys.pubkeyB64, sig, data)).toMatchObject({ ok: true, trustedComment: "timestamp:1\tfile:x" });
    expect(verifyBytes(keys.pubkeyB64, sig, Buffer.from("hello installer!")).ok).toBe(false);
    expect(verifyBytes(otherKeys.pubkeyB64, sig, data)).toMatchObject({ ok: false, reason: expect.stringContaining("signed with key") });

    // Tamper with the trusted comment: the global signature must catch it.
    const text = Buffer.from(sig, "base64").toString("utf8").replace("file:x", "file:y");
    const tampered = Buffer.from(text).toString("base64");
    expect(verifyBytes(keys.pubkeyB64, tampered, data)).toMatchObject({ ok: false, reason: expect.stringContaining("trusted comment") });
  });

  it("parses the key id from both key and signature", () => {
    const sig = signBytes(keys, Buffer.from("x"));
    expect(parsePublicKey(keys.pubkeyB64).keyId).toBe("0123456789abcdef");
    expect(parseSignature(sig).keyId).toBe("0123456789abcdef");
    expect(parseSignature(sig).algorithm).toBe("ED");
  });

  it("reports garbage instead of throwing", () => {
    expect(verifyBytes("bm90IGEga2V5", "bm90IGEgc2ln", Buffer.from("x")).ok).toBe(false);
  });
});

describe("release manifests: build", () => {
  it("lists every updater bundle with its signature and every installer for the site", () => {
    fullRelease();
    const { latest, downloads } = buildManifests(dir, { tag: TAG, repo: REPO, pubDate: "2026-01-02T03:04:05Z" });

    expect(latest.version).toBe("1.4.1");
    expect(latest.pub_date).toBe("2026-01-02T03:04:05Z");
    expect(Object.keys(latest.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-aarch64-appimage",
      "linux-aarch64-deb",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "windows-aarch64",
      "windows-x86_64",
    ]);
    expect(latest.platforms["linux-x86_64-deb"].url).toBe(
      `https://github.com/${REPO}/releases/download/${TAG}/HERMES-IDE_1.4.1_amd64.deb`,
    );
    expect(latest.platforms["linux-x86_64-deb"].signature).toBe(String(written.get("HERMES-IDE_1.4.1_amd64.deb.sig")).trim());
    expect(latest.platforms["darwin-x86_64"].url.endsWith("/darwin-x86_64-HERMES-IDE.app.tar.gz")).toBe(true);
    // An AppImage asks for -appimage (or the plain key when it does not
    // report its bundle type); a .deb install finds its own -deb key first.
    const appImageUrl = `https://github.com/${REPO}/releases/download/${TAG}/HERMES-IDE_1.4.1_amd64.AppImage`;
    expect(latest.platforms["linux-x86_64-appimage"].url).toBe(appImageUrl);
    expect(latest.platforms["linux-x86_64"].url).toBe(appImageUrl);
    expect(latest.platforms["linux-x86_64-appimage"].signature).toBe(String(written.get("HERMES-IDE_1.4.1_amd64.AppImage.sig")).trim());
    expect(latest.platforms["linux-aarch64-appimage"].url.endsWith("/HERMES-IDE_1.4.1_aarch64.AppImage")).toBe(true);
    expect(latest.platforms["linux-aarch64-deb"].url.endsWith("/HERMES-IDE_1.4.1_arm64.deb")).toBe(true);

    expect(downloads).toEqual({
      version: "1.4.1",
      platforms: {
        macos: { aarch64: { dmg: "HERMES-IDE_1.4.1_aarch64.dmg" }, x86_64: { dmg: "HERMES-IDE_1.4.1_x64.dmg" } },
        linux: {
          x86_64: { deb: "HERMES-IDE_1.4.1_amd64.deb", appimage: "HERMES-IDE_1.4.1_amd64.AppImage" },
          aarch64: { deb: "HERMES-IDE_1.4.1_arm64.deb", appimage: "HERMES-IDE_1.4.1_aarch64.AppImage" },
        },
        windows: { x86_64: { exe: "HERMES-IDE_1.4.1_x64-setup.exe" }, aarch64: { exe: "HERMES-IDE_1.4.1_arm64-setup.exe" } },
      },
    });
    // Files written where the upload step expects them: the lint reads them
    // back from disk and is clean.
    expect(existsSync(join(dir, "latest.json"))).toBe(true);
    expect(existsSync(join(dir, "downloads.json"))).toBe(true);
    expect(lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64 })).toEqual([]);
  });

  it("refuses an updater bundle without its signature file", () => {
    asset("darwin-aarch64-HERMES-IDE.app.tar.gz");
    expect(() => buildManifests(dir, { tag: TAG, repo: REPO })).toThrow(/no darwin-aarch64-HERMES-IDE.app.tar.gz.sig/);
  });

  it("requires a well-formed tag and repo", () => {
    expect(() => versionFromTag("1.4.1")).toThrow(/vX.Y.Z/);
    expect(versionFromTag("v0.0.0-dryrun-3")).toBe("0.0.0-dryrun-3");
    expect(() => buildManifests(dir, { tag: TAG })).toThrow(/--repo/);
  });
});

describe("release manifests: lint", () => {
  it("is clean for a complete, correctly signed release", () => {
    fullRelease();
    buildManifests(dir, { tag: TAG, repo: REPO });
    expect(lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64 })).toEqual([]);
  });

  it("fails when an installer lacks a signature or a list entry", () => {
    fullRelease();
    buildManifests(dir, { tag: TAG, repo: REPO });
    // Drop a signature file after the manifest was built, and add an unlisted installer.
    rmSync(join(dir, "HERMES-IDE_1.4.1_arm64.deb.sig"));
    asset("HERMES-IDE_1.4.1_x64.msi");
    asset("HERMES-IDE_1.4.1_extra_x64-setup.exe");
    const problems = lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64 });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HERMES-IDE_1.4.1_arm64.deb.sig is not among the release files"),
        expect.stringContaining("HERMES-IDE_1.4.1_arm64.deb has no signature file"),
        expect.stringContaining("installer HERMES-IDE_1.4.1_extra_x64-setup.exe is not listed"),
        expect.stringContaining("MSI installers are not shipped"),
      ]),
    );
  });

  it("fails when a signature was made with another key or for another file", () => {
    fullRelease();
    // Re-sign one bundle with a foreign key and one with a mismatching trusted comment.
    const win = written.get("windows-x86_64-HERMES-IDE_1.4.1_x64-setup.exe") as Buffer;
    writeFileSync(join(dir, "windows-x86_64-HERMES-IDE_1.4.1_x64-setup.exe.sig"), signBytes(otherKeys, win));
    const mac = written.get("darwin-aarch64-HERMES-IDE.app.tar.gz") as Buffer;
    writeFileSync(join(dir, "darwin-aarch64-HERMES-IDE.app.tar.gz.sig"), signBytes(keys, mac, "timestamp:1\tfile:HERMES-IDE_1.4.0_x64-setup.exe"));
    buildManifests(dir, { tag: TAG, repo: REPO });
    const problems = lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64 });
    expect(problems).toEqual([
      expect.stringContaining("darwin-aarch64: signature was made for another file"),
      expect.stringContaining("windows-x86_64: signature does not verify (signed with key fedcba9876543210"),
    ]);
  });

  it("fails when the manifest version does not match the tag or a platform is missing", () => {
    fullRelease();
    rmSync(join(dir, "HERMES-IDE_1.4.1_x64.dmg"));
    rmSync(join(dir, "darwin-x86_64-HERMES-IDE.app.tar.gz"));
    rmSync(join(dir, "darwin-x86_64-HERMES-IDE.app.tar.gz.sig"));
    buildManifests(dir, { tag: TAG, repo: REPO });
    const problems = lintManifests(dir, { tag: "v1.4.2", pubkey: keys.pubkeyB64 });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('latest.json: version "1.4.1" does not match tag v1.4.2'),
        expect.stringContaining("latest.json: missing platform darwin-x86_64"),
        expect.stringContaining("downloads.json: missing macos/x86_64/dmg"),
      ]),
    );
    // A partial build is fine when the caller says which platforms to expect.
    expect(
      lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64, expect: ["darwin-aarch64", "linux-x86_64-deb", "windows-x86_64"] }),
    ).toEqual([]);
  });

  it("rejects a plain linux key without its -deb twin", () => {
    fullRelease();
    const latest = structuredClone(buildManifests(dir, { tag: TAG, repo: REPO }).latest);
    latest.platforms["linux-x86_64"] = latest.platforms["linux-x86_64-deb"];
    delete latest.platforms["linux-x86_64-deb"];
    writeFileSync(join(dir, "latest.json"), JSON.stringify(latest));
    const problems = lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64 });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing platform linux-x86_64-deb"),
        expect.stringContaining("linux-x86_64 exists without linux-x86_64-deb"),
      ]),
    );
  });

  it("rejects a Linux key that points at the other kind of bundle", () => {
    fullRelease();
    const latest = structuredClone(buildManifests(dir, { tag: TAG, repo: REPO }).latest);
    // A .deb install must never be handed the AppImage, nor the other way round.
    const deb = latest.platforms["linux-x86_64-deb"];
    latest.platforms["linux-x86_64-deb"] = latest.platforms["linux-x86_64-appimage"];
    latest.platforms["linux-x86_64-appimage"] = deb;
    writeFileSync(join(dir, "latest.json"), JSON.stringify(latest));
    expect(lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64 })).toEqual([
      expect.stringContaining("linux-x86_64-deb: points at HERMES-IDE_1.4.1_amd64.AppImage"),
      expect.stringContaining("linux-x86_64-appimage: points at HERMES-IDE_1.4.1_amd64.deb"),
    ]);
  });

  it("requires the AppImage on the download page and in the updater when Linux is built", () => {
    fullRelease();
    rmSync(join(dir, "HERMES-IDE_1.4.1_aarch64.AppImage"));
    rmSync(join(dir, "HERMES-IDE_1.4.1_aarch64.AppImage.sig"));
    buildManifests(dir, { tag: TAG, repo: REPO });
    const problems = lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64 });
    expect(problems).toEqual(
      expect.arrayContaining([
        "latest.json: missing platform linux-aarch64-appimage",
        "latest.json: missing platform linux-aarch64",
        "downloads.json: missing linux/aarch64/appimage",
      ]),
    );
  });

  it("checks SHA256SUMS.txt covers every file", () => {
    fullRelease();
    buildManifests(dir, { tag: TAG, repo: REPO });
    writeFileSync(join(dir, "SHA256SUMS.txt"), "abc  HERMES-IDE_1.4.1_aarch64.dmg\n");
    const problems = lintManifests(dir, { tag: TAG, pubkey: keys.pubkeyB64 });
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining("SHA256SUMS.txt: HERMES-IDE_1.4.1_x64.dmg is not listed")]));
    expect(problems.some((p: string) => p.includes("HERMES-IDE_1.4.1_aarch64.dmg is not listed"))).toBe(false);
  });
});

describe("bump-version", () => {
  function project(version = "1.4.0", notesVersion = "1.4.1") {
    mkdirSync(join(dir, "src-tauri"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "hermes-ide", version, dependencies: { react: "^19.0.0" } }, null, 2) + "\n");
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify(
        {
          name: "hermes-ide",
          version,
          lockfileVersion: 3,
          packages: { "": { name: "hermes-ide", version, dependencies: { react: "^19.0.0" } }, "node_modules/react": { version: "19.0.0" } },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(dir, "src-tauri", "tauri.conf.json"), JSON.stringify({ productName: "HERMES-IDE", version, identifier: "com.example.app" }, null, 2) + "\n");
    writeFileSync(join(dir, "src-tauri", "Cargo.toml"), `[package]\nname = "hermes-ide"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1.0.200" }\n`);
    writeFileSync(
      join(dir, "src-tauri", "Cargo.lock"),
      `# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "hermes-ide"\nversion = "${version}"\ndependencies = [\n "serde",\n]\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
    );
    writeFileSync(join(dir, "RELEASE_NOTES.md"), `# Hermes IDE ${notesVersion}\n\nWhat changed.\n`);
  }

  it("updates every version field and nothing else", () => {
    project();
    const files = new Map(planVersion(dir, "1.4.1").map((p) => [p.path, p.after]));
    expect([...files.keys()].sort()).toEqual(["package-lock.json", "package.json", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"].sort());

    expect(JSON.parse(files.get("package.json")!).version).toBe("1.4.1");
    const lock = JSON.parse(files.get("package-lock.json")!);
    expect(lock.version).toBe("1.4.1");
    expect(lock.packages[""].version).toBe("1.4.1");
    expect(lock.packages["node_modules/react"].version).toBe("19.0.0");
    expect(JSON.parse(files.get("src-tauri/tauri.conf.json")!).version).toBe("1.4.1");
    expect(files.get("src-tauri/Cargo.toml")).toContain('version = "1.4.1"');
    expect(files.get("src-tauri/Cargo.toml")).toContain('serde = { version = "1.0.200" }');
    const cargoLock = files.get("src-tauri/Cargo.lock")!;
    expect(cargoLock).toContain('name = "hermes-ide"\nversion = "1.4.1"');
    expect(cargoLock).toContain('name = "serde"\nversion = "1.0.200"');

    // Planning wrote nothing; applying writes exactly the plan, after which
    // the tree is at 1.4.1 and a second apply has nothing left to do.
    expect(planVersion(dir, "1.4.1").map((p) => p.path).sort()).toEqual([...files.keys()].sort());
    expect(applyVersion(dir, "1.4.1").sort()).toEqual([...files.keys()].sort());
    expect(applyVersion(dir, "1.4.1")).toEqual([]);
    expect(planVersion(dir, "1.4.0", { allowStaleNotes: true }).map((p) => p.path).sort()).toEqual([...files.keys()].sort());
  });

  it("refuses when the release notes are not for the new version", () => {
    project("1.4.0", "1.4.0");
    expect(() => applyVersion(dir, "1.4.1")).toThrow(/RELEASE_NOTES.md does not name 1.4.1/);
    // Nothing was written: package.json still needs the bump.
    expect(planVersion(dir, "1.4.1", { allowStaleNotes: true }).map((p) => p.path)).toContain("package.json");
    expect(applyVersion(dir, "1.4.1", { allowStaleNotes: true })).toContain("package.json");
    expect(applyVersion(dir, "1.4.1", { allowStaleNotes: true })).toEqual([]);
  });

  it("rejects versions that are not X.Y.Z", () => {
    project();
    expect(() => applyVersion(dir, "v1.4.1")).toThrow(/X\.Y\.Z/);
    expect(() => applyVersion(dir, "1.4")).toThrow(/X\.Y\.Z/);
  });

  it("matches the version as a whole token on the first line only", () => {
    expect(notesNameVersion("# Hermes IDE 1.4.1\n", "1.4.1")).toBe(true);
    expect(notesNameVersion("# Hermes IDE 1.4.10\n", "1.4.1")).toBe(false);
    expect(notesNameVersion("# Hermes IDE 11.4.1\n", "1.4.1")).toBe(false);
    expect(notesNameVersion("# Notes\n\n1.4.1 is out\n", "1.4.1")).toBe(false);
    expect(notesNameVersion("", "1.4.1")).toBe(false);
  });

  it("edits only the named package in Cargo.lock and the root entry in package-lock.json", () => {
    const lock = '[[package]]\nname = "hermes-ide-lib"\nversion = "0.1.0"\n\n[[package]]\nname = "hermes-ide"\nversion = "1.4.0"\n';
    expect(bumpCargoLock(lock, "hermes-ide", "1.4.1")).toBe('[[package]]\nname = "hermes-ide-lib"\nversion = "0.1.0"\n\n[[package]]\nname = "hermes-ide"\nversion = "1.4.1"\n');
    expect(bumpCargoLock(lock, "missing", "1.4.1")).toBeNull();
    const pl = bumpPackageLock('{"version":"1.4.0","packages":{"":{"version":"1.4.0"},"node_modules/a":{"version":"1.4.0"}}}', "1.4.1");
    expect(JSON.parse(pl)).toEqual({ version: "1.4.1", packages: { "": { version: "1.4.1" }, "node_modules/a": { version: "1.4.0" } } });
  });
});
