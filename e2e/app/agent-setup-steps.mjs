// Shared steps for the F30 (instruction files) and F35 (safety default)
// scenarios: a fake agent, a launch with the agentCatalog flag forced on,
// and a New Session wizard walk that starts a catalog agent through a
// wrapper so the real CLI is never run.
//
// The fake agent is started as the "prefix command" of a catalog agent:
// Hermes types `<node> <fake-agent.mjs> claude --permission-mode ...`, so
// the launch line (and the command line Hermes reads back from the process)
// is exactly the one it builds for Claude or Codex, but the program that runs
// is ours. It prints its arguments, answers typed lines and exits on "quit".

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, sleep } from "./harness.mjs";
import { completeOnboarding, dismissWhatsNew, openWizard } from "./n11-steps.mjs";

export const onWindows = platform() === "win32";

/** Writes the fake agent; returns { dir, prefix } (prefix = what to type before the agent's command). */
export function writeFakeAgent(tag) {
  const dir = mkdtempSync(join(tmpdir(), `hermes-e2e-${tag}-`));
  const script = join(dir, "fake-agent.mjs");
  writeFileSync(
    script,
    `const args = process.argv.slice(2);
process.stdout.write("FAKE-AGENT " + args.join(" ") + "\\r\\n");
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.search(/[\\r\\n]/)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    if (line === "quit") { process.stdout.write("fake-agent bye\\r\\n"); process.exit(0); }
    process.stdout.write("fake-agent got: " + line + "\\r\\n");
  }
});
`,
  );
  const prefix = `${process.execPath} ${script}`;
  // Typed into the session's shell (zsh, bash, PowerShell, cmd) as written.
  if (/\s/.test(process.execPath) || /\s/.test(script)) {
    throw new Error(`the fake agent command would need quoting: ${prefix}`);
  }
  return { dir, prefix, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Launches the app `run` times against the same data. On macOS and Linux a
 * private home (`homeDir`); on Windows the test app's own data folder, since
 * app data lives under %APPDATA% there.
 */
export function launcher({ evidenceDir, log, homeDir }) {
  return (run, { first = false } = {}) => {
    const runDir = join(evidenceDir, `run-${run}`);
    return onWindows
      ? launchApp({ runDir, log, home: "real", resetData: first })
      : launchApp({ runDir, log, home: "private", homeDir });
  };
}

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

/**
 * First launch: onboarding, then force the agentCatalog flag on (flags are
 * read at startup) and relaunch. Returns the second app. With
 * `flagOn: false` the override is left alone (negative control).
 */
export async function launchWithCatalogFlag({ launch, log, apps, flagOn = true }) {
  let app = await launch(1, { first: true });
  apps.push(app);
  await completeOnboarding(app.bridge, log);
  if (flagOn) {
    await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ agentCatalog: true }) });
    log("  agentCatalog flag forced on (read at the next start)");
  } else {
    log("  agentCatalog flag left at its channel default (negative control)");
  }
  const exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  app = await launch(2);
  apps.push(app);
  await app.bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(app.bridge, log);
  return app;
}

/** Sets a React-controlled text input the way typing does. */
function setInputJs(findInput, value) {
  return `
    const input = e2e.must(${findInput}, "input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  `;
}

const byLabel = (label) =>
  `e2e.all(".session-creator-custom-suffix").find((d) => e2e.norm(d.querySelector(".session-creator-custom-suffix-label")?.textContent ?? "") === ${JSON.stringify(label)})?.querySelector("input")`;

const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";

/**
 * Walks the New Session wizard for a catalog agent in terminal mode.
 * Returns { sessionId, wizard } where wizard holds what the agent step showed
 * (active pill, its flags, the launch preview) before anything was changed.
 */
export async function startAgentSession(bridge, log, { agent, prefix, suffix = "", folders = [], label }) {
  await openWizard(bridge);
  await bridge.click(`.session-creator-provider-card[data-agent-id="${agent}"]`);
  await bridge.waitFor(`the ${agent} approval pills`, `return !!e2e.first(".session-creator-permission-pill-active");`);
  const shown = await bridge.eval(`
    const pill = e2e.first(".session-creator-permission-pill-active");
    return {
      pill: e2e.norm(pill?.innerText ?? ""),
      pillIsHermesDefault: !!pill?.querySelector(".session-creator-permission-pill-default"),
      flags: e2e.norm(e2e.first(".session-creator-permission-mode-flag")?.innerText ?? ""),
    };
  `);
  log(`  ${agent}: agent step shows ${JSON.stringify(shown)}`);
  await bridge.eval(setInputJs(byLabel("Prefix command"), prefix));
  if (suffix) await bridge.eval(setInputJs(byLabel("Custom flags"), suffix));
  const preview = await bridge.waitFor("the launch preview", `
    const t = e2e.norm(e2e.first(".session-creator-launch-preview-cmd")?.innerText ?? "");
    return t.includes(${JSON.stringify(prefix)}) ? t : null;
  `);
  log(`  launch preview: ${preview}`);
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "Next"));`);

  // Folder step: add each folder by path; the first is the session's folder.
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`);
  for (const folder of folders) {
    const name = folder.split(/[\\/]/).pop();
    const listed = await bridge.eval(`
      const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes(${JSON.stringify(name)}));
      if (!row) return false;
      if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
      return true;
    `);
    if (!listed) {
      await bridge.eval(setInputJs(`e2e.first(".workspace-scan-input")`, folder));
      await bridge.clickByName("Scan", { within: ".project-picker-footer" });
    }
    await bridge.waitFor(`${name} to be selected`, `
      return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes(${JSON.stringify(name)}));
    `);
  }

  const before = await bridge.terminalIds();
  for (let i = 0; i < 6; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    const clicked = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      const nameInput = e2e.first('input.command-palette-input[placeholder="Session name (optional)"]');
      if (nameInput && ${JSON.stringify(label ?? "")} && nameInput.value !== ${JSON.stringify(label ?? "")}) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(nameInput, ${JSON.stringify(label ?? "")});
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const b = e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button");
      return { step: e2e.first(".session-creator-step")?.innerText ?? "", ...e2e.click(b) };
    `);
    if (clicked) log(`  wizard ${clicked.step}: clicked "${clicked.clicked}"`);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const sessionId = await bridge.waitFor("the new terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  const banner = await bridge.waitForTerminal(sessionId, /^FAKE-AGENT /, { timeoutMs: 60_000 });
  const line = banner.lines.map((l) => l.trim()).find((l) => l.startsWith("FAKE-AGENT "));
  log(`  session ${sessionId}: ${line}`);
  return { sessionId, wizard: { ...shown, preview }, bannerLine: line };
}

/** The chips of the focused pane: { agentId, safety, files, label, looser }. */
export function readChips(bridge) {
  return bridge.eval(`
    const c = e2e.first(".split-pane-focused .agent-setup-chips") || e2e.first(".agent-setup-chips");
    if (!c) return null;
    const looser = c.querySelector(".agent-safety-chip");
    return {
      agentId: c.getAttribute("data-agent-id"),
      safety: c.getAttribute("data-safety"),
      files: c.getAttribute("data-files"),
      label: e2e.norm(c.querySelector(".agent-rules-chip")?.innerText ?? ""),
      looser: looser ? { text: e2e.norm(looser.innerText), title: looser.getAttribute("title") } : null,
    };
  `);
}

/** Quits the fake agent in a session. */
export async function quitFakeAgent(bridge, sessionId) {
  await bridge.typeInTerminal(sessionId, "quit\n");
  await bridge.waitForTerminal(sessionId, /^fake-agent bye$/, { timeoutMs: 15_000 });
}
