#!/usr/bin/env node
// Scenario F25: the Claude bridge runtime ships as ONE packed archive and
// the app unpacks it on first use (ADR 002).
//
// The installer no longer carries ~6 000 loose node_modules files (they
// broke the AppImage and made every installer heavier); it carries
// bridge/runtime/bridge-runtime.tar.zst + manifest.json. This scenario packs
// the real bridge runtime with the real packer, points the REAL app at it
// (HERMES_BRIDGE_RUNTIME_DIR, read by test builds only) and runs the app's
// built-in self-test, which resolves the bridge exactly like an Agent-view
// session does and then imports the Claude Agent SDK with node from the
// unpacked folder:
//
//   1. first launch: the runtime is unpacked into <data>/runtime/<id>/ and
//      the SDK imports from there;
//   2. next launch: the unpacked runtime is reused, not unpacked again;
//   3. a runtime that lost a file is noticed and unpacked again;
//   4. an update that ships another runtime unpacks it and removes the old;
//   5. negative control: a damaged archive is refused, the self-test fails
//      with the reason, and nothing is left in the data folder.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F25-bridge-runtime.mjs

import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, appBinaryPath, createLogger, finishScenario, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F25-bridge-runtime";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** Environment without anything a surrounding Hermes or coding agent put there. */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(_?HERMES_|CLAUDE_|CLAUDECODE$|ZDOTDIR$|TERM_PROGRAM)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** Everything big (archives, unpacked runtimes) lives here, not in the evidence. */
const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f25-"));

function pack(bridgeDir, outDirPath) {
  const res = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts", "pack-bridge-runtime.mjs"), "--level", "3", "--bridge-dir", bridgeDir, "--out-dir", outDirPath],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`the packer failed: ${res.stderr || res.stdout}`);
  log(`  ${res.stdout.trim()}`);
  return JSON.parse(readFileSync(join(outDirPath, "manifest.json"), "utf8"));
}

/**
 * Run `hermes-ide --self-test=<report>` with its own home and data folder
 * and the packed runtime in `runtimeDir`. Returns { code, report, appLog }.
 */
async function selfTest(name, { home, data, runtimeDir }) {
  const binary = appBinaryPath();
  if (!existsSync(binary)) throw new Error(`test app not built: ${binary} — run node e2e/app/build.mjs`);
  const runDir = join(evidenceDir, name);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const report = join(runDir, "self-test.json");
  const appLog = join(runDir, "app.log");
  const fd = openSync(appLog, "w");
  const started = Date.now();
  const child = spawn(binary, [`--self-test=${report}`], {
    cwd: runDir,
    env: {
      ...cleanEnv(),
      HOME: home,
      CFFIXED_USER_HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      HERMES_DATA_DIR: data,
      HERMES_BRIDGE_RUNTIME_DIR: runtimeDir,
      // The test app's automation bridge is not needed for a self-test, but
      // e2e builds expect it to be allowed to start.
      HERMES_E2E: "1",
      HERMES_E2E_BRIDGE_FILE: join(runDir, "bridge.json"),
      RUST_LOG: "info",
    },
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  let exit = null;
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  const deadline = Date.now() + 150_000;
  while (!exit && Date.now() < deadline) await sleep(100);
  if (!exit) {
    child.kill("SIGKILL");
    throw new Error(`the app did not exit within 150 s — see ${appLog}`);
  }
  const json = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
  log(`  ${name}: exit ${JSON.stringify(exit)} after ${Date.now() - started} ms`);
  log(`  bridge check: ${JSON.stringify(json?.checks?.bridge_resources ?? null)}`);
  return { code: exit.code, report: json, appLog, log: readFileSync(appLog, "utf8") };
}

const unpackedLines = (text) => text.split(/\r?\n/).filter((l) => l.includes("[bridge runtime] unpacked"));
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);

  // ── 0. Pack the real runtime (staged by npm ci) ──────────────────
  log("step 0: pack the real bridge runtime with the release packer");
  const bridgeSrc = join(REPO_ROOT, "src-tauri", "bridge");
  const packed = join(work, "packed");
  const manifest = pack(bridgeSrc, packed);
  assert(manifest.fileCount > 100, `the archive holds the whole runtime (${manifest.fileCount} files, ${(manifest.unpackedBytes / 1e6).toFixed(0)} MB)`);
  assert(manifest.native.length === 1, `it carries the SDK's native package for this platform (${manifest.native.join(", ")})`);

  const home = join(work, "home");
  const data = join(work, "data");
  const runtimes = join(data, "runtime");
  const sdkPkg = (id) => join(runtimes, id, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");

  // ── 1. First launch unpacks ──────────────────────────────────────
  log("step 1: first launch — the app unpacks the runtime and the SDK imports from it");
  const first = await selfTest("1-first-launch", { home, data, runtimeDir: packed });
  assert(first.code === 0 && first.report?.ok === true, `the self-test passes (exit ${first.code})`);
  const b1 = first.report.checks.bridge_resources;
  assert(b1.packed === true && b1.runtime_id === manifest.id, `the bridge runs from the unpacked runtime ${manifest.id}`);
  assert(String(b1.bridge).includes(`runtime`) && String(b1.bridge).includes(manifest.id), `bridge path is inside <data>/runtime/${manifest.id}`);
  assert(b1.sdk_import?.ok === true && !b1.sdk_import.skipped, `node imported the Claude Agent SDK from the unpacked folder (${b1.sdk_import?.ms} ms)`);
  assert(existsSync(sdkPkg(manifest.id)), "the SDK is on disk in the data folder");
  assert(unpackedLines(first.log).length === 1, `the app log says it unpacked once: ${unpackedLines(first.log)[0]?.replace(/.*\] /, "")}`);
  assert(JSON.stringify(listDir(runtimes)) === JSON.stringify([manifest.id]), "only the one runtime folder exists (no temp folders left)");

  // ── 2. Next launch reuses ────────────────────────────────────────
  log("step 2: next launch — the unpacked runtime is reused");
  const second = await selfTest("2-next-launch", { home, data, runtimeDir: packed });
  assert(second.code === 0 && second.report?.ok === true, "the self-test passes again");
  assert(unpackedLines(second.log).length === 0, "nothing was unpacked this time");
  assert(second.report.checks.bridge_resources.runtime_id === manifest.id, "same runtime");

  // ── 3. A damaged runtime is repaired ─────────────────────────────
  log("step 3: a file of the unpacked runtime disappears — the app unpacks again");
  rmSync(sdkPkg(manifest.id));
  const third = await selfTest("3-repaired", { home, data, runtimeDir: packed });
  assert(third.code === 0 && third.report?.ok === true, "the self-test passes");
  assert(unpackedLines(third.log).length === 1, "the runtime was unpacked again");
  assert(existsSync(sdkPkg(manifest.id)), "the missing file is back");

  // ── 4. An update ships another runtime ───────────────────────────
  log("step 4: an update ships another runtime — it is unpacked and the old one removed");
  const nextSrc = join(work, "next-bridge");
  for (const f of ["hermes-claude-bridge.mjs", "canUseToolHelpers.mjs", "bridgeRuntimeHelpers.mjs", "package.json"]) {
    cpSync(join(bridgeSrc, f), join(nextSrc, f));
  }
  // A stand-in SDK: enough for the self-test's import, and a different id.
  mkdirSync(join(nextSrc, "node_modules", "@anthropic-ai", "claude-agent-sdk"), { recursive: true });
  writeFileSync(
    join(nextSrc, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "99.0.0", type: "module", exports: { ".": "./sdk.mjs" } }),
  );
  writeFileSync(join(nextSrc, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"), "export function query() {}\n");
  const nextPacked = join(work, "next-packed");
  const next = pack(nextSrc, nextPacked);
  assert(next.id !== manifest.id, `the new runtime has another id (${next.id})`);
  const fourth = await selfTest("4-update", { home, data, runtimeDir: nextPacked });
  assert(fourth.code === 0 && fourth.report?.ok === true, "the self-test passes on the new runtime");
  assert(fourth.report.checks.bridge_resources.sdk_version === "99.0.0", "the new SDK is the one in use");
  assert(JSON.stringify(listDir(runtimes)) === JSON.stringify([next.id]), `the old runtime was removed (${listDir(runtimes).join(", ")})`);

  // ── 5. Negative control: a damaged archive ───────────────────────
  log("step 5: negative control — a damaged archive is refused with the reason");
  const broken = join(work, "broken");
  cpSync(packed, broken, { recursive: true });
  const archive = join(broken, manifest.archive);
  const bytes = readFileSync(archive);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(archive, bytes);
  const brokenData = join(work, "broken-data");
  const bad = await selfTest("5-damaged-archive", { home: join(work, "home2"), data: brokenData, runtimeDir: broken });
  assert(bad.code === 1 && bad.report?.ok === false, `the self-test fails (exit ${bad.code})`);
  assert(bad.report.checks.bridge_resources.ok === false, "the bridge check is the one that failed");
  assert(String(bad.report.checks.bridge_resources.error).includes("checksum does not match"), `the reason is in the report: ${bad.report.checks.bridge_resources.error}`);
  assert(listDir(join(brokenData, "runtime")).length === 0, "nothing was unpacked from the damaged archive");
  assert(bad.report.checks.pty_echo?.ok === true, "the other checks still ran");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
