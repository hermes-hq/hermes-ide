// Shared steps for the 2.0 launch-contract scenarios (CAP: models, effort,
// accounts, presets, refused launches): fake vendor CLIs on the app's
// PATH, their launch records, a throwaway repository, and the Settings >
// Agents screen.
//
// The fakes are tools/fake-agents/fake-cli.mjs behind a `claude`, `codex`
// or `agy` shim. They answer the capability probes like the real CLIs and
// refuse the models a scenario lists (see the fake's header).

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "./harness.mjs";

export const onWindows = platform() === "win32";
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");

/** Which catalog agent each shim stands in for. */
const SHIMS = { claude: "claude", codex: "codex", agy: "antigravity" };

/**
 * A work folder with a throwaway git repository, a folder of fake CLIs, the
 * fakes' record folder and a profile root (where Add account creates
 * profile folders in a test build). The process PATH gets the fakes first
 * and loses every folder with a real CLI of the same name.
 */
export function setupFakes(tag, bins = ["claude", "codex", "agy"]) {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), `hermes-e2e-${tag}-`)));
  const repo = join(work, `${tag}-repo`);
  const fakeBin = join(work, "bin");
  const recordDir = join(work, "records");
  const profileRoot = join(work, "profiles");
  const home = join(work, "home");
  for (const d of [fakeBin, recordDir, profileRoot, home]) mkdirSync(d, { recursive: true });
  for (const bin of bins) {
    const agent = SHIMS[bin] ?? bin;
    if (onWindows) {
      writeFileSync(join(fakeBin, `${bin}.cmd`), `@set "HERMES_FAKE_AGENT=${agent}"\r\n@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
    } else {
      writeFileSync(join(fakeBin, bin), `#!/bin/sh\nHERMES_FAKE_AGENT=${agent} exec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
      chmodSync(join(fakeBin, bin), 0o755);
    }
  }
  const hasReal = (dir) => bins.some((b) => ["", ".exe", ".cmd"].some((ext) => existsSync(join(dir, b + ext))));
  process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasReal(d))].join(delimiter);
  for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CONFIG_DIR$)/.test(name)) delete process.env[name];

  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  for (const [k, v] of [["user.name", "Hermes Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"]]) execFileSync("git", ["-C", repo, "config", k, v], { env: gitEnv });
  writeFileSync(join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["-C", repo, "add", "."], { env: gitEnv });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"], { env: gitEnv });
  return { work, repo, fakeBin, recordDir, profileRoot, home };
}

/** The environment the test app needs for the fakes. */
export function fakeEnv(f) {
  return {
    HERMES_FAKE_DIR: f.recordDir,
    // The probes look only here (test builds), never at a real CLI.
    HERMES_E2E_AGENT_PATH: f.fakeBin,
    // Add account creates its profile folders here, never in a real home.
    HERMES_E2E_PROFILE_ROOT: f.profileRoot,
  };
}

/** A fake setting read at the fake's next start (<record dir>/<name>-<agent>). */
export function setFake(f, name, agent, value) {
  writeFileSync(join(f.recordDir, `${name}-${agent}`), `${value}\n`);
}

/** The fakes' mode for their next start (all agents). */
export function setFakeMode(f, mode) {
  writeFileSync(join(f.recordDir, "mode"), `${mode}\n`);
}

/** Windows terminals take PATH from the registry: see N12-launch-and-resume.mjs. */
export function registryPath(f, log) {
  if (!onWindows) return () => {};
  if (process.env.GITHUB_ACTIONS !== "true") return null;
  let old = null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    const m = out.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
    old = m ? m[1].trim() : "";
  } catch {
    old = null;
  }
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old ? `${old};${f.fakeBin}` : f.fakeBin, "/f"]);
  log("  (CI runner: added the fake agents' folder to the user's registry Path)");
  return () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    log("  (CI runner: restored the user's registry Path)");
  };
}

/** The fakes' launch records, oldest first. */
export function records(f) {
  return readdirSync(f.recordDir)
    .filter((n) => n.startsWith("launch-"))
    .sort()
    .flatMap((n) => {
      try {
        return [{ file: n, ...JSON.parse(readFileSync(join(f.recordDir, n), "utf8")) }];
      } catch {
        return [];
      }
    });
}

export function logins(f) {
  return readdirSync(f.recordDir)
    .filter((n) => n.startsWith("login-"))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(f.recordDir, n), "utf8")));
}

export async function waitForRecord(f, what, test, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = records(f).find(test);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no fake launch record for ${what} within ${timeoutMs} ms (have ${records(f).length})`);
    await sleep(150);
  }
}

export function launch(f, evidenceDir, log, run, { first = false, env = {} } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const common = { runDir, log, env: { ...fakeEnv(f), ...env } };
  return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir: f.home });
}

export const invoke = (bridge, cmd, args = {}) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)});`, { timeoutMs: 60_000 });

async function dismissWhatsNew(bridge) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

/** The classic first-launch welcome (the task launcher is off in these runs). */
export async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`, { timeoutMs: 30_000 });
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
  await dismissWhatsNew(bridge);
}

/** Start a terminal agent with a launch choice, as the launcher does (test hook). */
export function launchWithChoice(bridge, opts) {
  return bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify(opts)});`, { timeoutMs: 60_000 });
}

export async function openAgentsSettings(bridge) {
  if (!(await bridge.exists(".settings-tabs"))) {
    await bridge.clickByName("Settings");
    await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  }
  await bridge.clickWhenReady(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Agents");
    return e2e.click(e2e.must(tab, "Agents tab"));
  `);
  await bridge.waitFor("the Agents screen", `return !!e2e.first(".agents-settings") && e2e.first(".agents-settings").dataset.loading === "false" && e2e.all(".agents-settings-card").length > 0;`, { timeoutMs: 60_000 });
}

export async function closeSettings(bridge) {
  if (await bridge.exists(".settings-close")) {
    await bridge.click(".settings-close");
    await bridge.waitFor("Settings to close", `return !e2e.first(".settings-tabs");`);
  }
}

/** One agent card of Settings > Agents, as text. */
export function agentCard(bridge, agentId) {
  return bridge.eval(`
    const card = e2e.first('.agents-settings-card[data-agent-id="${agentId}"]');
    if (!card) return null;
    const q = (s) => e2e.norm(card.querySelector(s)?.innerText ?? "");
    return {
      verified: card.dataset.verified,
      verifiedText: q(".agents-settings-verified"),
      accounts: [...card.querySelectorAll(".agents-settings-account")].map((a) => ({ id: a.dataset.accountId, state: a.dataset.signedIn, text: e2e.norm(a.innerText) })),
      models: q(".agents-settings-models"),
      effort: q(".agents-settings-effort"),
      approval: q(".agents-settings-approval"),
      status: card.querySelector(".agents-settings-status")?.dataset.statusSource ?? null,
      canAdd: !!card.querySelector(".agents-settings-add"),
      note: q(".agents-settings-account-note"),
    };
  `);
}

/** The terminal's text as one line (a long line can wrap). */
export async function terminalText(bridge, sessionId) {
  const rows = (await bridge.readTerminal(sessionId)) ?? [];
  return rows.map((r) => r.trimEnd()).join("\n");
}

export async function waitForTerminalText(bridge, sessionId, test, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await terminalText(bridge, sessionId);
    if (test(text.replace(/\s+/g, " "))) return text;
    await sleep(100);
  }
  throw new Error(`terminal never showed ${what} within ${timeoutMs} ms. Last content:\n${text}`);
}

/** Delete the work folder; on Windows a shell that is still closing can hold it a moment, which is not a failure. */
export function removeWork(f, log) {
  try {
    rmSync(f.work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    log(`  (could not delete the work folder yet: ${e.code ?? e.message})`);
  }
}
