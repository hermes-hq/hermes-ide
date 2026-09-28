#!/usr/bin/env node
// Scenario F25 (Linux): the AppImage is back, and it updates itself.
//
// Uses two real AppImages of the test app built by e2e/app/build-appimage.mjs
// (0.9.0 "old" and 0.9.1 "new", signed with a throwaway updater key the
// test builds trust). A person's journey:
//
//   1. "installs" the old AppImage: copies it to an Applications folder and
//      makes it executable, then runs its built-in self-test (which also
//      unpacks the Claude bridge runtime from inside the AppImage);
//   2. opens it; an update to 0.9.1 is published. The update manifest is
//      made by the release workflow's own manifest builder and passes the
//      release lint (signature checked against the test key), and is
//      served over local HTTP;
//   3. negative step: the first manifest served carries a signature made
//      for another file — the download is refused, the AppImage on disk is
//      untouched;
//   4. with the right manifest, Update Now → Install & Relaunch: the
//      AppImage file is replaced and the app restarts as 0.9.1 by itself;
//   5. the updated AppImage passes its self-test as 0.9.1.
//
// HERMES_E2E_F25_SABOTAGE=1 serves the wrong signature in step 4 as well:
// the update is then refused and the scenario must FAIL (the negative
// control CI runs next to the real run).
//
//   node e2e/app/build-appimage.mjs
//   xvfb-run -a node e2e/app/scenarios/F25-appimage-update.mjs

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Bridge, E2E_IDENTIFIER, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { buildManifests, lintManifests } from "../../../scripts/ci/release-manifests.mjs";

const SCENARIO = "F25-appimage-update";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const SABOTAGE = process.env.HERMES_E2E_F25_SABOTAGE === "1";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(_?HERMES_|CLAUDE_|CLAUDECODE$|ZDOTDIR$|TERM_PROGRAM)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** `<appimage> --self-test=<report>` with a throwaway home. Returns { code, report }. */
async function selfTest(appImage, name) {
  const runDir = join(evidenceDir, name);
  mkdirSync(runDir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "hermes-e2e-f25-home-"));
  const report = join(runDir, "self-test.json");
  const fd = openSync(join(runDir, "app.log"), "w");
  const child = spawn(appImage, [`--self-test=${report}`], {
    cwd: runDir,
    env: {
      ...cleanEnv(),
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
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
  const deadline = Date.now() + 180_000;
  while (!exit && Date.now() < deadline) await sleep(100);
  if (!exit) {
    child.kill("SIGKILL");
    throw new Error(`the self-test did not finish within 180 s — see ${join(runDir, "app.log")}`);
  }
  rmSync(home, { recursive: true, force: true });
  const json = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
  log(`  ${name}: exit ${JSON.stringify(exit)}; report ok=${json?.ok} version=${json?.version}`);
  log(`  bridge check: ${JSON.stringify(json?.checks?.bridge_resources ?? null)}`);
  return { code: exit.code, report: json };
}

async function onboard(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`, { timeoutMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return true;
  `);
  await bridge.waitFor("the Finish button", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

/** The update server: serves `files` (name → path) and the current latest.json. */
function startServer(files) {
  const requests = [];
  let latest = "{}";
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1));
    requests.push(name);
    if (name === "latest.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(latest);
      return;
    }
    const file = files[name];
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    const data = readFileSync(file);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length });
    res.end(data);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        requests,
        setLatest: (json) => {
          latest = JSON.stringify(json);
        },
      }),
    );
  });
}

/** Run `remove` once no AppImage mount is left under `dir` (up to 15 s); never throws. */
async function removeWhenUnmounted(remove, dir) {
  const mounted = () => {
    try {
      return readdirSync(dir).some((n) => n.startsWith(".mount_"));
    } catch {
      return false;
    }
  };
  const until = Date.now() + 15_000;
  while (mounted() && Date.now() < until) await sleep(250);
  try {
    remove();
  } catch (e) {
    log(`  (left a temp folder behind: ${e.message})`);
  }
}

let failed = false;
let app;
let relaunched = null;
let http;
const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f25-appimage-"));
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${SABOTAGE ? "   (SABOTAGE: the update must be refused)" : ""}`);
  if (platform() !== "linux") throw new Error("AppImages exist on Linux only");
  const infoFile = process.env.HERMES_E2E_APPIMAGES || join(outDir(), "appimage", "appimages.json");
  if (!existsSync(infoFile)) throw new Error(`no test AppImages: ${infoFile} — run node e2e/app/build-appimage.mjs`);
  const info = JSON.parse(readFileSync(infoFile, "utf8"));
  const { old, new: next, pubkey } = info;
  assert(sha256(old.file) === old.sha256 && sha256(next.file) === next.sha256, `the built AppImages are the ones recorded (${old.version} → ${next.version})`);

  // ── 1. Install and self-test ─────────────────────────────────────
  log("step 1: install the old AppImage and run its self-test");
  const apps = join(work, "Applications");
  mkdirSync(apps, { recursive: true });
  const installed = join(apps, "Hermes-IDE.AppImage");
  copyFileSync(old.file, installed);
  chmodSync(installed, 0o755);
  const before = await selfTest(installed, "1-self-test-old");
  assert(before.code === 0 && before.report?.ok === true, "the installed AppImage passes its self-test");
  assert(before.report.version === old.version, `it reports version ${old.version}`);
  assert(before.report.identifier === E2E_IDENTIFIER, "it is the test app");
  const b = before.report.checks.bridge_resources;
  assert(b.packed === true && b.sdk_import?.ok === true && !b.sdk_import.skipped, "the Claude bridge runtime unpacked from inside the AppImage and the SDK imports");

  // ── 2. Publish 0.9.1 the way the release workflow does ───────────
  log("step 2: publish the update with the release manifest builder and lint it");
  const release = join(work, "release");
  mkdirSync(release, { recursive: true });
  const assetName = next.builtAs;
  copyFileSync(next.file, join(release, assetName));
  copyFileSync(next.sig, join(release, `${assetName}.sig`));
  // The .deb of the same version is published next to it, as in a real
  // release: the AppImage must pick its own entry, never the .deb's.
  copyFileSync(next.deb, join(release, next.debName));
  copyFileSync(`${next.deb}.sig`, join(release, `${next.debName}.sig`));
  const tag = `v${next.version}`;
  const repo = "example-org/example-app";
  const { latest } = buildManifests(release, { tag, repo });
  assert(
    ["linux-x86_64-appimage", "linux-x86_64", "linux-x86_64-deb"].every((k) => latest.platforms[k]),
    `the manifest has the AppImage and .deb keys (${Object.keys(latest.platforms).join(", ")})`,
  );
  const problems = lintManifests(release, { tag, pubkey, expect: ["linux-x86_64-appimage", "linux-x86_64", "linux-x86_64-deb"] });
  assert(problems.length === 0, `the release lint passes, signature verified with the test key (${problems.join("; ") || "clean"})`);

  http = await startServer({ [assetName]: join(release, assetName), [next.debName]: join(release, next.debName) });
  const base = `http://127.0.0.1:${http.port}/`;
  const local = (manifest, signature) => {
    const copy = structuredClone(manifest);
    for (const entry of Object.values(copy.platforms)) {
      entry.url = base + encodeURIComponent(basename(new URL(entry.url).pathname));
      if (signature) entry.signature = signature;
    }
    return copy;
  };
  // A valid signature from the right key, made for a different file.
  const wrongSignature = readFileSync(old.sig, "utf8").trim();
  http.setLatest(local(latest, wrongSignature));

  // ── 3. Open the app; a tampered update is refused ────────────────
  log("step 3: open the app and try an update whose signature is for another file");
  app = await launchApp({
    runDir: join(evidenceDir, "run"),
    log,
    binary: installed,
    home: "private",
    env: { HERMES_UPDATE_ENDPOINT: `${base}latest.json` },
  });
  const health = await app.bridge.health();
  assert(health.version === old.version, `the app runs as ${old.version}`);
  assert(health.build === old.stamp, "it is the old AppImage built for this run");
  await onboard(app.bridge);

  const checkForUpdates = async () => {
    await app.bridge.click(".status-version-chip");
    await app.bridge.waitFor("the update dialog", `return e2e.first(".update-dialog")?.innerText.includes("v${next.version}") ?? false;`, { timeoutMs: 30_000 });
  };
  await checkForUpdates();
  await app.bridge.screenshot(join(evidenceDir, "01-update-offered.png"));
  await app.bridge.clickByName("Update Now", { within: ".update-dialog" });
  await app.bridge.waitFor("the download to be refused", `return !!e2e.first(".update-dialog-error");`, { timeoutMs: 120_000 });
  assert(http.requests.includes(assetName), "the app downloaded the AppImage");
  assert(!http.requests.includes(next.debName), "and not the .deb");
  assert(sha256(installed) === old.sha256, "the installed AppImage is untouched after the refused update");
  await app.bridge.screenshot(join(evidenceDir, "02-bad-signature-refused.png"));
  await app.bridge.clickByName("Later", { within: ".update-dialog" });
  await app.bridge.waitFor("the dialog to close", `return !e2e.first(".update-dialog");`);

  // ── 4. The real update ───────────────────────────────────────────
  log(`step 4: the correctly signed update${SABOTAGE ? " (sabotaged: still the wrong signature)" : ""}`);
  http.setLatest(SABOTAGE ? local(latest, wrongSignature) : local(latest));
  await checkForUpdates();
  await app.bridge.clickByName("Update Now", { within: ".update-dialog" });
  await app.bridge.waitFor(
    "the download to finish",
    `const d = e2e.first(".update-dialog"); if (!d) return false;
     if (e2e.first(".update-dialog-error")) return "error";
     return d.innerText.includes("Install & Relaunch") ? "ready" : false;`,
    { timeoutMs: 180_000 },
  ).then((state) => assert(state === "ready", `the update downloaded and its signature verified (${state})`));
  await app.bridge.screenshot(join(evidenceDir, "03-ready-to-install.png"));

  const bridgeFile = join(evidenceDir, "run", "bridge.json");
  const oldBridge = readFileSync(bridgeFile, "utf8");
  await app.bridge.clickByName("Install & Relaunch", { within: ".update-dialog" });
  const exitDeadline = Date.now() + 60_000;
  while (app.isRunning() && Date.now() < exitDeadline) await sleep(200);
  assert(!app.isRunning(), "the old app quit to relaunch");
  assert(sha256(installed) === next.sha256, "the AppImage file on disk is now the new version");

  // The app restarts itself from the same path; the new process starts its
  // test bridge on the same bridge file.
  const relaunchDeadline = Date.now() + 120_000;
  while (Date.now() < relaunchDeadline) {
    try {
      const text = readFileSync(bridgeFile, "utf8");
      if (text !== oldBridge) {
        relaunched = Bridge.fromFile(bridgeFile);
        await relaunched.health();
        break;
      }
    } catch {
      relaunched = null;
    }
    await sleep(250);
  }
  assert(relaunched, "the app came back on its own after the update");
  const after = await relaunched.health();
  assert(after.version === next.version, `the relaunched app is ${after.version}`);
  assert(after.build === next.stamp, "it is the new AppImage built for this run");
  await relaunched.waitFor("the UI to render", `return !!document.getElementById("root")?.firstElementChild;`, { timeoutMs: 60_000 });
  await relaunched.screenshot(join(evidenceDir, "04-relaunched-new-version.png"));
  await relaunched.quit();
  const quitDeadline = Date.now() + 15_000;
  while (Date.now() < quitDeadline) {
    try {
      process.kill(after.pid, 0);
      await sleep(200);
    } catch {
      break;
    }
  }
  relaunched = null;

  // ── 5. The updated AppImage passes its self-test ─────────────────
  log("step 5: self-test the updated AppImage");
  const updated = await selfTest(installed, "5-self-test-new");
  assert(updated.code === 0 && updated.report?.ok === true, "the updated AppImage passes its self-test");
  assert(updated.report.version === next.version, `it reports version ${next.version}`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (relaunched) await relaunched.quit().catch(() => {});
  if (app) {
    const exit = await app.stop({ keepFiles: true });
    log(`  first app exit: ${JSON.stringify(exit)}`);
    // The AppImage runtime unmounts its FUSE mount (a .mount_* folder in the
    // app's temp folder) a moment after the app exits; clean up after that.
    await removeWhenUnmounted(() => app.cleanup(), app.tmpDir);
  }
  if (http) http.server.close();
  await removeWhenUnmounted(() => rmSync(work, { recursive: true, force: true }), work);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details: { sabotage: SABOTAGE } });
