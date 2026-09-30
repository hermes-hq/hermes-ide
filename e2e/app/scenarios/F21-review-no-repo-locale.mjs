#!/usr/bin/env node
// Scenario F21: the Review Desk (⌘G) on a folder that is not a git
// repository, for a person whose system speaks German — on the REAL app.
//
// git translates its messages: under a German locale "not a git repository"
// reads "Kein Git-Repository". The Review Desk recognises the English
// message to show its plain "No git repository" state, so Hermes runs every
// git in the C locale. Here the app starts with a German locale (LANG,
// LC_ALL, LC_MESSAGES and LANGUAGE), a plain shell session works in a
// throwaway folder outside any repository, and ⌘G must show the
// "No git repository" state, not an error in German.
//
// First the scenario asks this machine's git itself: under the German
// locale it must answer in German, or the machine cannot show the problem
// and the scenario fails saying so (CI generates the de_DE.UTF-8 locale on
// Linux for this). The ledger runs it on macOS and Linux only: the Windows
// runner's git answers in English under any locale.
//
// Negative control (must end in RESULT: FAIL): HERMES_E2E_F21L_NEGATIVE=1
// starts the app with HERMES_E2E_GIT_USER_LOCALE=1, which (in test builds
// only) leaves git in the user's locale: the desk then shows git's German
// error instead of the empty state.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F21-review-no-repo-locale.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { E2E_FLAG_DEFAULTS, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { invoke, menuAction, setInput } from "../fleet-steps.mjs";

const SCENARIO = "F21-review-no-repo-locale";
const NEGATIVE = process.env.HERMES_E2E_F21L_NEGATIVE === "1";
const onWindows = platform() === "win32";
/** A German-speaking person's environment, as git reads it. */
const GERMAN = { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", LC_MESSAGES: "de_DE.UTF-8", LANGUAGE: "de" };

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   git left in the user's locale (negative control)" : ""}`);

  // ── A folder outside any repository ────────────────────────────────
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f21l-")));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  const folder = join(work, "plain-folder");
  const homeDir = join(work, "home");
  mkdirSync(folder, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  // ── This machine's git, asked in German ────────────────────────────
  const probe = (extra) =>
    spawnSync("git", ["-C", folder, "rev-parse", "--show-toplevel"], {
      // git stops looking for a repository above the throwaway folder.
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(folder), ...extra },
      encoding: "utf8",
    });
  const german = probe(GERMAN);
  log(`  git under the German locale says: ${JSON.stringify(german.stderr.trim())}`);
  assert(german.status !== 0, "the folder is not a git repository");
  assert(
    !/not a git repository/i.test(german.stderr),
    "this machine's git answers in German under the German locale (so the app's git would too)",
  );
  const english = probe({ ...GERMAN, LC_ALL: "C", LANG: "C", LANGUAGE: "" });
  assert(/not a git repository/i.test(english.stderr), `the C locale brings English back: ${JSON.stringify(english.stderr.trim())}`);

  // ── The app, started in German ─────────────────────────────────────
  const env = { ...GERMAN, ...(NEGATIVE ? { HERMES_E2E_GIT_USER_LOCALE: "1" } : {}) };
  const app = await (onWindows
    ? launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, env, flagDefaults: E2E_FLAG_DEFAULTS })
    : launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir, env, flagDefaults: E2E_FLAG_DEFAULTS }));
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  // ── A plain shell session in the folder ────────────────────────────
  log("a plain shell session in a folder that is not a repository");
  const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";
  const clickPrimary = async (what) => {
    const r = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return { clicked: null };
      return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
    `);
    log(`  wizard ${what}: ${r.clicked === null ? "already closed" : `clicked "${r.clicked}"`}`);
    await sleep(300);
    return r.clicked;
  };
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.click(".activity-bar-left > .activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await clickPrimary("agent");
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`, { timeoutMs: 20_000 });
  await setInput(bridge, ".workspace-scan-input", folder);
  await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  await bridge.waitFor("the folder to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("plain-folder"));
  `);
  await clickPrimary("folder");
  // The last press creates the session; the wizard then closes by itself.
  for (let i = 0; i < 6 && (await bridge.exists(".session-creator")); i++) {
    const clicked = await clickPrimary(`step ${i + 1}`);
    if (clicked === null || clicked === "Create session") break;
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 60_000 });
  const sessionId = await bridge.waitFor("the new terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  const session = (await invoke(bridge, "get_sessions")).find((s) => s.id === sessionId);
  const cwd = realpathSync.native(session.working_directory);
  assert(cwd === realpathSync.native(folder), `the session works in the plain folder (${cwd})`);

  // ── ⌘G: the Review Desk ────────────────────────────────────────────
  log("⌘G opens the Review Desk: the plain 'No git repository' state, no German error");
  await menuAction(bridge, "view.git-panel");
  await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`, { timeoutMs: 10_000 });
  const shown = await bridge.waitFor("the Review tab to finish loading", `
    const empty = e2e.first('.review-nav [data-empty="no-repository"]');
    const error = e2e.first(".review-nav .review-error");
    if (!empty && !error) return null;
    return { empty: empty ? e2e.norm(empty.innerText) : null, error: error ? e2e.norm(error.innerText) : null };
  `, { timeoutMs: 20_000 });
  log(`  the desk shows: ${JSON.stringify(shown)}`);
  await bridge.screenshot(join(evidenceDir, "01-review-desk.png"));
  assert(shown.error === null, `no error is shown (it showed ${JSON.stringify(shown.error)})`);
  assert(shown.empty !== null, `the desk shows the no-repository state: "${shown.empty}"`);
});
