#!/usr/bin/env node
// Scenario: N16 — away notifications on the REAL app.
//
// A local web server stands in for the webhook / ntfy / Telegram address.
// A fake terminal agent (tools/fake-agents, `approval`) waits at its
// approval prompt; its status reaches the app as a SessionEvent through the
// contract's e2e injector (docs/adr/004-2.0-contracts.md) until the
// zero-setup signals (F11) are on main. You are away (the window does not
// have the keyboard focus, stated through the test hooks).
//
//   1. nothing configured: the agent blocks; the app decides to send, the
//      backend finds no address and makes no call — the server receives
//      nothing
//   2. the address is typed into Settings > General > Away notifications
//      (saved on Enter, exactly as a person does it)
//   3. the agent blocks again, with a command, a question and file content
//      in its status and attention events: the server receives exactly ONE
//      POST whose JSON body has exactly agent, task and state — none of the
//      prompt, command or code
//   4. a second request from the same agent before you looked at it sends
//      nothing more (one message per blocked agent)
//
// Negative control: HERMES_E2E_N16_NEGATIVE=1 skips step 2, so step 3 gets
// no message and the run must end in RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N16-away-notifications.mjs

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { PROBE_OUTPUT, classifyProbe, commandLine, probeCommand } from "../shells.mjs";

const SCENARIO = "N16-away-notifications";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const NEGATIVE = process.env.HERMES_E2E_N16_NEGATIVE === "1";
const FAKE_AGENT = join(REPO_ROOT, "tools", "fake-agents", "fake-agent.mjs");
const DB_FILE = "hermes_idea_v3.db";

// What the agent "says" — a command, a question and code, each with a
// marker word. None of it may leave the machine.
const SECRET_COMMAND = "Bash: ./deploy.sh --cluster zebra-canary-42";
const SECRET_QUESTION = "Should I copy the rows of customers_backup into the walrus-audit report?";
const SECRET_CODE = "Edit src/billing.ts: export const plan = 'otter-premium-9';";
const SECRETS = ["zebra-canary-42", "deploy.sh", "customers_backup", "walrus-audit", "src/billing.ts", "otter-premium-9", "export const"];

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-n16-home-"));

function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first })
    : launchApp({ runDir, log, home: "private", homeDir });
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

function enableFlag(dataDir) {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('feature_flag_overrides', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(JSON.stringify({ attentionInbox: true }));
  } finally {
    db.close();
  }
}

async function createPlainTerminal(bridge) {
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  const before = await bridge.terminalIds();
  for (let i = 0; i < 6; i++) {
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
  return bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

/** A local stand-in for the configured address; records every request. */
function startServer() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

function inject(bridge, sessionId, event) {
  return bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sessionId)}, ${JSON.stringify({ at: Date.now(), source: "e2e", ...event })});`);
}

const status = (kind, detail = "") => ({ type: "status", status: { kind, confidence: "exact", detail } });

let app;
let hook;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (no address configured)" : ""}`);
  hook = await startServer();
  const url = `http://127.0.0.1:${hook.port}/hook`;
  log(`  local server: ${url}`);

  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  const exit1 = await app.stop();
  assert(!exit1.forced && exit1.code === 0, "first launch quit cleanly");
  enableFlag(app.dataDir);

  app = await launch(2);
  const { bridge } = app;
  await bridge.waitFor("the app UI (no onboarding this time)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
  await bridge.waitFor("the attention badge (flag on)", `return !!e2e.first(".topbar .attention-badge");`, { timeoutMs: 10_000 });

  log("step 0: a fake agent waits at its approval prompt; you are away");
  const S = await createPlainTerminal(bridge);
  await bridge.typeInTerminal(S, `${probeCommand()}\n`);
  const shell = classifyProbe((await bridge.waitForTerminal(S, PROBE_OUTPUT, { timeoutMs: 20_000 })).line);
  const scenarioFile = join(evidenceDir, "approval-patient.json");
  const scenario = JSON.parse(readFileSync(join(REPO_ROOT, "tools", "fake-agents", "scenarios", "approval.json"), "utf8"));
  for (const step of scenario.steps) if (step.do === "waitKey") step.timeoutMs = 600_000;
  writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));
  await bridge.typeInTerminal(S, commandLine(shell, process.execPath, [FAKE_AGENT, "--scenario", scenarioFile]) + "\n");
  await bridge.waitForTerminal(S, /Allow Bash: rm -rf node_modules \?/, { timeoutMs: 20_000 });
  const label = await bridge.eval(`return e2e.first(".topbar-session-name")?.innerText?.trim() ?? null;`);
  log(`  session ${S} ("${label}")`);
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(false); return true;`);

  log("step 1: nothing configured — the agent blocks, no network call is made");
  const settings0 = await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_settings")).away_notify_url ?? "";`);
  assert(settings0 === "", "no away address is set");
  await inject(bridge, S, status("needs_approval", SECRET_COMMAND));
  const unset = await bridge.waitFor("the send attempt to finish", `
    const a = window.__HERMES_E2E__.attentionState().away;
    return a.length === 1 && a[0].result ? a[0] : null;
  `);
  assert(unset.result.outcome === "unset", `the backend found no address and sent nothing (${JSON.stringify(unset.result)})`);
  await sleep(1500);
  assert(hook.requests.length === 0, "the server received nothing");
  await inject(bridge, S, status("working"));
  await bridge.waitFor("the item to resolve", `return window.__HERMES_E2E__.inboxItems().length === 0;`);

  if (NEGATIVE) {
    log("step 2: NEGATIVE CONTROL — not configuring an address");
  } else {
    log("step 2: type the address into Settings > General > Away notifications");
    await bridge.clickByName("Settings");
    await bridge.waitFor("the away-notifications field", `return !!e2e.first("#away-notify-url");`);
    await bridge.eval(`
      const input = e2e.must(e2e.first("#away-notify-url"), "away field");
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(url)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    `);
    await bridge.waitFor("the address to be saved", `
      return (await window.__TAURI_INTERNALS__.invoke("get_settings")).away_notify_url === ${JSON.stringify(url)};
    `);
    await bridge.screenshot(join(evidenceDir, "01-settings-away.png"));
    await bridge.click(".settings-close");
    await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
  }

  log("step 3: the agent blocks again, with secrets in what it says");
  await inject(bridge, S, { type: "attention", detail: SECRET_QUESTION });
  await inject(bridge, S, status("needs_approval", SECRET_CODE));
  await bridge.waitFor("the send attempt to finish", `
    const a = window.__HERMES_E2E__.attentionState().away;
    return a.length === 2 && a[1].result ? a[1] : null;
  `);
  const until = Date.now() + 10_000;
  while (hook.requests.length === 0 && Date.now() < until) await sleep(100);
  await sleep(1500); // anything extra would have arrived by now
  writeFileSync(join(evidenceDir, "requests.json"), JSON.stringify(hook.requests, null, 2));
  assert(hook.requests.length === 1, `the server received exactly one message (got ${hook.requests.length})`);
  const [req] = hook.requests;
  assert(req.method === "POST" && req.url === "/hook", `POST /hook (${req.method} ${req.url})`);
  assert(/^application\/json/.test(req.headers["content-type"] ?? ""), "a JSON body");
  const body = JSON.parse(req.body);
  assert(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["agent", "state", "task"]), `the body has exactly agent, task and state: ${req.body}`);
  assert(body.state === "needs_approval", "state: needs_approval");
  assert(typeof body.agent === "string" && body.agent.length > 0, `agent: "${body.agent}"`);
  assert(!label || body.task === label, `task is the session's name ("${body.task}")`);
  const raw = JSON.stringify(req);
  for (const s of SECRETS) assert(!raw.includes(s), `nothing of what the agent said leaves the machine ("${s}")`);

  log("step 4: the same agent asks again before you looked: nothing more is sent");
  await inject(bridge, S, status("needs_approval", "Bash: rm -rf node_modules"));
  await sleep(2000);
  assert(hook.requests.length === 1, `still one message (got ${hook.requests.length})`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  hook?.server.close();
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
