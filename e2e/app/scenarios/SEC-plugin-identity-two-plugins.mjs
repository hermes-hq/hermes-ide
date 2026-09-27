#!/usr/bin/env node
// Scenario: SEC-plugin-identity — plugin commands are bound to the calling plugin.
//
// Two synthetic plugins are installed into the test app's data folder before
// it starts:
//
//   e2e.good   permissions: storage, network. Behaves like the GitHub plugin:
//              stores a secret, fetches and posts to a local HTTP server that
//              this scenario runs, all through the plugin API.
//   e2e.rogue  permissions: storage only. Ignores the plugin API and calls the
//              app's IPC directly (window.__TAURI_INTERNALS__.invoke), naming
//              e2e.good, trying to grant itself permissions, or enumerating
//              the other plugins and their permissions — the exact bypasses
//              this fix closes.
//
// PASS means: e2e.good works end to end (positive control: the machinery is
// live, e2e.good really holds "network"), every one of e2e.rogue's attempts
// is refused, and nothing it tried left a trace (no request reached the
// server as e2e.good, e2e.good keeps its permissions, data, files and enabled
// state — checked in the app's database itself once the app has quit).
// Before this fix the very same rogue calls succeed, so this scenario fails
// on an unfixed build.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/SEC-plugin-identity-two-plugins.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/SEC-plugin-identity-two-plugins.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "SEC-plugin-identity-two-plugins";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const GOOD = "e2e.good";
const ROGUE = "e2e.rogue";
const SECRET = `good-secret-${randomBytes(8).toString("hex")}`;

// ─── A local server standing in for api.github.com ───────────────────
// Records who reached it. The app's backend fetches on behalf of plugins,
// so a forged request would show up here with from=rogue-*.

const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    const from = url.searchParams.get("from");
    requests.push({ method: req.method, path: url.pathname, from, body });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, from, echo: body || undefined }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ─── The two plugins ─────────────────────────────────────────────────

function manifest(id, name, permissions) {
  return JSON.stringify(
    {
      id,
      name,
      version: "1.0.0",
      description: `Synthetic plugin for the ${SCENARIO} scenario`,
      author: "Hermes e2e",
      main: "dist/index.js",
      activationEvents: [{ type: "onStartup" }],
      contributes: {},
      permissions,
    },
    null,
    2,
  );
}

// Uses only the plugin API, like every published plugin does.
const goodBundle = `(() => {
  const BASE = ${JSON.stringify(BASE)};
  const SECRET = ${JSON.stringify(SECRET)};
  const report = (window.__HERMES_E2E_PLUGINS__ = window.__HERMES_E2E_PLUGINS__ || {});
  window.__hermesPlugins = window.__hermesPlugins || {};
  window.__hermesPlugins[${JSON.stringify(GOOD)}] = {
    async activate(api) {
      const r = { errors: [] };
      try {
        await api.storage.set("secret", SECRET);
        r.storedBack = await api.storage.get("secret");
      } catch (e) { r.errors.push("storage: " + e); }
      try {
        r.fetched = JSON.parse(await api.network.fetch(BASE + "/probe?from=good"));
      } catch (e) { r.errors.push("fetch: " + e); }
      try {
        r.posted = JSON.parse(await api.network.postJson(BASE + "/probe?from=good-post", JSON.stringify({ hello: "world" }), { "Content-Type": "application/json" }));
      } catch (e) { r.errors.push("postJson: " + e); }
      // Not granted: the ordinary permission check still applies to a legitimate plugin.
      try { await api.shell.exec("echo", ["x"]); r.execAllowed = true; } catch (e) { r.execDenied = String(e); }
      r.done = true;
      report.good = r;
      const failed = r.errors.length > 0;
      api.ui.showToast(failed ? "e2e.good: FAILED " + r.errors.join("; ") : "e2e.good: fetched and stored OK", { type: failed ? "error" : "success", duration: 120000 });
    },
  };
})();`;

// Bypasses the plugin API and talks to the app's IPC directly, as e2e.good.
const rogueBundle = `(() => {
  const BASE = ${JSON.stringify(BASE)};
  const GUESS = "0".repeat(64);
  const report = (window.__HERMES_E2E_PLUGINS__ = window.__HERMES_E2E_PLUGINS__ || {});
  window.__hermesPlugins = window.__hermesPlugins || {};
  const raw = (cmd, args) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.resolve({ ok: false, unreachable: true, error: "no __TAURI_INTERNALS__.invoke in this page" });
    }
    return internals.invoke(cmd, args).then(
      (v) => ({ ok: true, value: JSON.stringify(v === undefined ? null : v).slice(0, 300) }),
      (e) => ({ ok: false, error: String((e && e.message) || e).slice(0, 300) }),
    );
  };
  window.__hermesPlugins[${JSON.stringify(ROGUE)}] = {
    async activate(api) {
      const r = { attempts: {}, own: {} };
      const attempts = {
        "claim the host key": ["claim_plugin_host_key", {}],
        "mint a token for e2e.good with an empty host key": ["issue_plugin_token", { hostKey: "", pluginId: "e2e.good" }],
        "mint a token for e2e.good with a guessed host key": ["issue_plugin_token", { hostKey: GUESS, pluginId: "e2e.good" }],
        "fetch as e2e.good by naming its id": ["plugin_fetch_url", { url: BASE + "/probe?from=rogue-by-id", headers: null, pluginId: "e2e.good" }],
        "fetch as e2e.good using its id as the token": ["plugin_fetch_url", { url: BASE + "/probe?from=rogue-id-as-token", headers: null, pluginToken: "e2e.good" }],
        "fetch with a guessed token": ["plugin_fetch_url", { url: BASE + "/probe?from=rogue-guess", headers: null, pluginToken: GUESS }],
        "post as e2e.good by naming its id": ["plugin_post_json", { url: BASE + "/probe?from=rogue-post", body: "{}", headers: null, pluginId: "e2e.good" }],
        "read e2e.good's secret by naming its id": ["get_plugin_setting", { key: "secret", pluginId: "e2e.good" }],
        "read e2e.good's secret using its id as the token": ["get_plugin_setting", { key: "secret", pluginToken: "e2e.good" }],
        "read all of e2e.good's settings": ["get_plugin_settings_batch", { pluginId: "e2e.good" }],
        "overwrite e2e.good's secret": ["set_plugin_setting", { key: "secret", value: "owned", pluginId: "e2e.good" }],
        "grant itself shell.exec and network": ["save_plugin_metadata", { pluginId: "e2e.rogue", version: "1.0.0", name: "rogue", permissions: ["shell.exec", "network", "storage"] }],
        "run a shell command as e2e.good": ["plugin_exec_command", { command: "echo", args: ["pwned"], pluginId: "e2e.good" }],
        "run a shell command as itself, naming itself as the token": ["plugin_exec_command", { command: "echo", args: ["pwned"], pluginId: "e2e.rogue", pluginToken: "e2e.rogue" }],
        "disable e2e.good": ["set_plugin_enabled", { pluginId: "e2e.good", enabled: false }],
        "wipe e2e.good's data": ["cleanup_plugin_data", { pluginId: "e2e.good" }],
        "uninstall e2e.good": ["uninstall_plugin", { pluginDir: "e2e.good" }],
        "install a plugin from a URL": ["download_and_install_plugin", { url: BASE + "/rogue-helper.tgz?from=rogue-install" }],
        // Read-only, but none of a plugin's business either: enumerating
        // the other plugins, their permissions and code, and a GET to any
        // URL that would sidestep the "network" permission.
        "list the installed plugins": ["list_installed_plugins", {}],
        "list the installed plugins with a guessed host key": ["list_installed_plugins", { hostKey: GUESS }],
        "read e2e.good's granted permissions": ["get_plugin_permissions", { pluginId: "e2e.good" }],
        "read e2e.good's granted permissions with an empty host key": ["get_plugin_permissions", { pluginId: "e2e.good", hostKey: "" }],
        "read e2e.good's bundle from disk": ["read_plugin_bundle", { pluginDir: "e2e.good" }],
        "list the disabled plugins": ["get_disabled_plugin_ids", {}],
        "find the plugins folder": ["get_plugins_dir", {}],
        "fetch any URL through the registry fetch": ["fetch_plugin_registry", { url: BASE + "/probe?from=rogue-registry" }],
        "fetch any URL through the registry fetch with an empty host key": ["fetch_plugin_registry", { url: BASE + "/probe?from=rogue-registry-empty-key", hostKey: "" }],
      };
      for (const [what, [cmd, args]] of Object.entries(attempts)) {
        r.attempts[what] = Object.assign({ cmd }, await raw(cmd, args));
      }
      // Through its own, legitimate API its own permissions apply: storage
      // is its own namespace (no secret there), network is not granted.
      try { r.own.storageRead = await api.storage.get("secret"); } catch (e) { r.own.storageError = String(e); }
      try { await api.network.fetch(BASE + "/probe?from=rogue-own-api"); r.own.fetchAllowed = true; } catch (e) { r.own.fetchDenied = String(e); }
      const total = Object.keys(r.attempts).length;
      const blocked = Object.values(r.attempts).filter((a) => !a.ok).length;
      r.total = total;
      r.blocked = blocked;
      r.done = true;
      report.rogue = r;
      api.ui.showToast("e2e.rogue: " + blocked + "/" + total + " impersonation attempts refused", { type: blocked === total ? "info" : "error", duration: 120000 });
    },
  };
})();`;

function installPlugin(dataDir, id, manifestJson, bundle) {
  const dir = join(dataDir, "plugins", id);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "hermes-plugin.json"), manifestJson);
  writeFileSync(join(dir, "dist", "index.js"), bundle);
  log(`  installed ${id} into ${dir}`);
}

// ─── Onboarding (first launch), same steps as the other scenarios ────

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
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// The app's database (same file the N06 scenario checks). Read only after
// the app has quit, so nothing is mid-write.
const DB_FILE = "hermes_idea_v3.db";

function readPluginRecords(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const records = {};
    for (const row of db.prepare("SELECT id, enabled, permissions_granted FROM plugins").all()) {
      records[row.id] = { enabled: row.enabled === 1, permissions: JSON.parse(row.permissions_granted), settings: {} };
    }
    for (const row of db.prepare("SELECT plugin_id, key, value FROM plugin_storage").all()) {
      if (records[row.plugin_id]) records[row.plugin_id].settings[row.key] = row.value;
    }
    return records;
  } finally {
    db.close();
  }
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   local server: ${BASE}`);

  log("step 1: launch a fresh install with the two plugins already in place");
  app = await launchApp({
    runDir: join(evidenceDir, "run"),
    log,
    prepareDataDir: async (dataDir) => {
      installPlugin(dataDir, GOOD, manifest(GOOD, "E2E Good", ["storage", "network"]), goodBundle);
      installPlugin(dataDir, ROGUE, manifest(ROGUE, "E2E Rogue", ["storage"]), rogueBundle);
    },
  });
  const { bridge } = app;

  log("step 2: wait for both plugins to finish (they run at startup)");
  const reports = await bridge.waitFor(
    "both plugins to report",
    `const r = window.__HERMES_E2E_PLUGINS__; return r && r.good && r.good.done && r.rogue && r.rogue.done ? r : null;`,
    { timeoutMs: 30_000 },
  );
  log(`  e2e.good report: ${JSON.stringify(reports.good)}`);
  for (const [what, a] of Object.entries(reports.rogue.attempts)) {
    log(`  e2e.rogue ${a.ok ? "SUCCEEDED" : "refused "} — ${what}: ${a.ok ? a.value : a.error}`);
  }
  log(`  e2e.rogue own API: ${JSON.stringify(reports.rogue.own)}`);

  log("step 3: positive control — the well-behaved plugin works through the plugin API");
  const good = reports.good;
  assert(good.errors.length === 0, `e2e.good hit no errors (${JSON.stringify(good.errors)})`);
  assert(good.storedBack === SECRET, "e2e.good stored its secret and read it back");
  assert(good.fetched?.ok === true && good.fetched.from === "good", "e2e.good fetched from the local server");
  assert(good.posted?.ok === true && good.posted.echo === JSON.stringify({ hello: "world" }), "e2e.good posted JSON and got the echo back");
  assert(/shell\.exec/.test(good.execDenied ?? "") && !good.execAllowed, "e2e.good is still refused shell.exec (not granted) — permissions still apply");
  // e2e.good's fetch went through, so the backend really recorded "network"
  // for it: a refusal below is about identity, not a missing permission.
  // (The database is checked directly in step 9, once the app has quit.)

  log("step 4: every impersonation attempt by the rogue plugin was refused");
  const rogue = reports.rogue;
  assert(rogue.total >= 27, `the rogue plugin made ${rogue.total} attempts`);
  for (const [what, a] of Object.entries(rogue.attempts)) {
    assert(!a.unreachable, `the attempt really reached the IPC layer: ${what}`);
    assert(a.ok === false, `refused: ${what}`);
    assert(/token|host key|reserved for the app|missing required key/i.test(a.error), `refused for an identity reason: ${what} (${a.error})`);
  }
  assert(rogue.blocked === rogue.total, `${rogue.blocked}/${rogue.total} attempts refused`);
  assert(rogue.own.storageRead === null, "through its own API the rogue reads its own (empty) storage, not e2e.good's secret");
  assert(/network/.test(rogue.own.fetchDenied ?? "") && !rogue.own.fetchAllowed, "through its own API the rogue is refused network (not granted)");

  log("step 5: nothing the rogue tried left a trace");
  await sleep(500); // any forged request would have arrived by now
  const seen = requests.map((r) => `${r.method} ${r.path}?from=${r.from}`);
  log(`  requests the local server saw: ${JSON.stringify(seen)}`);
  assert(sameSet(requests.map((r) => r.from), ["good", "good-post"]), "the server saw exactly e2e.good's two requests and nothing from the rogue");
  for (const id of [GOOD, ROGUE]) {
    assert(existsSync(join(app.dataDir, "plugins", id, "hermes-plugin.json")), `${id}'s files are still on disk`);
  }

  log("step 6: the page itself cannot claim the host key, act without a token, or look around without the key either");
  const fromPage = await bridge.eval(`
    const tryIt = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args).then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: String((e && e.message) || e) }));
    return {
      claim: await tryIt("claim_plugin_host_key", {}),
      exec: await tryIt("plugin_exec_command", { command: "echo", args: ["x"], pluginToken: "" }),
      grant: await tryIt("save_plugin_metadata", { pluginId: ${JSON.stringify(ROGUE)}, version: "1", name: "r", permissions: ["shell.exec"], hostKey: "" }),
      list: await tryIt("list_installed_plugins", { hostKey: "" }),
      perms: await tryIt("get_plugin_permissions", { pluginId: ${JSON.stringify(GOOD)}, hostKey: "" }),
    };
  `);
  log(`  from the page: ${JSON.stringify(fromPage)}`);
  assert(fromPage.claim.ok === false && /already claimed/.test(fromPage.claim.error), "the host key was already claimed by the app before any plugin ran");
  assert(fromPage.exec.ok === false && /token is not valid/.test(fromPage.exec.error), "an empty token runs nothing");
  assert(fromPage.grant.ok === false && /host key/.test(fromPage.grant.error), "an empty host key grants nothing");
  assert(fromPage.list.ok === false && /host key/.test(fromPage.list.error), "an empty host key lists nothing");
  assert(fromPage.perms.ok === false && /host key/.test(fromPage.perms.error), "an empty host key reads no permissions");

  log("step 7: what a person sees — the two plugins' toasts");
  await completeOnboarding(bridge);
  const toasts = await bridge.waitFor(
    "both plugins' toasts",
    `const t = e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)); return t.some((x) => x.startsWith("e2e.good")) && t.some((x) => x.startsWith("e2e.rogue")) ? t : null;`,
    { timeoutMs: 10_000 },
  );
  log(`  toasts: ${JSON.stringify(toasts)}`);
  assert(toasts.includes("e2e.good: fetched and stored OK"), "the good plugin reports success on screen");
  assert(toasts.includes(`e2e.rogue: ${rogue.total}/${rogue.total} impersonation attempts refused`), "the rogue plugin reports every attempt refused on screen");
  await bridge.screenshot(join(evidenceDir, "01-two-plugins.png"));

  log("step 8: quit the app");
  const exit = await app.stop({ keepFiles: true }); // the data folder stays for step 9
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");

  log("step 9: the app's own database agrees — nothing the rogue tried was recorded");
  const records = readPluginRecords(join(app.dataDir, DB_FILE));
  log(`  plugin records: ${JSON.stringify(records)}`);
  assert(records[GOOD] && sameSet(records[GOOD].permissions, ["storage", "network"]), "the backend recorded e2e.good's permissions as storage + network, and did not wipe them");
  assert(records[GOOD]?.enabled === true, "e2e.good is still enabled");
  assert(records[ROGUE] && sameSet(records[ROGUE].permissions, ["storage"]), `the rogue did not grant itself anything (${JSON.stringify(records[ROGUE]?.permissions)})`);
  assert(records[GOOD]?.settings.secret === SECRET, "e2e.good's secret is intact, not overwritten by the rogue");
  assert(records[ROGUE]?.settings.secret === undefined, "the rogue never got a 'secret' of its own written");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          plugins: window.__HERMES_E2E_PLUGINS__ ?? null,
          toasts: e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)),
          dialogs: [...document.querySelectorAll('[class*="backdrop"],[class*="overlay"]')].map((e) => e.className),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("quit the app after a failure");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
  } else {
    app?.cleanup(); // the private folders kept for step 9
  }
  server.close();
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details: { requests: requests.length } });
