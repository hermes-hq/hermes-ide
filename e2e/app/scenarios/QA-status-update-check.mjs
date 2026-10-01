#!/usr/bin/env node
// QA-status-update-check — "Check for updates" always says how it went.
//
// A local server stands in for the update manifest (HERMES_UPDATE_ENDPOINT).
//
//   1. the version chip is clicked; the server answers after 2 s with an
//      older version
//      EXPECT: the chip reads "Checking…" meanwhile, then a toast "You're up
//      to date: Hermes <version>"
//   2. Help > Check for Updates… while the server drops the connection
//      EXPECT: a toast "Couldn't check for updates. Check your connection
//      and try again."
//   3. the server never answers
//      EXPECT: the same toast after at most 15 s (plus a little), and the
//      chip back to the version
//
// Was broken: nothing at all was shown unless an update was found.

import { createServer } from "node:http";
import { join } from "node:path";
import { menuAction } from "../fleet-steps.mjs";
import { runScenario } from "../n11-steps.mjs";
import { sleep, startApp } from "../qa-status-steps.mjs";

const OLD_MANIFEST = JSON.stringify({
  version: "0.0.1",
  notes: "",
  pub_date: "2020-01-01T00:00:00Z",
  platforms: Object.fromEntries(
    ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "linux-aarch64", "windows-x86_64", "windows-aarch64"].map((p) => [p, { signature: "x", url: "http://127.0.0.1:9/none" }]),
  ),
});

await runScenario("QA-status-update-check", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  let mode = "slow-old";
  const held = [];
  const server = createServer((req, res) => {
    log(`  update server: ${req.method} ${req.url} (${mode})`);
    if (mode === "drop") return req.socket.destroy();
    if (mode === "hang") return held.push(res);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(OLD_MANIFEST);
    }, 2000);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  onCleanup(() => {
    for (const r of held) r.destroy();
    server.close();
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/latest.json`;
  const { bridge } = await startApp("qa-update", evidenceDir, log, onCleanup, apps, { env: { HERMES_UPDATE_ENDPOINT: endpoint } });
  const version = (await bridge.health()).version;
  const toasts = `return e2e.all(".toast .toast-message").map((t) => e2e.norm(t.innerText));`;
  const chip = `const c = e2e.first(".status-version-chip"); return c ? { text: e2e.norm(c.innerText), state: c.dataset.state, busy: c.getAttribute("aria-busy") } : null;`;

  await bridge.click(".status-version-chip");
  const checking = await bridge.waitFor("Checking…", `const c = (() => { ${chip} })(); return c && c.text === "Checking…" ? c : null;`, { timeoutMs: 1_500 }).catch(() => null);
  log(`  the chip while checking: ${JSON.stringify(checking)}`);
  assert(checking !== null, "the version chip reads Checking… while the check runs");
  // (No screenshot here: a capture can take longer than the toast stays.)
  const upToDate = await bridge.waitFor("the up-to-date toast", `const t = (() => { ${toasts} })(); return t.find((m) => /up to date/.test(m)) ?? null;`, { timeoutMs: 15_000 }).catch(() => null);
  log(`  toast: ${upToDate}`);
  await bridge.screenshot(join(evidenceDir, "02-up-to-date.png"));
  assert(upToDate === `You're up to date: Hermes ${version}`, `the person is told Hermes ${version} is the latest ("${upToDate}")`);
  await bridge.eval(`for (const b of e2e.all(".toast-close")) e2e.click(b); return true;`);
  await sleep(500);

  mode = "drop";
  await menuAction(bridge, "help.check-update");
  const offline = await bridge.waitFor("the could-not-check toast", `const t = (() => { ${toasts} })(); return t.find((m) => /Couldn't check/.test(m)) ?? null;`, { timeoutMs: 15_000 }).catch(() => null);
  log(`  toast: ${offline}`);
  await bridge.screenshot(join(evidenceDir, "03-offline.png"));
  assert(offline === "Couldn't check for updates. Check your connection and try again.", `a dropped connection is reported ("${offline}")`);
  await bridge.eval(`for (const b of e2e.all(".toast-close")) e2e.click(b); return true;`);
  await sleep(500);

  mode = "hang";
  const started = Date.now();
  await bridge.click(".status-version-chip");
  const timedOut = await bridge.waitFor("the timeout toast", `const t = (() => { ${toasts} })(); return t.find((m) => /Couldn't check/.test(m)) ?? null;`, { timeoutMs: 25_000 }).catch(() => null);
  const took = Date.now() - started;
  const after = await bridge.eval(chip);
  log(`  toast after ${took} ms: ${timedOut}; chip: ${JSON.stringify(after)}`);
  assert(timedOut !== null && took <= 18_000, `a check that never answers gives up within 15 s (${took} ms)`);
  assert(after.text === `v${version}`, `the chip shows the version again (${after.text})`);
});
