#!/usr/bin/env node
// HOD-search-latency: searching the prompt library in the real app is fast
// and stays correct while the person types.
//
//   - 300 mixed queries (title words, two-word phrases, three-letter
//     prefixes, qualifiers like kind:persona and works:codex, ids) through
//     the app's own search command: the search itself (measured inside the
//     app) answers at p95 <= 50 ms, and the round trip from the page
//     (IPC included) at p95 <= 50 ms.
//   - Typing in the search field shows the results for the text typed within
//     500 ms (the field waits 80 ms for typing to pause).
//   - Answers that arrive late are dropped: typing "a" and at once
//     "flaky tests" shows the results of "flaky tests", not of "a".
//   - Paging is by cursor: page 2 continues page 1 with no repeats, and
//     scrolling the list to its end loads the next page.
//
// The 1M-row budget of the same search is the Rust bench in CI
// (src-tauri/src/library/bench.rs); this scenario proves the shipped app.

import { join } from "node:path";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { invoke, libraryState, openLibrary, readBundledCatalog, search, typeValue } from "../library-steps.mjs";

const NAME = "HOD-search-latency";

/** 300 queries a person might type, made from the bundled catalog itself. */
function queries() {
  const { rows } = readBundledCatalog();
  const out = [];
  const words = (s) => s.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const facets = ["kind:persona", "kind:prompt", "kind:workflow", "works:codex", "works:claude-code", "kind:rule"];
  for (let i = 0; out.length < 300; i++) {
    const r = rows[(i * 37) % rows.length];
    const w = words(r.title);
    if (w.length === 0) continue;
    switch (i % 6) {
      case 0:
        out.push(w[0]);
        break;
      case 1:
        out.push(w.slice(0, 2).join(" "));
        break;
      case 2:
        out.push(w[0].slice(0, 3));
        break;
      case 3:
        out.push(`${w[w.length - 1]} ${facets[i % facets.length]}`);
        break;
      case 4:
        out.push(r.id);
        break;
      default:
        out.push(`${(r.tags?.[0] ?? w[0]).replace(/-/g, " ")}`);
    }
  }
  return out;
}

const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

await runLauncherQa(
  NAME,
  async ({ bridge, log, check, evidenceDir }) => {
    await openLibrary(bridge);
    const qs = queries();
    // Warm the reader (the first query after the import pages the index in).
    await invoke(bridge, "library_search", { request: { query: "review", limit: 50 }, context: null });

    const timings = await bridge.eval(
      `
      const qs = ${JSON.stringify(qs)};
      const out = [];
      for (const q of qs) {
        const t0 = performance.now();
        const page = await window.__TAURI_INTERNALS__.invoke("library_search", {
          request: { query: q, limit: 50, sort: "you", personalise: true, counts: true },
          context: { works: ["claude-code", "codex"], activeWork: "claude-code" },
        });
        out.push({ q, rt: performance.now() - t0, took: page.tookMs, hits: page.hits.length, total: page.total });
      }
      return out;
    `,
      { timeoutMs: 120_000 },
    );
    const rt = timings.map((t) => t.rt);
    const took = timings.map((t) => t.took);
    const empty = timings.filter((t) => t.hits === 0).length;
    log(`  ${timings.length} queries: search p95 ${p95(took)} ms (max ${Math.max(...took)}), round trip p95 ${p95(rt).toFixed(1)} ms (max ${Math.max(...rt).toFixed(1)}), ${empty} with no result`);
    for (const t of [...timings].sort((a, b) => b.rt - a.rt).slice(0, 5)) log(`    slowest: "${t.q}" ${t.rt.toFixed(1)} ms (search ${t.took} ms, ${t.total} matches)`);
    check(timings.length === 300, "300 queries ran");
    check(p95(took) <= 50, `the search answers at p95 <= 50 ms (${p95(took)} ms)`);
    check(p95(rt) <= 50, `the page gets its answer at p95 <= 50 ms, IPC included (${p95(rt).toFixed(1)} ms)`);
    check(empty < 30, `almost every query finds something (${empty} of 300 found nothing)`);
    check(
      timings.every((t) => t.hits <= 50),
      "no answer is larger than one page of 50",
    );

    // Typing: the results of what was typed, quickly.
    const typed = [];
    for (const q of ["flaky tests", "write a cover letter", "sql query", "persona kind:persona", "commit message"]) {
      await typeValue(bridge, ".lib-search-input", "");
      await sleep(150);
      const t0 = Date.now();
      await search(bridge, q);
      typed.push(Date.now() - t0);
    }
    log(`  typing to results: ${typed.join(", ")} ms`);
    check(Math.max(...typed) <= 500, `results show within 500 ms of typing (worst ${Math.max(...typed)} ms)`);

    // Late answers are dropped.
    const expected = await invoke(bridge, "library_search", {
      request: { query: "flaky tests", limit: 50, sort: "you", personalise: true, counts: true },
      context: null,
    });
    await bridge.eval(`
      const el = e2e.first(".lib-search-input");
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      el.focus();
      set.call(el, "a"); el.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 90));
      set.call(el, "flaky tests"); el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await sleep(1200);
    const shown = await libraryState(bridge);
    log(`  after "a" then "flaky tests": first rows ${shown.rows.slice(0, 5).join(", ")}; expected ${expected.hits.slice(0, 5).map((h) => h.id).join(", ")}`);
    check(shown.rows[0] === expected.hits[0]?.id, "the list shows the last query's results, not a late answer to an earlier one");
    await bridge.screenshot(join(evidenceDir, "01-results.png"));

    // Paging by cursor.
    const p1 = await invoke(bridge, "library_search", { request: { query: "write", limit: 50, counts: true }, context: null });
    const p2 = p1.nextCursor ? await invoke(bridge, "library_search", { request: { query: "write", limit: 50, cursor: p1.nextCursor }, context: null }) : null;
    const overlap = p2 ? p2.hits.filter((h) => p1.hits.some((x) => x.id === h.id)).length : -1;
    log(`  "write": total ${p1.total}${p1.totalCapped ? "+" : ""}, page 1 ${p1.hits.length}, page 2 ${p2?.hits.length ?? 0}, overlap ${overlap}`);
    check(p1.total > 50 && !!p1.nextCursor, "a broad query has a next page");
    check(!!p2 && p2.hits.length > 0 && overlap === 0, "page 2 continues page 1 with no repeats");

    await search(bridge, "write", { minRows: 10 });
    const before = (await libraryState(bridge)).listCount;
    for (let i = 0; i < 6; i++) {
      await bridge.eval(`const l = e2e.first(".lib-rows"); l.scrollTop = l.scrollHeight; l.dispatchEvent(new Event("scroll")); return true;`);
      await sleep(400);
    }
    const afterScroll = await libraryState(bridge);
    log(`  scrolling the list: ${before} -> ${afterScroll.listCount} items, ${afterScroll.renderedRows} rows in the DOM`);
    check(afterScroll.listCount > before, "scrolling to the end loads the next page");
    check(afterScroll.renderedRows <= 40, "and the list still renders only the rows in view");
    await bridge.screenshot(join(evidenceDir, "02-paged.png"));
  },
  { tag: "hod-search" },
);
