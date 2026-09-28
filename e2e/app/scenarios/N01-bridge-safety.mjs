#!/usr/bin/env node
// Scenario: the automation bridge's safety rails, checked from OUTSIDE the
// app with the real binary.
//
//   1. With HERMES_E2E=1 the app listens on exactly one socket, and it is on
//      127.0.0.1 — never on a routable address.
//   2. A request without the token, or with a wrong one, is refused (401)
//      and the app keeps working for the right token.
//   3. The bridge cannot be reached through the machine's own network address.
//   4. Without HERMES_E2E=1 the very same binary opens no socket and writes no
//      bridge file.
//
// Step 4 launches the app the normal way, which on a desktop brings its
// window to the front. It therefore runs on CI, or when
// HERMES_E2E_ALLOW_FOCUS=1 is set on purpose.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N01-bridge-safety.mjs

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  IS_CI,
  appBinaryPath,
  createLogger,
  finishScenario,
  inheritedEnv,
  launchApp,
  outDir,
  sleep,
} from "../harness.mjs";

const SCENARIO = "N01-bridge-safety";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/**
 * TCP sockets a process is listening on, as "address:port" strings, read
 * with the OS's own tools. Returns null when no tool is available.
 */
function listeningSockets(pid) {
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", shell: platform() === "win32" });
  if (platform() === "win32") {
    const res = run("netstat", ["-ano", "-p", "tcp"]);
    if (res.status !== 0) return null;
    return res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c[0] === "TCP" && c[3] === "LISTENING" && c[4] === String(pid))
      .map((c) => c[1]);
  }
  if (platform() === "linux") {
    const ss = run("ss", ["-ltnpH"]);
    if (ss.status === 0) {
      return ss.stdout
        .split("\n")
        .filter((l) => new RegExp(`pid=${pid}\\b`).test(l))
        .map((l) => l.trim().split(/\s+/)[3]);
    }
  }
  const lsof = run("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "n"]);
  if (lsof.status !== 0 && lsof.status !== 1) return null; // 1 = nothing found
  if (lsof.error) return null;
  return lsof.stdout
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => l.slice(1));
}

const isLoopback = (addr) => /^(127\.\d+\.\d+\.\d+|\[?::1\]?|localhost):\d+$/.test(addr);

/** First routable IPv4 address of this machine, if any. */
function routableAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

/** Try to open a TCP connection; resolve with "connected" or the error code. */
function tryConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (outcome) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => done("timeout"));
    socket.once("connect", () => done("connected"));
    socket.once("error", (e) => done(e.code ?? String(e)));
  });
}

async function rawRequest(port, path, token) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json() };
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   CI: ${IS_CI}`);

  // ── 1. Loopback only ─────────────────────────────────────────────
  log("step 1: launch with HERMES_E2E=1 and inspect the app's listening sockets");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  const { bridge } = app;
  const sockets = listeningSockets(bridge.pid);
  log(`  listening sockets of pid ${bridge.pid}: ${sockets ? JSON.stringify(sockets) : "(no tool to list them here)"}`);
  if (sockets) {
    assert(sockets.length >= 1, "the app has a listening socket");
    assert(
      sockets.some((s) => s.endsWith(`:${bridge.port}`)),
      `the bridge port ${bridge.port} is among them`,
    );
    assert(
      sockets.every(isLoopback),
      `every listening socket is on the loopback interface (${sockets.join(", ")})`,
    );
  }

  // ── 2. Token ─────────────────────────────────────────────────────
  log("step 2: requests without the token or with a wrong token are refused");
  const noToken = await rawRequest(bridge.port, "/health");
  assert(noToken.status === 401 && noToken.body.ok === false, `no token → HTTP ${noToken.status} ${JSON.stringify(noToken.body)}`);
  const wrong = await rawRequest(bridge.port, "/health", bridge.token.split("").reverse().join(""));
  assert(wrong.status === 401, `wrong token → HTTP ${wrong.status}`);
  const truncated = await rawRequest(bridge.port, "/health", bridge.token.slice(0, -1));
  assert(truncated.status === 401, `truncated token → HTTP ${truncated.status}`);
  const empty = await rawRequest(bridge.port, "/health", "");
  assert(empty.status === 401, `empty token → HTTP ${empty.status}`);
  const bad = await fetch(`http://127.0.0.1:${bridge.port}/eval`, {
    method: "POST",
    body: JSON.stringify({ script: "return 1" }),
    signal: AbortSignal.timeout(10_000),
  });
  assert(bad.status === 401, `an unauthenticated /eval is refused too → HTTP ${bad.status}`);
  const good = await rawRequest(bridge.port, "/health", bridge.token);
  assert(good.status === 200 && good.body.ok === true, "the right token still works afterwards");
  const value = await bridge.eval("return 6 * 7;");
  assert(value === 42, "and scripts still run in the app");

  // ── 3. Not reachable from the network ────────────────────────────
  const external = routableAddress();
  if (external) {
    log(`step 3: connect to the bridge port through this machine's own address ${external}`);
    const outcome = await tryConnect(external, bridge.port);
    assert(outcome !== "connected", `connection via ${external}:${bridge.port} did not succeed (${outcome})`);
    const local = await tryConnect("127.0.0.1", bridge.port);
    assert(local === "connected", "while 127.0.0.1 accepts the connection");
  } else {
    log("step 3: skipped — this machine has no routable IPv4 address");
  }

  const exit = await app.stop();
  app = null;
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");

  // ── 4. No socket without HERMES_E2E=1 ────────────────────────────
  if (IS_CI || process.env.HERMES_E2E_ALLOW_FOCUS === "1") {
    log("step 4: launch the same binary WITHOUT HERMES_E2E=1");
    const privateTmp = mkdtempSync(join(tmpdir(), "hermes-e2e-"));
    const home = join(privateTmp, "home");
    mkdirSync(home, { recursive: true });
    const bridgeFile = join(evidenceDir, "run-plain", "bridge.json");
    mkdirSync(join(evidenceDir, "run-plain"), { recursive: true });
    rmSync(bridgeFile, { force: true });
    const fd = openSync(join(evidenceDir, "run-plain", "app.log"), "w");
    const env = { ...inheritedEnv(), HERMES_E2E_BRIDGE_FILE: bridgeFile, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp };
    if (platform() !== "win32") {
      Object.assign(env, {
        HOME: home,
        CFFIXED_USER_HOME: home,
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
      });
    }
    delete env.HERMES_E2E;
    const child = spawn(appBinaryPath(), [], { cwd: join(evidenceDir, "run-plain"), env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    let exited = null;
    child.on("exit", (code, signal) => {
      exited = { code, signal };
    });
    // Give it as long as a normal start takes to reach the bridge, and more.
    const settle = Date.now() + 8_000;
    while (Date.now() < settle && !exited) await sleep(200);
    try {
      assert(!exited, `the app is still running after 8 s (pid ${child.pid})`);
      assert(!existsSync(bridgeFile), "no bridge file was written");
      const plainSockets = listeningSockets(child.pid);
      log(`  listening sockets of pid ${child.pid}: ${plainSockets ? JSON.stringify(plainSockets) : "(no tool to list them here)"}`);
      if (plainSockets) assert(plainSockets.length === 0, "the app has no listening socket at all");
    } finally {
      child.kill("SIGKILL");
      const until = Date.now() + 5_000;
      while (!exited && Date.now() < until) await sleep(100);
      rmSync(privateTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      log(`  plain app stopped: ${JSON.stringify(exited)}`);
    }
  } else {
    log("step 4: skipped — launching without HERMES_E2E=1 would bring a window to the front; set HERMES_E2E_ALLOW_FOCUS=1 to run it here");
  }
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
} finally {
  if (app) {
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
