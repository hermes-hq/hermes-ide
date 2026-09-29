#!/usr/bin/env node
// Scenario (N11): Copilot is found and started through the standalone
// `copilot` command that its install hint installs, not through `gh`
// (the retired `gh copilot` extension).
//
// A synthetic `copilot` program is placed in the private home folder's
// ~/.local/bin; it prints a marker with its arguments and waits. On a
// machine that has `gh` but no `copilot`, the old check reported Copilot as
// installed; the new one must not until `copilot` exists.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N11-copilot-cli.mjs

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, dismissWhatsNew, finishWizard, openWizard, runScenario } from "../n11-steps.mjs";

const MARKER = "fake-copilot started";

await runScenario("N11-copilot-cli", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log("step 1: prepare a private home whose shells put ~/.local/bin on PATH");
  const tmp = mkdtempSync(join(tmpdir(), "hermes-e2e-"));
  onCleanup(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const home = join(tmp, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const pathLine = 'export PATH="$HOME/.local/bin:$PATH"\n';
  for (const rc of [".zshenv", ".bashrc", ".bash_profile"]) writeFileSync(join(home, rc), pathLine);

  log("step 2: launch the test app on that home");
  const first = await launchApp({ runDir: join(evidenceDir, "run"), log, homeDir: home });
  apps.push(first);
  await completeOnboarding(first.bridge, log);
  // The launch helper (on by default since 2.0) adds its own arguments to
  // the agent's command line (the conversation id, the per-launch signal
  // settings); this scenario compares the typed line with the preview, so
  // it launches the old way.
  await first.bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ launchHelper: false }) });`);
  const firstExit = await first.stop();
  assert(!firstExit.forced && firstExit.code === 0, "the first launch quit cleanly");
  const app = await launchApp({ runDir: join(evidenceDir, "run-2"), log, homeDir: home });
  apps.push(app);
  const { bridge } = app;
  await bridge.waitFor("the app UI (no onboarding this time)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge, log);

  const ghOnMachine = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].some((p) => existsSync(p));
  log(`  gh installed on this machine: ${ghOnMachine ? "yes" : "no"}`);

  log("step 3: ask the app which AI tools are installed (no copilot yet)");
  const before = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("check_ai_providers");`);
  log(`  check_ai_providers: ${JSON.stringify(before)}`);
  assert(before.copilot === false, "Copilot is not reported as installed while only gh (or nothing) is present");

  log("step 4: install a synthetic copilot command into ~/.local/bin");
  const fake = join(bin, "copilot");
  writeFileSync(fake, `#!/bin/sh\necho "${MARKER} name=$(basename "$0") args=[$*]"\nsleep 60\n`);
  chmodSync(fake, 0o755);
  const after = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("check_ai_providers");`);
  log(`  check_ai_providers: ${JSON.stringify(after)}`);
  assert(after.copilot === true, "Copilot is reported as installed once the copilot command exists");

  log("step 5: start a Copilot terminal session from the New Session wizard");
  await openWizard(bridge);
  const card = await bridge.waitFor("the Copilot card", `
    const c = e2e.all(".session-creator-provider-card").find((el) =>
      (el.querySelector(".session-creator-provider-name")?.innerText ?? "").trim().includes("Copilot"));
    return c ? { unavailable: c.classList.contains("session-creator-provider-unavailable"), text: c.innerText } : null;
  `);
  log(`  Copilot card: ${JSON.stringify(card)}`);
  assert(!card.unavailable, "the wizard shows Copilot as detected");
  await bridge.clickWhenReady(`
    const c = e2e.all(".session-creator-provider-card").find((el) =>
      (el.querySelector(".session-creator-provider-name")?.innerText ?? "").trim().includes("Copilot"));
    return e2e.click(e2e.must(c, "the Copilot card"));
  `);
  // The preview settles once the agent's safety default is applied (Accept
  // edits for Copilot, from the agent catalog, on by default since 2.0).
  const COPILOT_PREVIEW = "copilot --allow-tool write";
  const preview = await bridge.waitFor("the launch preview for Copilot", `
    const t = e2e.first(".session-creator-launch-preview-cmd")?.innerText.trim();
    return t === ${JSON.stringify(COPILOT_PREVIEW)} ? t : null;
  `);
  log(`  launch preview: ${preview}`);
  await bridge.eval(`e2e.first(".session-creator-launch-preview")?.scrollIntoView({ block: "center" }); return true;`);
  await sleep(300);
  const previewShot = await bridge.screenshot(join(evidenceDir, "00-copilot-launch-preview.png"));
  log(`  screenshot saved: ${previewShot.file}`);
  assert(preview === COPILOT_PREVIEW, `the wizard previews the copilot command the app actually runs ("${preview}")`);
  const idsBefore = await bridge.terminalIds();
  await finishWizard(bridge, log);
  const sessionId = await bridge.waitFor(
    "the Copilot terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(idsBefore)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );

  log("step 6: the session runs the copilot command");
  const { line, lines } = await bridge.waitForTerminal(sessionId, new RegExp(MARKER), { timeoutMs: 30_000 });
  log(`  terminal: ${line.trim()}`);
  const ran = /name=(\S+) args=\[(.*)\]/.exec(line);
  const ranLine = ran ? [ran[1], ran[2]].filter(Boolean).join(" ") : "";
  log(`  command the shell ran: ${ranLine}`);
  assert(ranLine === preview, `the shell ran exactly the previewed line "${preview}"`);
  await sleep(500);
  const shot = await bridge.screenshot(join(evidenceDir, "01-copilot-session-started.png"));
  log(`  screenshot saved: ${shot.file}`);
  assert(!lines.some((l) => /gh copilot/.test(l)), "the launch line does not use gh copilot");
  assert(
    !lines.some((l) => /command not found|not recognized/i.test(l)),
    "the shell found the command it was asked to run",
  );
});
