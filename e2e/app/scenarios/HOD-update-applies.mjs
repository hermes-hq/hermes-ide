#!/usr/bin/env node
// HOD-update-applies: a newer, signed catalog is applied at runtime; anything
// unsigned, badly signed, tampered with or older is refused; the project's
// files never change.
//
// A local mirror on 127.0.0.1 serves catalogs laid out like hodios-dist
// (manifest.json, manifest.json.minisig, o/<aa>/<sha256>). The test build
// trusts one throwaway minisign key (HERMES_E2E_LIBRARY_PUBKEY, test builds
// only); the newer catalog is the bundled one plus one new entry, as the
// next sequence number.
//
//   1. signed with another key            -> refused ("key"), nothing changes
//   1b. the trusted key, other bytes      -> refused ("signature")
//   2. no signature                       -> "unsigned": waiting for a signed
//                                            release, no error recorded, a quiet
//                                            note in the update panel
//   3. signed, but a body was altered     -> refused ("hash"), the entry is not there
//   4. signed and intact, "Check now" in the Library's update panel
//                                         -> applied in one go: the new entry is
//                                            searchable, the badge shows the new
//                                            catalog and the "updated" dot
//   5. the older catalog, signed          -> refused ("older"), the newer stays
//   6. Roll back                          -> the bundled catalog again
// Throughout, the project folder is byte-identical: updates change library
// content only.
//
// Negative control: HERMES_E2E_HOD_NEGATIVE=wrong-key makes step 4 serve the
// catalog signed with the other key; the "applied" checks must then fail.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { catalogServer, invoke, libraryState, minisignKey, mirrorFiles, newerCatalog, openEntry, openLibrary, readBundledCatalog, search } from "../library-steps.mjs";

const NAME = "HOD-update-applies";
const NEGATIVE = process.env.HERMES_E2E_HOD_NEGATIVE === "wrong-key";
const PROBE_ID = "check-release-notes-for-breaking-changes";
const PROBE_TITLE = "Check release notes for breaking changes";
const PROBE_TEXT = "Read the release notes of {{dependency}} between the version we use and the latest, and list every breaking change that touches our code.";

const key = minisignKey();
const otherKey = minisignKey();
const base = readBundledCatalog();
const template = base.rows.find((r) => r.kind === "prompt" && r.dom === "software-engineering");
const newer = newerCatalog(base, {
  seq: base.manifest.seq + 1,
  extra: [
    {
      row: { ...template, id: PROBE_ID, v: "1.0.0", title: PROBE_TITLE, desc: "Lists the breaking changes between two versions of a dependency.", tags: ["release-notes", "upgrade", "breaking-changes"], aliases: [], stack: [], q: 9, u: 0 },
      body: {
        schema: 1,
        fm: { schema: 1, id: PROBE_ID, kind: "prompt", title: PROBE_TITLE, description: "Lists the breaking changes between two versions of a dependency.", version: "1.0.0", args: [{ name: "dependency", type: "string", required: true, description: "The package to check" }] },
        body: PROBE_TEXT,
        steps: [],
      },
    },
  ],
});
const probeRef = newer.rows.find((r) => r.id === PROBE_ID).body;

const signedNewer = mirrorFiles(newer, key.sign(newer.manifestBytes));
const otherSigned = mirrorFiles(newer, otherKey.sign(newer.manifestBytes));
// The trusted key's signature of the bundled manifest, served with the newer one.
const badSignature = mirrorFiles(newer, key.sign(base.manifestBytes));
const unsigned = mirrorFiles(newer, null);
const tampered = (() => {
  const files = mirrorFiles(newer, key.sign(newer.manifestBytes));
  const rel = `o/${probeRef.slice(7, 9)}/${probeRef.slice(7)}`;
  files.set(rel, Buffer.from(files.get(rel).toString("utf8").replace("breaking change", "harmless change"), "utf8"));
  return files;
})();
const older = mirrorFiles({ manifestBytes: base.manifestBytes, objects: base.objects }, key.sign(base.manifestBytes));

const mirror = await catalogServer();

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

const check_ = (bridge, apply = true) => invoke(bridge, "library_check_update", { apply });

try {
  await runLauncherQa(
    NAME,
    async ({ bridge, fx, log, check, assert, evidenceDir }) => {
      const project = snapshot(fx.repo);
      log(`  newer catalog: seq ${base.manifest.seq + 1}, ${newer.rows.length} rows, new entry ${PROBE_ID}`);
      await openLibrary(bridge);
      const s0 = await invoke(bridge, "library_status");
      log(`  start: ${s0.catalog.catalog} seq ${s0.catalog.seq} (${s0.catalog.source}), trusted keys ${s0.trustedKeys}`);
      assert(s0.catalog.seq === base.manifest.seq && s0.trustedKeys >= 1, "the bundled catalog, and the test key trusted");

      mirror.serve(otherSigned);
      let o = await check_(bridge);
      log(`  1. other key: ${JSON.stringify(o)}`);
      check(o.outcome === "refused" && o.code === "key", "a catalog signed with an unknown key is refused");
      check(/does not trust/.test(o.reason ?? ""), "and the reason names the untrusted key");
      mirror.serve(badSignature);
      o = await check_(bridge);
      log(`  1b. bad signature: ${JSON.stringify(o)}`);
      check(o.outcome === "refused" && o.code === "signature", "a signature over other bytes is refused");
      mirror.serve(unsigned);
      o = await check_(bridge);
      log(`  2. unsigned: ${JSON.stringify(o)}`);
      check(o.outcome === "refused" && o.code === "unsigned", "an unsigned catalog is not applied");
      const sw = await invoke(bridge, "library_status");
      check(!sw.lastError, `waiting for a signed release is not recorded as an error (lastError ${JSON.stringify(sw.lastError)})`);
      await bridge.click(".lib-badge-btn");
      const note = await bridge
        .waitFor("the waiting note", `return e2e.first('[data-testid="library-update-waiting"]')?.textContent || false;`, { timeoutMs: 5_000 })
        .catch(() => null);
      log(`  2. panel note: ${JSON.stringify(note)}`);
      const blocked = await bridge.eval(`return !!e2e.first(".lib-blocked");`);
      check(!!note && /signed library release/.test(note) && !blocked, "the panel says updates wait for a signed release, without an error");
      await bridge.click(".lib-badge-btn").catch(() => null);
      await sleep(300);
      mirror.serve(tampered);
      o = await check_(bridge);
      log(`  3. tampered body: ${JSON.stringify(o)}`);
      check(o.outcome === "refused" && o.code === "hash", "a catalog with an altered body is refused");
      let s = await invoke(bridge, "library_status");
      check(s.catalog.seq === base.manifest.seq, "after three refusals the library is unchanged");
      const none = await invoke(bridge, "library_search", { request: { query: PROBE_TITLE, limit: 5 }, context: null });
      check(!none.hits.some((h) => h.id === PROBE_ID), "and the tampered entry is not there");

      // 4. The good one, from the update panel.
      mirror.serve(NEGATIVE ? otherSigned : signedNewer);
      await bridge.click(".lib-badge-btn");
      await bridge.waitFor("the update panel", `return !!e2e.first('[data-testid="library-update-panel"] .lib-check-now');`);
      await bridge.screenshot(join(evidenceDir, "01-update-panel.png"));
      const hitsBefore = mirror.hits.length;
      await bridge.click(".lib-check-now");
      await bridge
        .waitFor("the update to apply", `const s = await window.__TAURI_INTERNALS__.invoke("library_status"); return s.catalog && s.catalog.seq === ${base.manifest.seq + 1} ? s : false;`, { timeoutMs: 30_000 })
        .catch(() => null);
      s = await invoke(bridge, "library_status");
      const fetched = mirror.hits.slice(hitsBefore);
      log(`  4. status: ${s.catalog.catalog} seq ${s.catalog.seq} (${s.catalog.source}), rows ${s.catalog.rows}; fetched ${fetched.length} files: ${fetched.filter((h) => !h.startsWith("o/")).join(", ")} + ${fetched.filter((h) => h.startsWith("o/")).length} objects`);
      check(s.catalog.seq === base.manifest.seq + 1 && s.catalog.source === "update", "the signed, intact catalog is applied");
      check(s.catalog.rows === base.rows.length + 1, `with the new entry (${s.catalog.rows} rows)`);
      check(fetched.filter((h) => h.startsWith("o/")).length <= 4, "downloading only what it did not have (list, shard, one body)");
      await bridge.click(".lib-badge-btn").catch(() => null);
      await sleep(400);
      const fresh = await bridge.eval(`return e2e.first(".lib-badge-btn")?.getAttribute("data-fresh") === "true";`);
      check(fresh, "the badge shows the updated dot");
      const rows = await search(bridge, "release notes breaking changes").catch(() => []);
      check(rows.includes(PROBE_ID), "the new entry is searchable");
      if (rows.includes(PROBE_ID)) {
        await openEntry(bridge, PROBE_ID);
        const st = await libraryState(bridge);
        check(st.detailTitle === PROBE_TITLE, "and opens with its text");
      }
      await bridge.screenshot(join(evidenceDir, "02-after-update.png"));

      // 5. Older: refused.
      mirror.serve(older);
      o = await check_(bridge);
      log(`  5. older: ${JSON.stringify(o)}`);
      check(o.outcome === "refused" && o.code === "older", "an older catalog is refused");
      s = await invoke(bridge, "library_status");
      check(s.catalog.seq === base.manifest.seq + 1, "and the newer one stays");

      // 6. Roll back.
      const back = await invoke(bridge, "library_rollback").catch((e) => ({ error: String(e) }));
      s = await invoke(bridge, "library_status");
      log(`  6. rollback: ${JSON.stringify(back).slice(0, 200)} -> seq ${s.catalog.seq}`);
      check(s.catalog.seq === base.manifest.seq, "Roll back returns to the bundled catalog");
      const gone = await invoke(bridge, "library_search", { request: { query: PROBE_TITLE, limit: 5 }, context: null });
      check(!gone.hits.some((h) => h.id === PROBE_ID), "without the new entry");

      check(snapshot(fx.repo) === project, "the project's files are byte-identical throughout");
    },
    {
      tag: "hod-update",
      env: { HERMES_E2E_LIBRARY_URL: mirror.url, HERMES_E2E_LIBRARY_PUBKEY: key.publicKey, HERMES_LIBRARY_FIRST_CHECK_SECS: "100000" },
    },
  );
} finally {
  await mirror.close();
}
