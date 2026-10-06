#!/usr/bin/env node
// Scenario FIX-open-files-limit: agents start from an app opened with the
// open-files limit macOS gives an app opened from the Dock (soft 256), and
// Hermes never types a launch that cannot work.
//
//   1. The app starts with `ulimit -Sn 256`. A Claude session (a fake
//      `claude` on PATH) starts, and from inside the agent the soft limit is
//      at least 1024 and no descriptor of the app is open beyond a few.
//   2. A session whose folder the shell cannot stand in (a folder above it
//      loses its permissions, the shell shows "." as its folder, the real
//      Claude Code then fails with "possibly due to low max file
//      descriptors") starts nothing and says why, with the fix.
//   3. A session where the person starts typing before the agent's launch is
//      due: Hermes types nothing into their line and says so.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-open-files-limit.mjs
//
// macOS and Linux only: the fake claude and the shell setup are POSIX.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";
import { completeClassicOnboarding } from "../launcher-steps.mjs";

const SCENARIO = "FIX-open-files-limit";
const startedAt = Date.now();
const BANNER = "FAKE-CLAUDE-FD";
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

if (platform() === "win32") {
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "open-files limits and the fake claude are POSIX: macOS and Linux only", log });
}

// ─── Fixtures ────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "hermes-e2e-fd-"));
const fakeBin = join(work, "bin");
const home = join(work, "home");
const open = join(work, "projects", "open");
const lockedAbove = join(work, "projects", "hermes-locked");
const locked = join(lockedAbove, "app");
const slow = join(work, "projects", "hermes-slow", "app");
for (const d of [fakeBin, home, open, locked, slow]) mkdirSync(d, { recursive: true });

// The fake agent reports what it inherited: the soft limit and every open
// descriptor (ls adds one of its own for the folder it lists).
writeFileSync(
  join(fakeBin, "claude"),
  [
    "#!/bin/sh",
    `echo "${BANNER} soft=$(ulimit -Sn) fds=[$(ls /dev/fd | sort -n | tr '\\n' ' ')]"`,
    "while IFS= read -r line; do echo \"fake claude got: $line\"; done",
    "",
  ].join("\n"),
);
chmodSync(join(fakeBin, "claude"), 0o755);
process.env.PATH = [
  fakeBin,
  ...(process.env.PATH || "").split(delimiter).filter((dir) => dir && !existsSync(join(dir, "claude"))),
].join(delimiter);
for (const name of Object.keys(process.env)) {
  if (name.startsWith("ANTHROPIC_")) delete process.env[name];
}
// The person's shell setup: in hermes-locked, the folder above the shell's
// loses its permissions once the shell stands in it (as a revoked privacy
// grant does); in hermes-slow the shell takes 4 s to start, time in which
// the person starts typing.
const rc = [
  'case "$PWD" in',
  '  */hermes-locked/*) chmod 000 "${PWD%/*}" ;;',
  "  */hermes-slow/*) sleep 4 ;;",
  "esac",
  "",
].join("\n");
for (const f of [".zshrc", ".bashrc"]) writeFileSync(join(home, f), rc);
writeFileSync(join(home, ".bash_profile"), '[ -f ~/.bashrc ] && . ~/.bashrc\n');

const launch = (bridge, cwd, label) =>
  bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId: "claude", cwd, label })});`, { timeoutMs: 60_000 });
const toasts = (bridge) => bridge.eval(`return e2e.all(".toast-message").map((t) => e2e.norm(t.innerText));`);
const terminalText = async (bridge, id) => ((await bridge.readTerminal(id)) ?? []).join("\n");

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  app = await launchApp({ runDir: join(evidenceDir, "run"), log, home: "private", homeDir: home, openFilesSoftLimit: 256 });
  const { bridge } = app;
  await completeClassicOnboarding(bridge);

  // ── 1. Room to start, nothing of the app's open ───────────────────
  log("step 1: the app was started with ulimit -Sn 256; start a Claude session");
  const s1 = await launch(bridge, open, "fd-open");
  assert(!!s1, "a Claude session was created");
  const { line } = await bridge.waitForTerminal(s1, new RegExp(`${BANNER} soft=`), { timeoutMs: 45_000 });
  log(`  agent reports: ${line.trim()}`);
  const soft = Number(/soft=(\d+|unlimited)/.exec(line)?.[1].replace("unlimited", "Infinity"));
  assert(soft >= 1024, `the agent's soft open-files limit is at least 1024 (${soft})`);
  const fds = (/fds=\[([^\]]*)\]/.exec(line)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  const extra = fds.filter((n) => n > 2);
  // The shell running the fake may keep one for its script, and ls one for
  // the folder it lists; anything the app leaked would come in dozens.
  assert(extra.length <= 3, `only the agent's own descriptors are open: 0-2 and [${extra.join(" ")}]`);
  // The app itself (terminals it opens without the session host) too.
  const raised = /open-files limit raised from 256 to (\d+)/.exec(readFileSync(join(evidenceDir, "run", "app.log"), "utf8"));
  assert(raised && Number(raised[1]) >= 1024, `the app raised its own limit at startup (${raised?.[0]})`);
  await bridge.screenshot(join(evidenceDir, "01-agent-started.png"));

  // ── 2. A folder the shell cannot stand in ─────────────────────────
  log("step 2: a session whose shell loses access to its folder before the launch");
  const s2 = await launch(bridge, locked, "fd-locked");
  assert(!!s2, "the second session was created");
  const msg = await bridge.waitFor(
    "the notice that the folder cannot be opened",
    `return e2e.all(".toast-message").map((t) => e2e.norm(t.innerText)).find((m) => m.includes("cannot open this session's folder")) ?? null;`,
    { timeoutMs: 45_000 },
  );
  log(`  notice: ${msg}`);
  assert(msg.includes(locked), "the notice names the folder");
  assert(msg.includes("the agent was not started"), "the notice says the agent was not started");
  if (platform() === "darwin") assert(msg.includes("Privacy & Security › Files and Folders"), "the notice names the macOS setting to fix it");
  await sleep(2000);
  const t2 = await terminalText(bridge, s2);
  assert(!t2.includes(BANNER), "no agent was started there");
  assert(!/claude --|hi run|Read the file at/.test(t2), "no launch line was typed into that shell");
  await bridge.screenshot(join(evidenceDir, "02-folder-cannot-be-opened.png"));
  chmodSync(lockedAbove, 0o755);

  // ── 3. The person is typing ───────────────────────────────────────
  log("step 3: the person starts typing while the shell is still starting");
  const s3 = await launch(bridge, slow, "fd-typing");
  assert(!!s3, "the third session was created");
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(s3)}, data: btoa("echo typed-by-person") }); return true;`);
  const typingMsg = await bridge.waitFor(
    "the notice that Hermes did not type the launch",
    `return e2e.all(".toast-message").map((t) => e2e.norm(t.innerText)).find((m) => m.includes("You started typing")) ?? null;`,
    { timeoutMs: 45_000 },
  );
  log(`  notice: ${typingMsg}`);
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(s3)}, data: btoa("\\r") }); return true;`);
  await bridge.waitForTerminal(s3, /^typed-by-person\s*$/, { timeoutMs: 15_000 });
  const t3 = await terminalText(bridge, s3);
  assert(!t3.includes(BANNER), "no agent was started into the person's line");
  assert(!/typed-by-person\S*(claude|hi run|Read the file)/.test(t3), `the person's command ran on its own (${t3.split("\n").filter((l) => l.includes("typed-by-person")).join(" | ")})`);
  await bridge.screenshot(join(evidenceDir, "03-typing-kept.png"));
  log(`  toasts at the end: ${JSON.stringify(await toasts(bridge))}`);
} catch (e) {
  failed = true;
  log(`FAIL: ${e.stack || e}`);
  if (app) await app.bridge.screenshot(join(evidenceDir, "failure.png")).catch(() => {});
} finally {
  try {
    chmodSync(lockedAbove, 0o755);
  } catch {}
  if (app) await app.stop({ stopPrograms: true }).catch((e) => log(`stop: ${e}`));
  rmSync(work, { recursive: true, force: true });
}
finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
