#!/usr/bin/env node
// HOD-offline-first-open: the prompt library is there on a fresh install
// with no network. The catalog mirror points at a closed port on
// 127.0.0.1 (nothing listens), so the update check that runs a second after
// launch fails the way it does offline.
//
//   run 1  fresh install, welcome finished. The Library opens from the
//          activity bar; its first open imports the catalog bundled with the
//          build: every row the lock pins is there, every tier of it (each
//          row stored and searchable under its own tier), from the bundle,
//          with every body offline. The home screen shows a
//          few short shelves, never the whole catalog. A search finds
//          entries; one opens and its text renders. The failed update check
//          is recorded quietly and changes nothing.
//   run 2  relaunch, still offline: the library is ready at once from its
//          own database (no second import) and still searchable.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appBinaryPath } from "../harness.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import {
  invoke,
  libraryState,
  minisignKey,
  openEntry,
  openLibrary,
  search,
  waitPreview,
} from "../library-steps.mjs";

const NAME = "HOD-offline-first-open";
const staged = join(dirname(appBinaryPath()), "library");
const lock = JSON.parse(readFileSync(join(staged, "catalog-v1.json"), "utf8"));
const OFFLINE = {
  HERMES_E2E_LIBRARY_URL: "http://127.0.0.1:9/catalog/v1",
  HERMES_E2E_LIBRARY_PUBKEY: minisignKey().publicKey,
  HERMES_LIBRARY_FIRST_CHECK_SECS: "1",
};

await runLauncherQa(
  NAME,
  async ({ bridge, log, check, assert, evidenceDir, relaunch, current }) => {
    log(
      `bundled lock: catalog ${lock.catalog} seq ${lock.seq}, ${lock.rows} rows`,
    );
    const t0 = Date.now();
    await openLibrary(bridge);
    log(
      `  the Library opened and was ready in ${Date.now() - t0} ms (first open, import included)`,
    );
    const status = await invoke(bridge, "library_status");
    log(
      `  status: ${JSON.stringify({ catalog: status.catalog, importMs: status.importMs, offlineBodies: status.offlineBodies, lastError: status.lastError })}`,
    );
    assert(
      status.ready && status.catalog,
      "the library is ready on a fresh install",
    );
    check(
      status.catalog.rows === lock.rows,
      `every bundled row is there (${status.catalog.rows} of ${lock.rows})`,
    );
    check(
      status.catalog.source === "bundled" &&
        status.catalog.catalog === lock.catalog &&
        status.catalog.seq === lock.seq,
      "from the bundled catalog the lock pins",
    );
    check(
      status.offlineBodies >= lock.rows,
      `every body is stored for offline use (${status.offlineBodies})`,
    );
    // Every tier is imported and searchable: page through tier:<name>.
    for (const [tier, expected] of Object.entries(lock.tiers ?? {})) {
      const found = await bridge.eval(`
        const ids = new Set();
        let cursor = null;
        do {
          const page = await window.__TAURI_INTERNALS__.invoke("library_search", {
            request: { query: ${JSON.stringify(`tier:${tier}`)}, limit: 50, cursor, personalise: false, includeHidden: true },
            context: null,
          });
          for (const h of page.hits) ids.add(h.id);
          cursor = page.nextCursor;
        } while (cursor);
        return ids.size;
      `);
      check(found === expected, `the ${tier} tier is all there (${found} of ${expected})`);
    }
    check(
      Object.keys(lock.tiers ?? {}).length > 0,
      `the bundle lists its tiers (${JSON.stringify(lock.tiers)})`,
    );
    // The import is linear in rows. CI with 1,570 rows (debug build): 356-473
    // ms on Linux, 506-817 on macOS, 488-1347 on Windows, so at most 0.86 ms
    // a row; the budget is 1 ms a row (2,570 ms at 2,570 rows).
    const importBudget = lock.rows;
    check(
      typeof status.importMs === "number" && status.importMs <= importBudget,
      `the first-open import took ${status.importMs} ms (budget ${importBudget} ms on a CI runner, 1 ms a row in the debug test build)`,
    );

    await bridge.waitFor(
      "the For you shelves",
      `return e2e.all(".lib-shelf .lib-card").length > 0;`,
      { timeoutMs: 20_000 },
    );
    const home = await libraryState(bridge);
    await bridge.screenshot(join(evidenceDir, "01-library-home.png"));
    const cards = home.shelves.reduce((n, s) => n + s.cards.length, 0);
    log(
      `  home: ${home.shelves.map((s) => `${s.id}(${s.cards.length})`).join(", ")}`,
    );
    check(
      home.shelves.length > 0 &&
        home.shelves.every((s) => s.cards.length <= 12),
      "the home screen shows shelves of at most 12 cards",
    );
    check(
      cards > 0 && cards < 100,
      `and never the whole catalog (${cards} cards of ${lock.rows} entries)`,
    );
    check(
      home.shelves.some((s) => s.id === "domains"),
      "with a way to browse every domain",
    );

    const rows = await search(bridge, "root cause");
    log(
      `  "root cause": ${rows.length} rows rendered, first ${rows.slice(0, 5).join(", ")}`,
    );
    check(rows.length > 0, "a search finds entries offline");
    const st = await libraryState(bridge);
    check(
      st.renderedRows <= 40,
      `the result list renders only what is visible (${st.renderedRows} rows in the DOM)`,
    );
    const first = rows.find((r) => !r.includes(":"));
    await openEntry(bridge, first);
    await waitPreview(bridge, "");
    const opened = await libraryState(bridge);
    log(
      `  opened ${opened.detail}: "${opened.detailTitle}", preview ${opened.preview?.length ?? 0} chars`,
    );
    await bridge.screenshot(join(evidenceDir, "02-entry-offline.png"));
    check(
      (opened.preview ?? "").trim().length > 40,
      "its text renders with no network",
    );

    // The update check a second after launch could not reach the mirror.
    const after = await bridge.waitFor(
      "the failed update check",
      `const s = await window.__TAURI_INTERNALS__.invoke("library_status"); return s.lastCheck ? s : false;`,
      { timeoutMs: 30_000 },
    );
    log(
      `  update check: lastCheck=${after.lastCheck} lastSuccess=${after.lastSuccess} lastError=${after.lastError}`,
    );
    check(
      !after.lastSuccess && !!after.lastError,
      "the offline update check failed and was recorded",
    );
    check(
      after.catalog?.rows === lock.rows && after.catalog?.source === "bundled",
      "and changed nothing in the library",
    );
    check(
      !(await bridge.exists(".toast")) ||
        !(await bridge.eval(
          `return e2e.all(".toast").some((t) => /library|catalog/i.test(t.innerText));`,
        )),
      "with no toast about it",
    );

    // Run 2: offline again, the library comes from its own database.
    await current().stop();
    const app2 = await relaunch(2, OFFLINE);
    const b2 = app2.bridge;
    await b2.waitFor(
      "the app (returning launch)",
      `return !!e2e.first(".activity-bar");`,
      { timeoutMs: 30_000 },
    );
    await sleep(500);
    const t1 = Date.now();
    await openLibrary(b2);
    const s2 = await invoke(b2, "library_status");
    log(
      `  run 2: ready in ${Date.now() - t1} ms, importMs=${s2.importMs}, rows=${s2.catalog?.rows}`,
    );
    check(
      s2.ready && s2.catalog?.rows === lock.rows,
      "after a relaunch the library is still there",
    );
    check(s2.importMs === null, "without importing the bundle again");
    const rows2 = await search(b2, "unit tests");
    check(rows2.length > 0, "and still searchable offline");
    await b2.screenshot(join(evidenceDir, "03-relaunch-offline.png"));
  },
  { env: OFFLINE, tag: "hod-offline" },
);
