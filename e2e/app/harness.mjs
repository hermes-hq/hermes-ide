// Drives the REAL Hermes desktop app through the test-only automation bridge
// (src-tauri/src/e2e_bridge.rs). No window focus, no keyboard or mouse
// takeover: every action is sent to the app over a local, token-protected
// socket and runs inside the app's own webview.
//
// Zero dependencies — Node 20+ only — so the same file runs on macOS, Linux
// and Windows runners.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const SCENARIOS_DIR = join(HERE, "scenarios");
export const E2E_IDENTIFIER = "com.hermes-ide.terminal.e2e";
/** True on a CI runner, where nobody is using the machine. */
export const IS_CI = process.env.CI === "true" || process.env.CI === "1";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where build.mjs stages the test app. */
export function outDir() {
  return process.env.HERMES_E2E_OUT || join(tmpdir(), "hermes-e2e");
}

export function appBinaryPath() {
  const exe = platform() === "win32" ? "hermes-ide-e2e.exe" : "hermes-ide-e2e";
  return join(outDir(), "bin", exe);
}

/** Data directory of the TEST app (never the production one). */
export function e2eDataDir(home = homedir()) {
  if (platform() === "darwin") return join(home, "Library", "Application Support", E2E_IDENTIFIER);
  if (platform() === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), E2E_IDENTIFIER);
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), E2E_IDENTIFIER);
}

/**
 * Only for runs that use the real home folder: start from a first-launch
 * state. Refuses any path but the test app's own data folder.
 */
export function resetE2eDataDir() {
  const dir = e2eDataDir();
  if (basename(dir) !== E2E_IDENTIFIER || !dir.endsWith(".e2e")) {
    throw new Error(`refusing to reset unexpected directory: ${dir}`);
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ─── Logging ─────────────────────────────────────────────────────────

export function createLogger(logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  const started = Date.now();
  return (message) => {
    const line = `[${new Date().toISOString()}] +${String(Date.now() - started).padStart(6, " ")}ms  ${message}`;
    console.log(line);
    appendFileSync(logFile, line + "\n");
  };
}

// ─── Bridge client ───────────────────────────────────────────────────

export class Bridge {
  constructor({ port, token, pid }) {
    this.port = port;
    this.token = token;
    this.pid = pid;
  }

  static fromFile(file) {
    return new Bridge(JSON.parse(readFileSync(file, "utf8")));
  }

  async request(method, path, body, { timeoutMs = 30_000 } = {}) {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`bridge ${method} ${path} -> ${res.status}: ${json.error ?? JSON.stringify(json)}`);
    return json;
  }

  health() {
    return this.request("GET", "/health");
  }

  windowInfo() {
    return this.request("GET", "/window");
  }

  async quit() {
    try {
      await this.request("POST", "/quit", {});
    } catch {
      // The app may close the socket while exiting — that is a success.
    }
  }

  /**
   * Run JavaScript inside the app's main webview.
   * `script` is the body of an async function; `return` a JSON-serialisable
   * value. The DOM helpers in PRELUDE are available as `e2e`.
   */
  async eval(script, { timeoutMs = 10_000 } = {}) {
    const out = await this.request(
      "POST",
      "/eval",
      { script: `${PRELUDE}\n${script}`, timeoutMs },
      { timeoutMs: timeoutMs + 10_000 },
    );
    if (!out.ok) throw new Error(`script failed in the app: ${out.value}`);
    return out.value;
  }

  /** Poll `script` until it returns something truthy; returns that value. */
  async waitFor(description, script, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    let lastError;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(script);
        lastError = undefined;
        if (last) return last;
      } catch (e) {
        lastError = e;
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `timed out after ${timeoutMs} ms waiting for: ${description}` +
        (lastError ? ` (last error: ${lastError.message})` : ` (last value: ${JSON.stringify(last)})`),
    );
  }

  // ── High-level actions ─────────────────────────────────────────────

  /**
   * Run a click script, waiting (like a person would) while the target is
   * missing, disabled, or covered by something else.
   */
  async clickWhenReady(script, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await this.eval(script);
      } catch (e) {
        const waitable = /not clickable yet|element not found or not visible/.test(e.message);
        if (!waitable || Date.now() > deadline) throw e;
        await sleep(100);
      }
    }
  }

  /** Click the first visible element matching a CSS selector. */
  click(selector, opts) {
    return this.clickWhenReady(
      `return e2e.click(e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)}));`,
      opts,
    );
  }

  /** Click a visible button/link/role element by its accessible name or text. */
  clickByName(name, { within, ...opts } = {}) {
    return this.clickWhenReady(
      `return e2e.click(e2e.must(e2e.byName(${JSON.stringify(name)}, ${JSON.stringify(within ?? null)}), ${JSON.stringify("name: " + name)}));`,
      opts,
    );
  }

  /** Visible text of the first element matching the selector (null if absent). */
  text(selector) {
    return this.eval(`const el = e2e.first(${JSON.stringify(selector)}); return el ? el.innerText : null;`);
  }

  exists(selector) {
    return this.eval(`return !!e2e.first(${JSON.stringify(selector)});`);
  }

  /** Session ids that have a terminal right now. */
  terminalIds() {
    return this.eval(`return window.__HERMES_E2E__.terminalIds();`);
  }

  /** Logical lines currently in a terminal (scrollback + screen). */
  readTerminal(sessionId) {
    return this.eval(`return window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)});`);
  }

  /**
   * Type into a terminal the way a keyboard does: real key events on the
   * terminal's own input element, one key at a time. Use "\n" for Enter.
   */
  typeInTerminal(sessionId, text) {
    return this.eval(`return e2e.typeInTerminal(${JSON.stringify(sessionId)}, ${JSON.stringify(text)});`, {
      timeoutMs: 10_000 + text.length * 50,
    });
  }

  /** Wait until the terminal shows a line matching `pattern` (a RegExp). */
  async waitForTerminal(sessionId, pattern, { timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lines = [];
    while (Date.now() < deadline) {
      lines = (await this.readTerminal(sessionId)) ?? [];
      const hit = lines.find((l) => pattern.test(l));
      if (hit !== undefined) return { line: hit, lines };
      await sleep(100);
    }
    throw new Error(
      `terminal never showed ${pattern} within ${timeoutMs} ms. Last content:\n${lines.join("\n")}`,
    );
  }

  /**
   * Wait until what the page shows has been painted: two animation frames,
   * so a renderer that draws on the next frame (the terminal does) has had
   * its turn. A hidden window may never get a frame; then this gives up
   * after a moment instead of hanging.
   */
  settle({ timeoutMs = 1_500 } = {}) {
    return this.eval(`
      await new Promise((done) => {
        const giveUp = setTimeout(() => done("timeout"), ${timeoutMs});
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(giveUp); done("painted"); }));
      });
      return true;
    `);
  }

  /**
   * Save a PNG of the app window as it looks right now. The app captures its
   * own window from the inside, so this needs neither focus, nor the window
   * being in front, nor a screen-recording permission — and it works on a
   * virtual display. A picture that is one flat colour (nothing painted,
   * screen locked) is not evidence and fails the call.
   */
  async screenshot(file) {
    const target = resolve(file);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    await this.settle();
    await sleep(SCREENSHOT_SETTLE_MS);
    const shot = await this.request("POST", "/screenshot", { file: target }, { timeoutMs: 30_000 });
    if (!existsSync(target) || statSync(target).size === 0) {
      throw new Error(`the app reported a screenshot but ${target} is missing or empty`);
    }
    const flat = pngFlatColour(target);
    if (flat) {
      rmSync(target, { force: true });
      throw new Error(`the screenshot ${target} is one flat colour (${flat}): the window had not painted, or the screen is locked`);
    }
    return { file: target, bytes: statSync(target).size, width: shot.width, height: shot.height };
  }
}

/** After the page has painted, the window system still needs a moment to show it. */
const SCREENSHOT_SETTLE_MS = 250;

/**
 * The one colour a PNG consists of ("#rrggbb"), or null when it shows more
 * than one. Reads the 8-bit, non-interlaced greyscale/RGB/RGBA files the app
 * writes; anything else is an error, never a silent pass. Zero dependencies:
 * the runners have Node and nothing else.
 */
export function pngFlatColour(file) {
  const buf = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(signature)) throw new Error(`${file} is not a PNG`);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = -1;
  let interlace = 0;
  const idat = [];
  for (let pos = 8; pos + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (!width || !height || !channels || depth !== 8 || interlace !== 0) {
    throw new Error(`${file}: unsupported PNG (${width}x${height}, ${depth}-bit, colour type ${colourType}, interlace ${interlace})`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error(`${file}: PNG data is truncated`);
  let previous = Buffer.alloc(stride);
  let first = null;
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    const row = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let predicted;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`${file}: bad PNG filter ${filter} on row ${y}`);
      row[i] = (row[i] + predicted) & 0xff;
    }
    for (let x = 0; x < stride; x += channels) {
      const pixel = row.subarray(x, x + channels);
      if (first === null) first = Buffer.from(pixel);
      else if (!pixel.equals(first)) return null;
    }
    previous = row;
  }
  const rgb = channels < 3 ? [first[0], first[0], first[0]] : [first[0], first[1], first[2]];
  return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// ─── Scenario results ────────────────────────────────────────────────

/**
 * Write the machine-readable outcome of a scenario run next to its evidence,
 * print the RESULT line, and exit. The runner (run.mjs) and the acceptance
 * gate (../acceptance-check.mjs) read these files.
 */
export function finishScenario({ scenario, evidenceDir, failed, startedAt, log = console.log, details = {} }) {
  const result = {
    scenario,
    platform: platform(),
    status: failed ? "fail" : "pass",
    durationMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
    ...details,
  };
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

// ─── Launch / stop ───────────────────────────────────────────────────

/**
 * The environment the test app starts with: the caller's, minus everything a
 * surrounding Hermes terminal or coding agent put there. The harness is often
 * started from inside one, and the app under test must not inherit that
 * session's identity or shell setup.
 */
export function inheritedEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(_?HERMES_|CLAUDE_|CLAUDECODE$|ZDOTDIR$|TERM_PROGRAM)/.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * Start the test app and wait until its UI is ready.
 * Returns { bridge, child, stop }.
 *
 * home: "private" (default on macOS/Linux) gives the app a throwaway home
 *       folder: first-launch state every run, no user shell config, nothing
 *       written to the real home (not even shell history).
 *       "real" uses the real home — needed when a scenario must use agent
 *       CLIs that are signed in there; the test app's own data folder is
 *       reset instead.
 * tmp:  "private" (default) gives the app its own temp folder. "shared" uses
 *       the machine's real temp folder, like a second build a developer
 *       starts next to an installed Hermes.
 * env:  extra environment variables (e.g. HERMES_DATA_DIR).
 */
export async function launchApp({
  runDir,
  log = () => {},
  home = platform() === "win32" ? "real" : "private",
  startupTimeoutMs = 60_000,
  tmp = "private",
  env: extraEnv = {},
} = {}) {
  const binary = appBinaryPath();
  if (!existsSync(binary)) {
    throw new Error(`test app not built: ${binary} is missing — run \`node e2e/app/build.mjs\` first`);
  }
  mkdirSync(runDir, { recursive: true });
  const bridgeFile = join(runDir, "bridge.json");
  rmSync(bridgeFile, { force: true });

  // A private temp folder by default, so a test run leaves nothing behind in
  // the real one. Every Hermes only ever cleans up its own shell-setup files,
  // so "shared" is safe next to an installed Hermes.
  const privateTmp = mkdtempSync(join(tmpdir(), "hermes-e2e-"));
  const appTmp = tmp === "shared" ? tmpdir() : privateTmp;

  const homeEnv = {};
  let dataDir;
  if (home === "private") {
    const privateHome = join(privateTmp, "home");
    mkdirSync(privateHome, { recursive: true });
    homeEnv.HOME = privateHome;
    homeEnv.CFFIXED_USER_HOME = privateHome; // macOS system frameworks
    homeEnv.XDG_DATA_HOME = join(privateHome, ".local", "share");
    homeEnv.XDG_CONFIG_HOME = join(privateHome, ".config");
    homeEnv.XDG_CACHE_HOME = join(privateHome, ".cache");
    dataDir =
      platform() === "darwin"
        ? join(privateHome, "Library", "Application Support", E2E_IDENTIFIER)
        : join(homeEnv.XDG_DATA_HOME, E2E_IDENTIFIER);
  } else {
    resetE2eDataDir();
    dataDir = e2eDataDir();
  }
  if (extraEnv.HERMES_DATA_DIR) dataDir = extraEnv.HERMES_DATA_DIR;

  const appLog = join(runDir, "app.log");
  const fd = openSync(appLog, "w");
  const child = spawn(binary, [], {
    cwd: runDir,
    env: {
      ...inheritedEnv(),
      ...homeEnv,
      HERMES_E2E: "1",
      HERMES_E2E_BRIDGE_FILE: bridgeFile,
      RUST_LOG: process.env.RUST_LOG || "info",
      TMPDIR: appTmp,
      TMP: appTmp,
      TEMP: appTmp,
      ...extraEnv,
    },
    stdio: ["ignore", fd, fd],
    detached: false,
  });
  closeSync(fd);
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  log(`launched ${binary} (pid ${child.pid}); app log: ${appLog}`);
  log(`home folder: ${home}; app data folder: ${dataDir}`);

  const deadline = Date.now() + startupTimeoutMs;
  while (!existsSync(bridgeFile)) {
    if (exited) throw new Error(`app exited during startup: ${JSON.stringify(exited)} — see ${appLog}`);
    if (Date.now() > deadline) throw new Error(`bridge file never appeared: ${bridgeFile} — see ${appLog}`);
    await sleep(100);
  }
  // The file is created before it is filled; retry until it parses.
  let bridge;
  for (;;) {
    try {
      bridge = Bridge.fromFile(bridgeFile);
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(50);
    }
  }
  const health = await bridge.health();
  if (health.identifier !== E2E_IDENTIFIER) {
    throw new Error(`connected to the wrong app: ${health.identifier}`);
  }
  log(`bridge up on 127.0.0.1:${bridge.port} — ${health.identifier} v${health.version} (pid ${health.pid})`);

  await bridge.waitFor(
    "the app UI to render",
    `return document.readyState === "complete"
       && !!document.getElementById("root")?.firstElementChild
       && !!window.__HERMES_E2E__;`,
    { timeoutMs: Math.max(5_000, deadline - Date.now()) },
  );

  const cleanTmp = () => {
    // Only ever the folder this run created.
    if (basename(privateTmp).startsWith("hermes-e2e-")) rmSync(privateTmp, { recursive: true, force: true });
  };

  const stop = async () => {
    if (!exited) {
      await bridge.quit();
      const until = Date.now() + 10_000;
      while (!exited && Date.now() < until) await sleep(100);
    }
    if (!exited) {
      child.kill("SIGKILL");
      await sleep(300);
      cleanTmp();
      return { code: null, signal: "SIGKILL", forced: true };
    }
    cleanTmp();
    return exited;
  };

  return { bridge, child, stop, isRunning: () => !exited, appLog, tmpDir: appTmp, dataDir };
}

// ─── In-page helpers (sent along with every script) ──────────────────

const PRELUDE = String.raw`
const e2e = (() => {
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const all = (selector, root) => [...(root || document).querySelectorAll(selector)].filter(visible);
  const first = (selector, root) => all(selector, root)[0] || null;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const nameOf = (el) =>
    norm(el.getAttribute("aria-label")) || norm(el.getAttribute("title")) || norm(el.innerText);
  const byName = (name, within) => {
    const root = within ? first(within) : document;
    if (!root) return null;
    const candidates = all('button, a, [role="button"], [role="radio"], [role="tab"], [role="menuitem"], label', root);
    const want = norm(name).toLowerCase();
    return (
      candidates.find((el) => nameOf(el).toLowerCase() === want) ||
      candidates.find((el) => nameOf(el).toLowerCase().startsWith(want)) ||
      candidates.find((el) => nameOf(el).toLowerCase().includes(want)) ||
      null
    );
  };
  const must = (el, what) => {
    if (!el) throw new Error("element not found or not visible: " + what);
    return el;
  };
  const describe = (el) =>
    el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "");
  const click = (el) => {
    if (el.disabled) throw new Error("not clickable yet: element is disabled: " + nameOf(el));
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // A person can only click what is on top. Refuse to click through an
    // overlay, a dialog or anything else that covers the target.
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) {
      throw new Error("not clickable yet: " + describe(el) + " is covered by " + (top ? describe(top) : "nothing (outside the window)"));
    }
    const at = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...at, buttons: 1, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.dispatchEvent(new MouseEvent("click", { ...at, detail: 1 }));
    return { clicked: nameOf(el).slice(0, 80), tag: el.tagName.toLowerCase() };
  };

  const KEYS = {
    "\n": { key: "Enter", code: "Enter", keyCode: 13 },
    "\r": { key: "Enter", code: "Enter", keyCode: 13 },
    "\t": { key: "Tab", code: "Tab", keyCode: 9 },
    " ": { key: " ", code: "Space", keyCode: 32 },
    "-": { key: "-", code: "Minus", keyCode: 189 },
    ".": { key: ".", code: "Period", keyCode: 190 },
    "/": { key: "/", code: "Slash", keyCode: 191 },
    "_": { key: "_", code: "Minus", keyCode: 189, shiftKey: true },
  };
  const describeKey = (ch) => {
    if (KEYS[ch]) return KEYS[ch];
    if (/^[a-z]$/.test(ch)) return { key: ch, code: "Key" + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0) };
    if (/^[A-Z]$/.test(ch)) return { key: ch, code: "Key" + ch, keyCode: ch.charCodeAt(0), shiftKey: true };
    if (/^[0-9]$/.test(ch)) return { key: ch, code: "Digit" + ch, keyCode: ch.charCodeAt(0) };
    return { key: ch, code: "", keyCode: 0 };
  };
  const keyEvent = (type, d, extra) => {
    const ev = new KeyboardEvent(type, {
      key: d.key, code: d.code, shiftKey: !!d.shiftKey, bubbles: true, cancelable: true, composed: true, view: window,
    });
    // The legacy numeric fields are read-only on synthetic events in some
    // webviews; the terminal reads them, so pin them to the real values.
    const pin = (name, value) => Object.defineProperty(ev, name, { get: () => value });
    pin("keyCode", extra?.keyCode ?? d.keyCode);
    pin("which", extra?.which ?? d.keyCode);
    pin("charCode", extra?.charCode ?? 0);
    return ev;
  };
  const terminalInput = (sessionId) => {
    const host = document.querySelector('div[data-session-id="' + CSS.escape(sessionId) + '"]');
    if (!host) throw new Error("no terminal for session " + sessionId);
    const ta = host.querySelector("textarea.xterm-helper-textarea");
    if (!ta) throw new Error("terminal for session " + sessionId + " has no input element yet");
    return ta;
  };
  const typeInTerminal = async (sessionId, text) => {
    const ta = terminalInput(sessionId);
    let sent = 0;
    for (const ch of text) {
      const d = describeKey(ch);
      // Same rule as a real keyboard: when the app consumes the key-down
      // (preventDefault), no key-press follows.
      const notConsumed = ta.dispatchEvent(keyEvent("keydown", d));
      if (notConsumed && d.key.length === 1) {
        const code = d.key.charCodeAt(0);
        ta.dispatchEvent(keyEvent("keypress", d, { keyCode: code, which: code, charCode: code }));
      }
      ta.dispatchEvent(keyEvent("keyup", d));
      sent++;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { typed: sent };
  };

  return { visible, all, first, byName, nameOf, must, click, typeInTerminal, norm };
})();
`;
