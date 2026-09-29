#!/usr/bin/env node
// Scenario: F36 — plugin API v2 on the REAL app, with the sample plugin.
//
// Three plugins are installed into the test app's data folder before it
// starts:
//
//   example.license-gate  the sample plugin from docs/examples/plugins,
//                         copied as is (apiVersion 2): a License scan review
//                         check that raises a gate in the inbox, naming the
//                         feature track read from the session's repository
//   e2e.v1                a plugin built for the original API (no
//                         apiVersion), like every plugin published today
//   e2e.observer          apiVersion 2 with only sessions.read + inbox.raise:
//                         records the events it is given and tries what it
//                         was not granted
//
// A synthetic git repository with .hermes/features/search-index/feature.md
// is the working directory of one terminal session.
//
//   run 0  a fresh install: the pluginApiV2 flag (on by default since 2.0)
//          is switched off, the setting the hidden Flags tab writes
//   run 1  stable channel, pluginApiV2 flag switched off
//          -> e2e.v1 works and is not marked; the two v2 plugins are not
//             started and Settings > Plugins says "not loaded"
//          turn the flag on (the setting the hidden Flags tab writes)
//   run 2  relaunch against the same data
//          -> e2e.v1 still works (same API) and is marked "old API" with the
//             release that drops it
//          -> events injected for two sessions (any agent) reach the
//             observer, normalised, with status transitions
//          -> the sample's License scan is listed under it in Settings >
//             Plugins; run over a diff adding a GPL-3.0 file it fails and a
//             gate lands in the inbox, stamped plugin:example.license-gate,
//             naming the feature track read from disk; a clean diff passes
//             and settles the gate
//          -> negative controls: the observer cannot read feature tracks,
//             register a check, claim another source or resolve another
//             plugin's item; a forged token reads nothing
//          -> turning the sample off in Settings > Plugins removes its
//             check and its open inbox items
//
// Negative control of the scenario itself: HERMES_E2E_F36_BREAK=inbox
// installs the sample WITHOUT the inbox.raise permission; the run must end
// in RESULT: FAIL (the inbox assertion is real).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F36-plugin-api-v2.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F36-plugin-api-v2.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F36-plugin-api-v2";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const SAMPLE = "example.license-gate";
const V1 = "e2e.v1";
const OBSERVER = "e2e.observer";
const BREAK = process.env.HERMES_E2E_F36_BREAK || "";
const FLAG_ID = "pluginApiV2";

// ─── Synthetic repository with a feature track ───────────────────────

const scratch = mkdtempSync(join(tmpdir(), "hermes-e2e-f36-"));
const repo = join(scratch, "demo-repo");
mkdirSync(join(repo, ".hermes", "features", "search-index"), { recursive: true });
writeFileSync(
  join(repo, ".hermes", "features", "search-index", "feature.md"),
  "---\nslug: search-index\ntrack: Full\nphase: implement\ngate: none\ndone_when:\n  - npm test\n---\nIndex the docs for search.\n",
);
writeFileSync(join(repo, "README.md"), "demo\n");
const gitInit = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);

// ─── The plugins ─────────────────────────────────────────────────────

const sampleDir = join(REPO_ROOT, "docs", "examples", "plugins", "license-gate");
const sampleManifest = JSON.parse(readFileSync(join(sampleDir, "hermes-plugin.json"), "utf8"));
if (BREAK === "inbox") sampleManifest.permissions = sampleManifest.permissions.filter((p) => p !== "inbox.raise");
const sampleBundle = readFileSync(join(sampleDir, sampleManifest.main), "utf8");

const manifest = (id, name, permissions, apiVersion) =>
  JSON.stringify({
    id,
    name,
    version: "1.0.0",
    description: `Synthetic plugin for the ${SCENARIO} scenario`,
    author: "Hermes e2e",
    main: "dist/index.js",
    ...(apiVersion ? { apiVersion } : {}),
    activationEvents: [{ type: "onStartup" }],
    contributes: {},
    permissions,
  });

// Built for the original API, like every plugin published before v2.
const v1Bundle = `(() => {
  const report = (window.__HERMES_E2E_PLUGINS__ = window.__HERMES_E2E_PLUGINS__ || {});
  window.__hermesPlugins = window.__hermesPlugins || {};
  window.__hermesPlugins[${JSON.stringify(V1)}] = {
    async activate(api) {
      const r = { apiVersion: api.apiVersion, hasInbox: "inbox" in api, hasFeatures: "features" in api, hasReview: "review" in api, onEvent: typeof api.agents.onEvent, watchTranscript: typeof api.agents.watchTranscript };
      try { r.sessions = (await api.sessions.list()).length; } catch (e) { r.sessionsError = String(e); }
      r.done = true;
      report.v1 = r;
    },
  };
})();`;

// apiVersion 2, but only sessions.read + inbox.raise.
const observerBundle = `(() => {
  const report = (window.__HERMES_E2E_PLUGINS__ = window.__HERMES_E2E_PLUGINS__ || {});
  window.__hermesPlugins = window.__hermesPlugins || {};
  window.__hermesPlugins[${JSON.stringify(OBSERVER)}] = {
    async activate(api) {
      const r = { apiVersion: api.apiVersion, events: [], changes: [], mutation: null };
      api.agents.onEvent((e) => {
        r.events.push(JSON.parse(JSON.stringify(e)));
        const before = e.event.at;
        try { e.event.at = 0; } catch (err) { /* frozen: refused (strict code throws) */ }
        r.mutation = e.event.at === before && Object.isFrozen(e.event) ? "refused" : "allowed";
      });
      api.agents.onStatusChange((c) => r.changes.push([c.sessionId, c.previous.kind, c.status.kind]));
      r.getStatus = (sessionId) => api.agents.getStatus(sessionId);
      try { await api.features.list("anything"); r.featuresAllowed = true; } catch (e) { r.featuresDenied = String(e); }
      try { api.review.registerCheck({ id: "sneaky", title: "Sneaky", run: () => ({ outcome: "pass" }) }); r.reviewAllowed = true; } catch (e) { r.reviewDenied = String(e); }
      // Claims another source; the host must stamp its own.
      r.ownItem = api.inbox.raise({ kind: "ready", detail: "observer item", source: "status" });
      r.tryResolve = (ids) => ids.map((id) => [id, api.inbox.resolve(id)]);
      r.listOwn = () => api.inbox.list().map((i) => i.id);
      // Skips the API: calls the feature-track command itself.
      const raw = (args) => window.__TAURI_INTERNALS__.invoke("plugin_read_feature_tracks", args).then(
        (v) => ({ ok: true, value: v }),
        (e) => ({ ok: false, error: String((e && e.message) || e) }),
      );
      r.rawNoToken = await raw({ directory: ${JSON.stringify(repo)} });
      r.rawForged = await raw({ directory: ${JSON.stringify(repo)}, pluginToken: ${JSON.stringify(SAMPLE)} });
      r.done = true;
      report.observer = r;
    },
  };
})();`;

function installPlugin(dataDir, id, manifestJson, bundle, main = "dist/index.js") {
  const dir = join(dataDir, "plugins", id);
  mkdirSync(join(dir, main, ".."), { recursive: true });
  writeFileSync(join(dir, "hermes-plugin.json"), manifestJson);
  writeFileSync(join(dir, main), bundle);
  log(`  installed ${id}`);
}

// ─── Launching against the same data twice ───────────────────────────

const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f36-home-"));

function launch(run, prepareDataDir) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: run === 0, prepareDataDir })
    : launchApp({ runDir, log, home: "private", homeDir, prepareDataDir });
}

// ─── UI helpers ──────────────────────────────────────────────────────

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
    return { analytics: analytics.checked, policy: policy.checked };
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

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
}

/** Settings > Plugins, installed tab; returns once the plugin rows are there. */
async function openPluginsSettings(bridge) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.clickWhenReady(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Plugins");
    return e2e.click(e2e.must(tab, "Plugins tab"));
  `);
  await bridge.waitFor("the installed plugins", `
    return [${JSON.stringify(SAMPLE)}, ${JSON.stringify(V1)}, ${JSON.stringify(OBSERVER)}]
      .every((id) => !!document.querySelector('[data-plugin-row="' + id + '"] .pm-row'));
  `, { timeoutMs: 20_000 });
}

async function closeSettings(bridge) {
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

/** Badges on a plugin's row and, once expanded, its detail text. */
function pluginRow(bridge, id) {
  return bridge.eval(`
    const row = document.querySelector('[data-plugin-row="${id}"]');
    if (!row) return null;
    return {
      badges: [...row.querySelectorAll(".pm-row-badges .pm-badge")].map((b) => e2e.norm(b.textContent)),
      notes: [...row.querySelectorAll('[role="note"]')].map((n) => e2e.norm(n.innerText)),
      checks: [...row.querySelectorAll("[data-check-key]")].map((c) => c.getAttribute("data-check-key") + "|" + e2e.norm(c.querySelector(".pm-detail-perm")?.textContent) + "|" + e2e.norm(c.querySelector(".pm-perm-desc")?.textContent)),
      detail: e2e.norm(row.querySelector(".pm-detail")?.innerText),
      expanded: !!row.querySelector(".pm-detail"),
    };
  `);
}

async function expand(bridge, id) {
  if ((await pluginRow(bridge, id))?.expanded) return;
  await bridge.click(`[data-plugin-row="${id}"] .pm-row-info`);
  await bridge.waitFor(`${id}'s details`, `return !!document.querySelector('[data-plugin-row="${id}"] .pm-detail');`);
}

const PATCH_GPL = [
  "diff --git a/vendor/copyleft.js b/vendor/copyleft.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/vendor/copyleft.js",
  "@@ -0,0 +1,2 @@",
  "+// SPDX-License-Identifier: GPL-3.0-only",
  "+module.exports = () => 42;",
  "",
].join("\n");
const PATCH_CLEAN = [
  "diff --git a/src/index.js b/src/index.js",
  "--- a/src/index.js",
  "+++ b/src/index.js",
  "@@ -1 +1,2 @@",
  " // SPDX-License-Identifier: MIT",
  "+export const answer = 42;",
  "",
].join("\n");

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${BREAK ? `   BREAK=${BREAK} (negative control, must FAIL)` : ""}`);

  // ── run 0: switch the flag off (on by default since 2.0) ────────────
  log("step 0: a fresh install: switch pluginApiV2 off (the override the hidden Flags tab writes) and quit");
  app = await launch(0);
  await app.bridge.eval(`
    // launchHelper (on by default since 2.0) would add the terminal's own
    // status guesses to the events step 7 hands the observer; it stays off.
    await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ ${FLAG_ID}: false, launchHelper: false }) });
    return true;
  `);
  let exit0 = await app.stop();
  assert(!exit0.forced && exit0.code === 0, "the app quit cleanly");

  // ── run 1: flag off ────────────────────────────────────────────────
  log("step 1: launch again (stable channel, pluginApiV2 switched off) with the three plugins in place");
  app = await launch(1, async (dataDir) => {
    installPlugin(dataDir, SAMPLE, JSON.stringify(sampleManifest, null, 2), sampleBundle, sampleManifest.main);
    installPlugin(dataDir, V1, manifest(V1, "E2E v1 plugin", ["sessions.read"]), v1Bundle);
    installPlugin(dataDir, OBSERVER, manifest(OBSERVER, "E2E observer", ["sessions.read", "inbox.raise"], 2), observerBundle);
  });
  let { bridge } = app;

  const v1Off = await bridge.waitFor("the v1 plugin to report", `const r = window.__HERMES_E2E_PLUGINS__?.v1; return r?.done ? r : null;`, { timeoutMs: 30_000 });
  log(`  v1 report: ${JSON.stringify(v1Off)}`);
  assert(v1Off.apiVersion === 1 && !v1Off.hasInbox && !v1Off.hasFeatures && !v1Off.hasReview && v1Off.onEvent === "undefined", "the v1 plugin runs on API v1, without v2 namespaces");
  assert(typeof v1Off.sessions === "number", "its v1 calls work (sessions.list)");
  await sleep(1500);
  const offState = await bridge.eval(`return { observer: window.__HERMES_E2E_PLUGINS__?.observer ?? null, checks: window.__HERMES_E2E__.reviewChecks(), inbox: window.__HERMES_E2E__.inboxItems() };`);
  assert(offState.observer === null, "the v2 observer was not started with the flag off");
  assert(offState.checks.length === 0, "the v2 sample registered no review check with the flag off");
  assert(offState.inbox.length === 0, "the inbox is empty");

  await completeOnboarding(bridge);
  log("step 2: Settings > Plugins with the flag off");
  await openPluginsSettings(bridge);
  const v1RowOff = await pluginRow(bridge, V1);
  const sampleRowOff = await pluginRow(bridge, SAMPLE);
  log(`  rows: v1 ${JSON.stringify(v1RowOff.badges)}, sample ${JSON.stringify(sampleRowOff.badges)}`);
  assert(!v1RowOff.badges.includes("old API"), "the v1 plugin is not marked old while v2 is off");
  assert(sampleRowOff.badges.includes("not loaded"), "the v2 sample says it is not loaded");
  await expand(bridge, SAMPLE);
  const sampleDetailOff = await pluginRow(bridge, SAMPLE);
  assert(sampleDetailOff.notes.includes("Needs plugin API v2, which this version of Hermes does not turn on yet."), "and says why");
  await bridge.screenshot(join(evidenceDir, "01-flag-off-plugins.png"));
  await closeSettings(bridge);

  log("step 3: turn pluginApiV2 on (the override the hidden Flags tab writes), no plugin update check, and quit");
  await bridge.eval(`
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
    overrides[${JSON.stringify(FLAG_ID)}] = true;
    await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "feature_flag_overrides", value: JSON.stringify(overrides) });
    // No plugin update check at startup: it fetches the public registry and,
    // after installing a default plugin, reloads every plugin, which would
    // reset the plugins under test at a random moment of run 2.
    await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "plugin_update_check", value: "never" });
    return true;
  `);
  let exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");

  // ── run 2: flag on ─────────────────────────────────────────────────
  log("step 4: relaunch against the same data with pluginApiV2 on");
  app = await launch(2);
  bridge = app.bridge;
  await waitForReturningLaunch(bridge);
  const reports = await bridge.waitFor("the v1 plugin and the observer to report", `
    const r = window.__HERMES_E2E_PLUGINS__;
    return r?.v1?.done && r?.observer?.done ? { v1: r.v1, observer: { ...r.observer, getStatus: undefined, tryResolve: undefined, listOwn: undefined } } : null;
  `, { timeoutMs: 30_000 });
  log(`  v1: ${JSON.stringify(reports.v1)}`);
  log(`  observer: ${JSON.stringify(reports.observer)}`);
  assert(reports.v1.apiVersion === 1 && !reports.v1.hasInbox && typeof reports.v1.sessions === "number", "the v1 plugin keeps working on the same v1 API");
  const obs = reports.observer;
  assert(obs.apiVersion === 2, "the observer runs on API v2");
  assert(/features\.read/.test(obs.featuresDenied ?? "") && !obs.featuresAllowed, "without features.read it cannot read feature tracks");
  assert(/review\.checks/.test(obs.reviewDenied ?? "") && !obs.reviewAllowed, "without review.checks it cannot register a check");
  assert(obs.ownItem.source === `plugin:${OBSERVER}` && obs.ownItem.kind === "ready", `its inbox item is stamped plugin:${OBSERVER}, whatever source it claimed`);
  assert(!obs.rawNoToken.ok && /token|missing required key/i.test(obs.rawNoToken.error), `the feature-track command refuses a call without a token (${obs.rawNoToken.error})`);
  assert(!obs.rawForged.ok && /token/i.test(obs.rawForged.error), `and a forged token (${obs.rawForged.error})`);

  const checks = await bridge.eval(`return window.__HERMES_E2E__.reviewChecks();`);
  log(`  review checks: ${JSON.stringify(checks)}`);
  assert(checks.length === 1 && checks[0].key === `${SAMPLE}/license-scan` && checks[0].title === "License scan" && checks[0].owner === `plugin:${SAMPLE}`, "the sample registered its License scan (and only it)");

  log("step 5: Settings > Plugins with the flag on");
  await openPluginsSettings(bridge);
  const v1RowOn = await pluginRow(bridge, V1);
  assert(v1RowOn.badges.includes("old API"), `the v1 plugin is marked "old API" (${JSON.stringify(v1RowOn.badges)})`);
  await expand(bridge, V1);
  const v1DetailOn = await pluginRow(bridge, V1);
  assert(
    v1DetailOn.notes.includes("Built for the old plugin API (v1). It still works, but Hermes 2.2 stops loading it: ask the author for an update."),
    "its details say it still works and which release stops loading it",
  );
  const sampleRowOn = await pluginRow(bridge, SAMPLE);
  assert(!sampleRowOn.badges.includes("old API") && !sampleRowOn.badges.includes("not loaded"), "the v2 sample is not marked");
  await expand(bridge, SAMPLE);
  const sampleDetailOn = await pluginRow(bridge, SAMPLE);
  log(`  sample details: ${sampleDetailOn.detail}`);
  assert(
    sampleDetailOn.checks.includes(`${SAMPLE}/license-scan|License scan|Flags copyleft licenses (GPL, AGPL, LGPL, SSPL, EUPL) in added lines`),
    `the sample's details list its review check (${JSON.stringify(sampleDetailOn.checks)})`,
  );
  assert(/Plugin API: v2/.test(sampleDetailOn.detail), "and that it uses plugin API v2");
  await bridge.screenshot(join(evidenceDir, "02-flag-on-plugins.png"));
  await closeSettings(bridge);

  log("step 6: a terminal session working in the demo repository");
  const session = await bridge.eval(`
    const s = await window.__TAURI_INTERNALS__.invoke("create_session", {
      sessionId: null, label: "F36 demo repo", workingDirectory: ${JSON.stringify(repo)}, color: null,
      workspacePaths: null, aiProvider: null, projectIds: null,
    });
    return { id: s.id, cwd: s.working_directory };
  `);
  log(`  session ${session.id} in ${session.cwd}`);
  await bridge.waitFor("the session to appear in the session list", `
    return e2e.all(".session-item").some((el) => el.innerText.includes("F36 demo repo"));
  `, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    return e2e.click(e2e.must(e2e.all(".session-item").find((el) => el.innerText.includes("F36 demo repo")), "the session in the list"));
  `);
  // What matters here is that the app knows the session and its folder (the
  // status bar shows the folder's name), not its terminal.
  await bridge.waitFor("the session to be open, in the demo repository", `
    return e2e.all("*").some((el) => el.children.length === 0 && e2e.norm(el.innerText) === "demo-repo");
  `, { timeoutMs: 20_000 });
  await bridge.screenshot(join(evidenceDir, "03-session-in-demo-repo.png"));

  log("step 7: events of two sessions, as any agent would report them, reach the observer normalised");
  const OTHER = "f36-other-agent";
  const injected = [
    [session.id, { type: "turn_start", at: 1790000000000, n: 1, source: "e2e" }],
    [session.id, { type: "status", at: 1790000000100, source: "e2e", status: { kind: "working", confidence: "exact", detail: "" } }],
    [OTHER, { type: "status", at: 1790000000200, source: "e2e", status: { kind: "needs_approval", confidence: "signal", detail: "Bash: rm -rf build" } }],
    [session.id, { type: "turn_end", at: 1790000000300, n: 1, source: "e2e" }],
    [session.id, { type: "status", at: 1790000000400, source: "e2e", status: { kind: "done_unread", confidence: "exact", detail: "" } }],
  ];
  const accepted = await bridge.eval(`
    const H = window.__HERMES_E2E__;
    return ${JSON.stringify(injected)}.map(([id, ev]) => H.injectSessionEvent(id, ev));
  `);
  assert(accepted.every(Boolean), "the injector accepted the five events");
  const seen = await bridge.waitFor("the observer to have all five events", `
    const r = window.__HERMES_E2E_PLUGINS__.observer;
    return r.events.length >= 5 ? { events: r.events, changes: r.changes, mutation: r.mutation } : null;
  `);
  log(`  observer saw: ${JSON.stringify(seen.events)}`);
  assert(isDeepStrictEqual(seen.events, injected.map(([sessionId, event]) => ({ sessionId, event }))), "it got exactly the events, in order, in the one shape for every agent");
  assert(
    isDeepStrictEqual(seen.changes, [
        [session.id, "idle", "working"],
        [OTHER, "idle", "needs_approval"],
        [session.id, "working", "done_unread"],
      ]),
    `and the status transitions (${JSON.stringify(seen.changes)})`,
  );
  assert(seen.mutation === "refused", "the event it was handed is frozen");
  const storeAt = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(session.id)}).events[0].at;`);
  assert(storeAt === 1790000000000, "and the app's own copy is untouched");
  const status = await bridge.eval(`return window.__HERMES_E2E_PLUGINS__.observer.getStatus(${JSON.stringify(OTHER)});`);
  assert(status.status.kind === "needs_approval" && status.status.detail === "Bash: rm -rf build" && status.version === 1, "getStatus reads the same state the app shows");

  log("step 8: the Review Desk's run of the checks over a diff adding a GPL-3.0 file");
  const [failRun] = await bridge.eval(`return await window.__HERMES_E2E__.runReviewChecks(${JSON.stringify(session.id)}, 1, ${JSON.stringify(PATCH_GPL)});`);
  log(`  run: ${JSON.stringify(failRun)}`);
  assert(failRun.key === `${SAMPLE}/license-scan` && failRun.outcome === "fail", `the License scan fails (${failRun.outcome}: ${failRun.summary})`);
  assert(failRun.summary === "1 copyleft license found (1 turn since the last scan)", "its summary counts the turn it saw end (agents.onEvent)");
  assert(
    isDeepStrictEqual(failRun.findings, [{ file: "vendor/copyleft.js", line: 1, message: "GPL-3.0-only: needs a license review before this lands" }]),
    "the finding points at the file and line",
  );
  const inboxAfterFail = await bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);
  log(`  inbox: ${JSON.stringify(inboxAfterFail)}`);
  const gate = inboxAfterFail.find((i) => i.source === `plugin:${SAMPLE}`);
  assert(!!gate, "a gate from the sample is in the inbox");
  assert(gate.kind === "gate" && gate.sessionId === session.id, "it is a gate for that session");
  assert(gate.detail === "License review: GPL-3.0-only in vendor/copyleft.js (feature search-index, implement)", "it names the license, the file and the feature track read from the repository");

  log("step 9: one plugin cannot resolve another's item");
  const resolveAttempts = await bridge.eval(`
    const ids = window.__HERMES_E2E__.inboxItems().map((i) => i.id);
    return window.__HERMES_E2E_PLUGINS__.observer.tryResolve(ids);
  `);
  log(`  observer's attempts: ${JSON.stringify(resolveAttempts)}`);
  assert(resolveAttempts.find(([id]) => id === gate.id)?.[1] === false, "the observer cannot resolve the sample's gate");
  assert(resolveAttempts.find(([id]) => id === obs.ownItem.id)?.[1] === true, "but can resolve its own item");
  const stillThere = await bridge.eval(`return window.__HERMES_E2E__.inboxItems().map((i) => i.id);`);
  assert(stillThere.includes(gate.id) && !stillThere.includes(obs.ownItem.id), "the gate is still open");

  log("step 10: a clean diff passes and settles the gate");
  const [passRun] = await bridge.eval(`return await window.__HERMES_E2E__.runReviewChecks(${JSON.stringify(session.id)}, 2, ${JSON.stringify(PATCH_CLEAN)});`);
  assert(passRun.outcome === "pass" && passRun.summary === "No copyleft license in 1 changed file", `the scan passes (${passRun.summary})`);
  const afterPass = await bridge.eval(`return window.__HERMES_E2E__.inboxItems().filter((i) => i.source === ${JSON.stringify("plugin:" + SAMPLE)});`);
  assert(afterPass.length === 0, "the sample's gate is resolved");

  log("step 11: turning the sample off removes its check and its open items");
  await bridge.eval(`return await window.__HERMES_E2E__.runReviewChecks(${JSON.stringify(session.id)}, 3, ${JSON.stringify(PATCH_GPL)});`);
  assert((await bridge.eval(`return window.__HERMES_E2E__.inboxItems().filter((i) => i.source === ${JSON.stringify("plugin:" + SAMPLE)}).length;`)) === 1, "a new gate is open");
  await openPluginsSettings(bridge);
  await bridge.clickWhenReady(`
    const b = e2e.must(e2e.first('[data-plugin-row="${SAMPLE}"] .pm-row-action button'), "the sample's Disable button");
    if (e2e.norm(b.textContent) !== "Disable") throw new Error("not clickable yet: the button says " + b.textContent);
    return e2e.click(b);
  `);
  const gone = await bridge.waitFor("the sample's check and items to go", `
    const H = window.__HERMES_E2E__;
    const checks = H.reviewChecks().length;
    const items = H.inboxItems().filter((i) => i.source === ${JSON.stringify("plugin:" + SAMPLE)}).length;
    return checks === 0 && items === 0 ? { checks, items } : null;
  `);
  assert(gone.checks === 0 && gone.items === 0, "no check and no open item of the sample remain");
  await bridge.screenshot(join(evidenceDir, "04-sample-disabled.png"));
  await closeSettings(bridge);

  exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          plugins: JSON.parse(JSON.stringify(window.__HERMES_E2E_PLUGINS__ ?? null)),
          inbox: window.__HERMES_E2E__?.inboxItems?.() ?? null,
          checks: window.__HERMES_E2E__?.reviewChecks?.() ?? null,
          toasts: e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
  // Best effort: on Windows the session's shell can hold the demo repository
  // for a moment after the app quits (EBUSY). Leftover temp files are not a
  // failure of what this scenario proves.
  for (const dir of [scratch, homeDir]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (err) {
      log(`  (left temp folder behind: ${err.code ?? err.message})`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details: { break: BREAK || undefined } });
