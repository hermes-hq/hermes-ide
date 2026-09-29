// Shared steps for the local-only REAL-models-* scenarios: the REAL vendor
// CLIs (claude, codex, agy) started by the test app with a model, an effort
// and an account (2.0 launch contract). They never run in CI (RESULT: SKIP,
// and e2e/app/ci-plan.mjs excludes them), need a signed-in CLI, and cost one
// tiny prompt per launch on the cheapest model that fits.
//
// What they must never do: change the person's sign-in or config. The files
// a person writes (`guard`) are compared byte for byte before and after, and
// put back if anything changed them. Profile folders for a second account
// go into a temporary folder the scenario creates and deletes
// (HERMES_E2E_PROFILE_ROOT, test builds only).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, launchApp, sleep } from "./harness.mjs";

export const home = homedir();

export function which(name) {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
}

/** SKIP (exit 0) unless a real `bin` is here, outside CI, on macOS or Linux. */
export function requireRealCli(bin, log) {
  const path = which(bin);
  if (IS_CI || platform() === "win32" || !path) {
    log(`needs a real, signed-in ${bin} on PATH, macOS or Linux, and no CI (CI=${process.env.CI ?? ""}, ${bin}=${path || "none"})`);
    log(`RESULT: SKIP (real ${bin} not available here, or CI)`);
    process.exit(0);
  }
  const version = spawnSync(path, ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
  return { path, version };
}

/** Files only a person writes: kept byte for byte, restored if changed. */
export function guard(files, log) {
  const present = files.filter(existsSync);
  const before = new Map(present.map((f) => [f, readFileSync(f)]));
  for (const f of present) log(`  guarded: ${f.replace(home, "~")} (${before.get(f).length} bytes)`);
  return {
    check(assert) {
      for (const f of present) {
        const after = readFileSync(f);
        assert(Buffer.compare(before.get(f), after) === 0, `${f.replace(home, "~")} is byte-identical before and after`);
      }
    },
    restore() {
      for (const f of present) {
        if (existsSync(f) && Buffer.compare(before.get(f), readFileSync(f)) === 0) continue;
        writeFileSync(f, before.get(f));
        log(`  restored ${f.replace(home, "~")} to its bytes from before the scenario`);
      }
    },
  };
}

/** A throwaway git repository (synthetic identity) with optional files. */
export function throwawayRepo(tag, files = {}) {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), `hermes-e2e-${tag}-`)));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { env, encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  git("config", "user.name", "Hermes Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# throwaway\n\nA scratch repository for a Hermes test. Nothing here matters.\n");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

/** The test app with the real home (the CLI's own sign-in) and a temporary profile root. */
export async function launchRealApp(evidenceDir, log, profileRoot) {
  return launchApp({
    runDir: join(evidenceDir, "run-1"),
    log,
    home: "real",
    resetData: true,
    tmp: "shared",
    flagDefaults: { taskLauncher: false },
    env: { HERMES_E2E_PROFILE_ROOT: profileRoot },
  });
}

export function tempProfileRoot(tag) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `hermes-e2e-${tag}-profiles-`)));
}

export const invoke = (bridge, cmd, args = {}) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)});`, { timeoutMs: 90_000 });

export function launchWithChoice(bridge, opts) {
  return bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify(opts)});`, { timeoutMs: 60_000 });
}

/** The launch file Hermes wrote for a session. */
export async function launchSpec(app, sessionId, timeoutMs = 20_000) {
  const file = join(app.dataDir, "launch", sessionId, "launch.json");
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) await sleep(200);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Every process: { pid, ppid, command }. */
export function processes() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

/** The `hi run <session>` process and everything under it. */
export function launchTree(sessionId) {
  const all = processes();
  const hi = all.find((p) => new RegExp(`(^|/)hi run ${sessionId}(\\s|$)`).test(p.command));
  if (!hi) return { hi: null, children: [] };
  const children = [];
  const frontier = [hi.pid];
  while (frontier.length) {
    const p = frontier.pop();
    for (const c of all) if (c.ppid === p) {
      children.push(c);
      frontier.push(c.pid);
    }
  }
  return { hi, children };
}

export async function terminalText(bridge, sessionId) {
  return ((await bridge.readTerminal(sessionId)) ?? []).map((r) => r.trimEnd()).join("\n");
}

/** Press a key in the session's terminal the way a keyboard does. */
async function pressKey(bridge, sessionId, key, code, keyCode) {
  await bridge.eval(`
    const host = document.querySelector('div[data-session-id="${sessionId}"]');
    const ta = e2e.must(host && host.querySelector("textarea.xterm-helper-textarea"), "terminal input");
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true, composed: true, view: window });
      Object.defineProperty(ev, "keyCode", { get: () => ${keyCode} });
      Object.defineProperty(ev, "which", { get: () => ${keyCode} });
      ta.dispatchEvent(ev);
    }
    return true;
  `);
}

/**
 * Answer a folder-trust prompt (Claude Code, Codex, Antigravity ask in a
 * folder they have not seen) with Yes, until `done()` says the agent is
 * past it or `timeoutMs` passes. Returns how many prompts were answered.
 */
export async function answerTrustPrompts(bridge, sessionId, log, done, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let answered = 0;
  let lastAnswer = 0;
  while (Date.now() < deadline) {
    if (await done()) return answered;
    const lines = (await bridge.readTerminal(sessionId)) ?? [];
    const recent = lines.slice(-30).join("\n");
    if (/trust/i.test(recent) && Date.now() - lastAnswer > 3000) {
      const noSelected = /❯\s*(\d\.\s*)?(No|Quit|Exit|Don't)/i.test(recent) || /›\s*(\d\.\s*)?(No|Quit|Exit|Don't)/i.test(recent);
      log(`  a trust prompt; answering Yes${noSelected ? " (Down first)" : ""}`);
      await sleep(600);
      if (noSelected) {
        await pressKey(bridge, sessionId, "ArrowUp", "ArrowUp", 38);
        await sleep(200);
      }
      await bridge.typeInTerminal(sessionId, "\r");
      answered++;
      lastAnswer = Date.now();
    }
    await sleep(300);
  }
  return answered;
}

export const snapshot = (bridge, sessionId) => bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(sessionId)});`);

/** The agent's own report that its turn ended (a hook or notify, exact). */
export function turnEnded(snap) {
  return snap.events.some(
    (e) =>
      (e.type === "turn_end" && String(e.source ?? "").startsWith("hook")) ||
      (e.type === "status" && e.status.kind === "done_unread" && e.status.confidence === "exact" && String(e.source ?? "").startsWith("hook")),
  );
}

/** Approve a permission request the agent raises while it works (it should not need any). */
export async function approveIfAsked(bridge, sessionId, log) {
  const snap = await snapshot(bridge, sessionId);
  if (snap.status?.kind === "needs_approval") {
    log(`  the agent asks for a permission ("${snap.status.detail}"); answering Yes`);
    await bridge.typeInTerminal(sessionId, "\r");
    await sleep(1500);
  }
}

export async function waitForTurnEnd(bridge, sessionId, log, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await snapshot(bridge, sessionId);
    if (turnEnded(snap)) return snap;
    await approveIfAsked(bridge, sessionId, log);
    await sleep(500);
  }
  throw new Error(`no exact turn end from the agent within ${timeoutMs} ms. Terminal:\n${(await terminalText(bridge, sessionId)).split("\n").slice(-20).join("\n")}`);
}

export const banner = (bridge, sessionId) =>
  bridge.eval(`
    const b = e2e.first('.launch-rejected[data-session-id="${sessionId}"]');
    if (!b) return null;
    return {
      reason: b.dataset.reason,
      title: e2e.norm(b.querySelector(".launch-rejected-title").innerText),
      body: e2e.norm(b.querySelector(".launch-rejected-body").innerText),
      actions: [...b.querySelectorAll(".launch-rejected-action")].map((a) => a.dataset.action),
    };
  `);

export async function waitForBanner(bridge, sessionId, timeoutMs = 60_000) {
  await bridge.waitFor("the refusal banner", `return !!e2e.first('.launch-rejected[data-session-id="${sessionId}"]');`, { timeoutMs, intervalMs: 200 });
  return banner(bridge, sessionId);
}

/** End the agent in a session: its quit command, then Ctrl-C if it is still there. */
export async function quitAgent(bridge, sessionId, command) {
  await bridge.typeInTerminal(sessionId, `${command}\r`);
  await sleep(2500);
  if (launchTree(sessionId).children.length > 0) {
    await bridge.typeInTerminal(sessionId, "\x03");
    await sleep(800);
    await bridge.typeInTerminal(sessionId, "\x03");
    await sleep(1500);
  }
}

export function chip(bridge, sessionId) {
  return bridge.eval(`
    const row = e2e.first('.session-item[data-session-item-id="${sessionId}"]');
    const c = row && row.querySelector('[data-testid="session-model-chip"]');
    return c ? { text: e2e.norm(c.innerText), source: c.dataset.source } : null;
  `);
}

export function cleanup(paths) {
  for (const p of paths) if (p) rmSync(p, { recursive: true, force: true });
}
