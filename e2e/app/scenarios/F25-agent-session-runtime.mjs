#!/usr/bin/env node
// Scenario F25: an Agent view session runs through the unpacked runtime.
//
// F25-bridge-runtime.mjs proves the packed runtime unpacks and that node can
// import the SDK from it (the self-test). This one closes the gap to "a
// session runs": the REAL app is pointed at a packed runtime
// (HERMES_BRIDGE_RUNTIME_DIR, read by test builds only) whose bridge is the
// fake Claude bridge (e2e/app/fixtures/fake-claude-bridge.mjs) behind a small
// entry file that imports a stand-in SDK from the runtime's own node_modules.
// No network, no account.
//
//   run 1  fresh install: open an Agent view session, send a message.
//          The app unpacks the runtime into <data>/runtime/<id>/, starts the
//          bridge FROM THERE, the bridge imports the SDK from the unpacked
//          node_modules, and the reply shows in the view.
//   run 2  NEGATIVE CONTROL: same data folder, an update ships a runtime
//          whose archive is damaged. Opening an Agent view session starts no
//          bridge, nothing is unpacked, and the app says why (the archive's
//          checksum). If run 2 also got a reply, run 1 would prove nothing
//          about the runtime.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F25-agent-session-runtime.mjs

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F25-agent-session-runtime";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const onWindows = platform() === "win32";
// Windows keeps app data under %APPDATA%, which a private HOME does not move
// (see N07-feature-flags.mjs); there the test app's own data folder is used.
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f25s-home-"));
/** Everything big (runtime sources, archives) lives here, not in the evidence. */
const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f25s-"));

const fakeLog = join(work, "fake-bridge.ndjson");
const planFile = join(work, "plan.json");
writeFileSync(planFile, JSON.stringify({ mode: "ok" }));
/** A value only this run knows: the stand-in SDK exports it, the bridge logs it. */
const sdkMarker = `stand-in-sdk-${process.pid}-${Date.now()}`;

// ── The runtime to pack ─────────────────────────────────────────────
/**
 * A bridge folder shaped like src-tauri/bridge: the entry file, the fake
 * bridge, package.json and node_modules with a stand-in Claude Agent SDK.
 * `extra` adds a file, so two runtimes get two ids.
 */
function runtimeSource(name, extra) {
  const dir = join(work, name);
  const sdk = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(sdk, { recursive: true });
  copyFileSync(join(REPO_ROOT, "e2e", "app", "fixtures", "fake-claude-bridge.mjs"), join(dir, "fake-claude-bridge.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "hermes-claude-bridge", private: true, type: "module" }));
  writeFileSync(
    join(dir, "hermes-claude-bridge.mjs"),
    [
      "// Entry of the test runtime: say where it runs from and which SDK it",
      "// imported (the runtime's own node_modules), then be the fake bridge.",
      'import { appendFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      'import { MARKER } from "@anthropic-ai/claude-agent-sdk";',
      "if (process.env.HERMES_FAKE_BRIDGE_LOG) {",
      "  appendFileSync(",
      "    process.env.HERMES_FAKE_BRIDGE_LOG,",
      '    JSON.stringify({ event: "runtime", script: fileURLToPath(import.meta.url), sdk: MARKER, pid: process.pid }) + "\\n",',
      "  );",
      "}",
      'await import("./fake-claude-bridge.mjs");',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(sdk, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-e2e", type: "module", exports: { ".": "./sdk.mjs" } }),
  );
  writeFileSync(join(sdk, "sdk.mjs"), `export const MARKER = ${JSON.stringify(sdkMarker)};\n`);
  if (extra) writeFileSync(join(dir, "node_modules", extra), "e2e\n");
  return dir;
}

function pack(bridgeDir, out) {
  const res = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts", "pack-bridge-runtime.mjs"), "--level", "3", "--bridge-dir", bridgeDir, "--out-dir", out],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`the packer failed: ${res.stderr || res.stdout}`);
  log(`  ${res.stdout.trim()}`);
  return JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
}

function fakeEvents() {
  if (!existsSync(fakeLog)) return [];
  return readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Path comparison that survives /var -> /private/var and Windows casing. */
function canonical(p) {
  let out = p;
  try {
    out = realpathSync(p);
  } catch {
    // not there (yet): compare as given
  }
  return onWindows ? out.toLowerCase() : out;
}

// ── App steps ───────────────────────────────────────────────────────
function launch(run, runtimeDir, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const env = {
    HERMES_BRIDGE_RUNTIME_DIR: runtimeDir,
    HERMES_FAKE_BRIDGE_PLAN: planFile,
    HERMES_FAKE_BRIDGE_LOG: fakeLog,
  };
  const started = onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env })
    : launchApp({ runDir, log, home: "private", homeDir, env });
  return started.then((app) => ({ ...app, runDir }));
}

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const _screen of ["welcome", "theme", "AI tools"]) {
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
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  await dismissWhatsNew(bridge);
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
}

async function quit(app) {
  const exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

/** New Agent view session through the New Session wizard; returns its id. */
async function createAgentSession(bridge) {
  const before = await bridge.eval(`return e2e.all(".agent-session-view").map((e) => e.dataset.sessionId);`);
  await bridge.clickWhenReady(`
    const b = e2e.first("button.es-tile-primary") || e2e.byName("New Session");
    return e2e.click(e2e.must(b, "a New Session button"));
  `);
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const claude = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(claude, "the Claude card"));
  `);
  const agentViewBox = `e2e.first(".session-creator-agent-view input[type=checkbox]")`;
  await bridge.waitFor("the Agent view option", `return !!${agentViewBox};`);
  if (!(await bridge.eval(`return ${agentViewBox}.checked;`))) {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(${agentViewBox}, "the Agent view checkbox"));`);
  }
  await bridge.waitFor("Agent view to be selected", `return ${agentViewBox}?.checked === true;`);
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      ));
    `);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const sid = await bridge.waitFor("the Agent view to open", `
    const ids = e2e.all(".agent-session-view").map((e) => e.dataset.sessionId).filter(Boolean);
    const fresh = ids.filter((id) => !${JSON.stringify(before)}.includes(id));
    return fresh.length === 1 ? fresh[0] : null;
  `, { timeoutMs: 20_000 });
  log(`  Agent view session: ${sid}`);
  return sid;
}

async function sendMessage(bridge, text) {
  await bridge.clickWhenReady(`
    const ta = e2e.must(e2e.first(".session-composer-input"), "the composer");
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await bridge.waitFor("the composer to hold the message", `
    return e2e.first(".session-composer-input")?.value === ${JSON.stringify(text)};
  `);
  await bridge.click(".session-composer-send-btn");
  log(`  sent: "${text}"`);
}

/** Lines of the app's own log that mention `needle`. */
function appLogLines(runDir, needle) {
  const file = join(runDir, "app.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.includes(needle));
}

const listDir = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

let app;
let failed = false;
const details = {};

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);

  log("step 0: pack a runtime whose bridge is the fake Claude bridge, and a damaged one");
  const good = pack(runtimeSource("good-src"), join(work, "good"));
  assert(good.sdkVersion === "0.0.0-e2e" && good.fileCount === 5, `the runtime holds the entry, the fake bridge and the stand-in SDK (${good.fileCount} files, id ${good.id})`);
  const damaged = pack(runtimeSource("damaged-src", "another-file.txt"), join(work, "damaged"));
  assert(damaged.id !== good.id, `the update's runtime has another id (${damaged.id})`);
  const archive = join(work, "damaged", damaged.archive);
  const bytes = readFileSync(archive);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(archive, bytes);
  details.runtimeId = good.id;

  // ── run 1 ──────────────────────────────────────────────────────────
  log("step 1: fresh launch with the packed runtime; open an Agent view session and send a message");
  app = await launch(1, join(work, "good"), { first: true });
  const runtimes = join(app.dataDir, "runtime");
  await completeOnboarding(app.bridge);
  assert(listDir(runtimes).length === 0, "nothing is unpacked before the Agent view is used (terminal first)");
  await createAgentSession(app.bridge);
  const text = "hello from the unpacked runtime";
  await sendMessage(app.bridge, text);
  await app.bridge.waitFor("the agent's reply", `
    return e2e.norm(e2e.first(".agent-session-view")?.innerText).includes(${JSON.stringify(`fake reply: ${text}`)});
  `, { timeoutMs: 30_000 });
  assert(true, `the reply "fake reply: ${text}" is in the Agent view`);
  await app.bridge.screenshot(join(evidenceDir, "01-reply-from-unpacked-runtime.png")).catch((e) => log(`  (screenshot: ${e.message})`));

  const started = fakeEvents().filter((e) => e.event === "runtime");
  log(`  bridge processes: ${JSON.stringify(started.map((e) => ({ pid: e.pid, script: e.script })))}`);
  assert(started.length >= 1, "the bridge started from the packed runtime");
  const unpackedEntry = join(runtimes, good.id, "hermes-claude-bridge.mjs");
  assert(existsSync(unpackedEntry), `the runtime was unpacked into <data>/runtime/${good.id}/`);
  assert(
    started.every((e) => canonical(e.script) === canonical(unpackedEntry)),
    `every bridge process ran the unpacked entry, not a copy elsewhere (${started[0].script.split(sep).slice(-3).join("/")})`,
  );
  assert(started.every((e) => e.sdk === sdkMarker), "the bridge imported the SDK from the unpacked node_modules");
  const replied = fakeEvents().filter((e) => e.event === "input" && e.type === "user");
  assert(replied.length >= 1 && started.some((e) => e.pid === replied[0].pid), "the message went to that process");
  const unpackLines = appLogLines(app.runDir, "[bridge runtime] unpacked");
  assert(unpackLines.length === 1, `the app log says it unpacked once: ${unpackLines[0]?.replace(/.*\] /, "")}`);
  details.bridgeProcesses = started.length;
  await quit(app);
  app = null;

  // ── run 2: negative control ────────────────────────────────────────
  log("step 2: NEGATIVE CONTROL — an update ships a damaged runtime archive");
  const eventsBefore = fakeEvents().length;
  app = await launch(2, join(work, "damaged"));
  await waitForReturningLaunch(app.bridge);
  await createAgentSession(app.bridge);
  const reason = await app.bridge.waitFor("the app to say the agent could not start", `
    const view = e2e.first(".agent-session-view");
    if (!view) return null;
    const stderr = view.querySelector(".agent-stderr-details, .agent-error-banner-detail");
    const text = (stderr?.textContent || "") + " " + (e2e.first(".agent-exit-notice, .agent-error-banner")?.textContent || "");
    return /checksum/i.test(text) ? e2e.norm(text) : null;
  `, { timeoutMs: 30_000 });
  log(`  the view says: ${reason.slice(0, 200)}`);
  assert(/checksum does not match/.test(reason), "the view names the reason: the archive's checksum does not match");
  await app.bridge.screenshot(join(evidenceDir, "02-damaged-runtime.png")).catch((e) => log(`  (screenshot: ${e.message})`));
  await sleep(1_000);
  const newEvents = fakeEvents().slice(eventsBefore);
  assert(newEvents.length === 0, `no bridge process started from the damaged runtime (${newEvents.length} events)`);
  assert(!listDir(runtimes).includes(damaged.id), "nothing was unpacked from the damaged archive");
  const text2 = await app.bridge.eval(`return e2e.norm(e2e.first(".agent-session-view")?.innerText);`);
  assert(!text2.includes("fake reply"), "no reply appears in the new session");
  await quit(app);
  app = null;
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  if (app) {
    await app.bridge.screenshot(join(evidenceDir, "failure.png")).catch(() => {});
    await app.stop().catch(() => {});
  }
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details });
