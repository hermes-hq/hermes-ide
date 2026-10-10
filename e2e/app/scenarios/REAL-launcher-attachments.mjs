#!/usr/bin/env node
// Scenario REAL-launcher-attachments (local only): the REAL `claude` CLI
// started from the ⌘N launcher with a pasted image and a dropped text file,
// in the isolated test build with a fresh profile.
//
// It runs only on a machine with a signed-in `claude` on PATH, macOS or
// Linux, and never in CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs lists
// it as excluded). One small turn on sonnet at low effort.
//
// What must hold:
//   - the pasted image (a solid red square) and the dropped file (a code
//     word) are chips in the launcher;
//   - claude's first prompt is the task followed by both paths;
//   - claude reads both and answers with the image's color and the code
//     word (any permission it asks for reading them is granted);
//   - ~/.claude/settings.json is byte-identical before and after.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-launcher-attachments.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";

const SCENARIO = "REAL-launcher-attachments";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const MODEL = "sonnet";
const EFFORT = "low";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const which = (name) => {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
};
const claudeBin = which("claude");
if (IS_CI || platform() === "win32" || !claudeBin) {
  log(`needs a real, signed-in claude on PATH, macOS or Linux, and no CI (CI=${process.env.CI ?? ""}, claude=${claudeBin || "none"})`);
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "real claude not available here, or CI", log });
}

const home = homedir();
const guarded = [join(home, ".claude", "settings.json")].filter(existsSync);
const before = new Map(guarded.map((f) => [f, readFileSync(f)]));

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-real-attach-")));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
git("config", "user.name", "Hermes Test");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "README.md"), "# throwaway\n\nA scratch repository for a Hermes test. Nothing here matters.\n");
git("add", ".");
git("commit", "-q", "-m", "init");

const TASK = "Look at the attached image and read the attached text file. Reply with exactly two lowercase words and nothing else: the color that fills the image, then the code word in the text file.";
const CODE_WORD = "zebra";

/** A solid-color PNG (RGB), built by hand: no image library needed. */
function solidPng(size, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = solidPng(64, [220, 20, 20]);
const notesDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-real-attach-notes ")));
const notesFile = join(notesDir, "code word.txt");
writeFileSync(notesFile, `The code word is ${CODE_WORD}.\n`);

const typeInto = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);
async function pickInMenu(bridge, chip, item) {
  await bridge.waitFor(`the ${chip} menu`, `
    if (e2e.first('.task-launcher-menu[data-menu="${chip}"]')) return true;
    const c = e2e.first('[data-chip="${chip}"]');
    return c && !c.disabled ? (e2e.click(c), false) : false;
  `);
  if (item) await bridge.waitFor(`${item} in the ${chip} menu`, `const el = e2e.first('.task-launcher-menu ${item}'); return el && !el.disabled ? e2e.click(el) : false;`);
}

async function threeStepWelcome(bridge) {
  await bridge.waitFor("the first-launch welcome", `return !!e2e.first(".setup-dialog, .onboarding-dialog");`, { timeoutMs: 30_000 });
  await bridge.click("#setup-policy-accept");
  await bridge.waitFor("Continue", `return !e2e.first(".setup-continue").disabled;`);
  await bridge.click(".setup-continue");
  await bridge.waitFor("the repository step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
  await bridge.click(".setup-skip");
  await bridge.waitFor("the task step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task";`);
  await bridge.click(".setup-finish");
  await bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

function processes() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}
async function findLaunchTree(sessionId, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = processes();
    const byPid = new Map(all.map((p) => [p.pid, p]));
    const hi = all.find((p) => new RegExp(`(^|/)hi run ${sessionId}(\\s|$)`).test(p.command));
    const claude = hi && all.find((p) => p.ppid === hi.pid && /claude/.test(p.command));
    if (hi && claude) return { hi, claude, shell: byPid.get(hi.ppid) ?? null };
    if (Date.now() > deadline) throw new Error(`no \`hi run ${sessionId}\` with a claude child within ${timeoutMs} ms`);
    await sleep(250);
  }
}
async function waitForStrip(bridge, sessionId, kinds, { confidence = null, timeoutMs = 120_000 } = {}) {
  return bridge.waitFor(`the strip to show ${kinds.join("/")}`, `
    const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]');
    if (!el || !${JSON.stringify(kinds)}.includes(el.dataset.statusKind)) return null;
    if (${JSON.stringify(confidence)} !== null && el.dataset.confidence !== ${JSON.stringify(confidence)}) return null;
    return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, text: e2e.norm(el.innerText) };
  `, { timeoutMs, intervalMs: 100 });
}
async function answerTrustPrompt(bridge, sessionId, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = (await bridge.readTerminal(sessionId)) ?? [];
    if (lines.some((l) => /trust/i.test(l))) {
      const yesBelow = lines.some((l) => /❯\s*No, exit/.test(l));
      await sleep(500);
      if (yesBelow) {
        await bridge.eval(`
          const host = document.querySelector('div[data-session-id="${sessionId}"]');
          const ta = e2e.must(host && host.querySelector("textarea.xterm-helper-textarea"), "terminal input");
          for (const type of ["keydown", "keyup"]) {
            const ev = new KeyboardEvent(type, { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true, composed: true, view: window });
            Object.defineProperty(ev, "keyCode", { get: () => 40 });
            Object.defineProperty(ev, "which", { get: () => 40 });
            ta.dispatchEvent(ev);
          }
          return true;
        `);
        await sleep(300);
      }
      await bridge.typeInTerminal(sessionId, "\n");
      return true;
    }
    const kind = await bridge.eval(`return e2e.first('.session-status-strip[data-strip-session="${sessionId}"]')?.dataset.statusKind ?? null;`);
    if (kind && kind !== "starting") return false;
    await sleep(250);
  }
  return false;
}

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   claude: ${spawnSync(claudeBin, ["--version"], { encoding: "utf8" }).stdout.trim()}   model ${MODEL}, effort ${EFFORT}`);
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, tmp: "shared", flagDefaults: null });
  const { bridge } = app;
  await threeStepWelcome(bridge);

  log("step 1: ⌘N, the project, the task, Claude on sonnet at low effort");
  if (platform() === "darwin") {
    await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "file.new-session" } }); return true;`);
  } else {
    await bridge.eval(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); return true;`);
  }
  await bridge.waitFor("the launcher's starting choice", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
  await pickInMenu(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", repo);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await pickInMenu(bridge, "model", `[data-model-id="${MODEL}"]`);
  await pickInMenu(bridge, "effort", `[data-effort="${EFFORT}"]`);

  log("step 2: paste the image, drop the text file");
  await bridge.eval(`
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG.toString("base64"))}), (c) => c.charCodeAt(0));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new File([bytes], "image.png", { type: "image/png" })], getData: () => "" } });
    e2e.must(e2e.first(".task-launcher-task"), "the task field").dispatchEvent(paste);
    return true;`);
  await bridge.waitFor("the image chip", `return e2e.all(".task-launcher-attachment-body").length === 1;`, { timeoutMs: 15_000 });
  await bridge.eval(`
    const row = e2e.must(e2e.first(".task-launcher-attachments"), "the attachments row").getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const position = { x: (row.left + 20) * dpr, y: (row.top + row.height / 2) * dpr };
    const target = { kind: "AnyLabel", label: "main" };
    const send = (event, payload) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", { target, event, payload });
    await send("tauri://drag-enter", { paths: [${JSON.stringify(notesFile)}], position });
    await send("tauri://drag-drop", { paths: [${JSON.stringify(notesFile)}], position });
    return true;`);
  await bridge.waitFor("the text file chip", `return e2e.all(".task-launcher-attachment-body").length === 2;`, { timeoutMs: 15_000 });
  const chips = await bridge.eval(`return e2e.all(".task-launcher-attachment-body").map((el) => el.dataset.path);`);
  log(`  chips: ${JSON.stringify(chips)}`);
  assert(chips.length === 2 && chips[1] === notesFile, "the image and the text file are chips");
  await bridge.waitFor("Launch to be enabled", `const b = e2e.first(".task-launcher-launch"); return !!b && !b.disabled;`, { timeoutMs: 60_000 });
  await bridge.screenshot(join(evidenceDir, "01-launcher.png"));

  log("step 3: Enter");
  const idsBefore = await bridge.terminalIds();
  await bridge.eval(`const ta = e2e.first(".task-launcher-task"); ta.focus(); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true;`);
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
  const [sid] = await bridge.waitFor("the task's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(idsBefore)}.includes(id));
    return ids.length >= 1 ? ids : null;
  `, { timeoutMs: 30_000 });
  const launchDir = join(app.dataDir, "launch", sid);
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(launchDir, "launch.json")) && Date.now() < deadline) await sleep(200);
  const spec = JSON.parse(readFileSync(join(launchDir, "launch.json"), "utf8"));
  const prompt = spec.args.find((a) => a.startsWith(TASK)) ?? "";
  log(`  first prompt: ${JSON.stringify(prompt.slice(0, 600))}`);
  assert(prompt.includes(chips[0]) && prompt.includes(notesFile), "claude's first prompt is the task followed by both paths");

  log("step 4: claude reads both and answers");
  await answerTrustPrompt(bridge, sid);
  let done = null;
  for (let i = 0; i < 6 && !done; i++) {
    const strip = await waitForStrip(bridge, sid, ["needs_approval", "done_unread", "idle"], { confidence: "exact", timeoutMs: 180_000 });
    if (strip.kind === "needs_approval") {
      log("  claude asks to read a file: yes");
      await sleep(800);
      await bridge.typeInTerminal(sid, "\n");
      await sleep(1500);
      continue;
    }
    if (strip.kind === "idle") {
      await sleep(1000);
      continue;
    }
    done = strip;
  }
  assert(done && done.source === "hook", `the turn ended, reported by the hook: "${done?.text}"`);
  // Claude's own answer, from the transcript it saves under ~/.claude/projects.
  const claudeSession = spec.args[spec.args.indexOf("--session-id") + 1];
  const projects = join(home, ".claude", "projects");
  let answer = "";
  for (let i = 0; i < 40 && !answer; i++) {
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      const file = join(projects, dir, `${claudeSession}.jsonl`);
      if (!existsSync(file)) continue;
      const texts = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e?.type === "assistant")
        .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
        .filter((c) => c.type === "text")
        .map((c) => c.text.trim())
        .filter(Boolean);
      answer = texts[texts.length - 1] ?? "";
    }
    if (!answer) await sleep(250);
  }
  log(`  claude answered: ${JSON.stringify(answer)}`);
  assert(/^\W*red\b/i.test(answer), "claude saw the image: its answer starts with red");
  assert(new RegExp(`\\b${CODE_WORD}\\b`, "i").test(answer), `claude read the text file: its answer has ${CODE_WORD}`);
  await bridge.screenshot(join(evidenceDir, "02-done.png"));
  await bridge.typeInTerminal(sid, "/exit\n");
  await sleep(1500);
  const exit = await app.stop();
  app = null;
  assert(exit.code === 0, "the app quit cleanly");
  for (const f of guarded) assert(Buffer.compare(before.get(f), readFileSync(f)) === 0, `${f.replace(home, "~")} is byte-identical before and after`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch {
    /* no screenshot */
  }
} finally {
  if (app?.isRunning()) await app.stop();
  rmSync(repo, { recursive: true, force: true });
  rmSync(notesDir, { recursive: true, force: true });
  for (const f of guarded) {
    if (Buffer.compare(before.get(f), readFileSync(f)) !== 0) {
      writeFileSync(f, before.get(f));
      log(`  restored ${f.replace(home, "~")}`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
