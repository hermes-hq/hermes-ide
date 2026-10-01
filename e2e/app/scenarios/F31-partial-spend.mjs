#!/usr/bin/env node
// Scenario F31-partial-spend: a total that leaves sessions out says so.
// On the REAL app with two fake `claude` sessions (tools/fake-agents/
// fake-cli.mjs, started through `hi run`) and a plain shell, all in one
// project. Each `c` typed into a fake appends one model call to its own
// transcript, with the usage and model the scenario chose.
//
//   1. before any model call no cost is known: the project header and the
//      status bar say "n/a" (not nothing, and never "$0.00");
//   2. session A makes a call on a priced model, session B none yet: the
//      status bar says "≈$0.37 (estimated) · 1 session n/a", the narrow
//      project header "≈$0.37 (estimated) · 1 n/a" (its tooltip in full),
//      and both tooltips name B (and not A, nor the plain shell);
//   3. session B makes a call on a model Hermes has no list price for: its
//      tokens are known but its cost is not, so the texts stay the same;
//   4. the plain shell is never counted;
//   5. at the default sidebar width (240 px) the header's amount and its
//      "1 session n/a" are on screen whole, not cut off by the ellipsis
//      (only " (estimated)" may be cut short; the tooltip has it all).
//
// Negative controls: HERMES_E2E_F31P_NEGATIVE=priced puts B's call on a
// priced model too, so nothing is unknown and the scenario must end in
// RESULT: FAIL at step 3. HERMES_E2E_F31P_NEGATIVE=clip puts back the
// header's old one-line ellipsis (the whole text cut at the right edge),
// and the scenario must end in RESULT: FAIL at step 2's on-screen check.
// Against a build without the fix, step 1 fails (the header shows nothing
// and the status bar no cost) and step 2 shows "≈$0.37 (estimated)" as if
// it were the total.
//
// Windows: the fake `claude` has to be on the user's registry Path, which is
// only changed on a CI runner; elsewhere the scenario reports RESULT: SKIP.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F31-partial-spend.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, skipScenario, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";
import { createClaudeTerminal, fakeClaudeOnPath } from "../perf-steps.mjs";
import { invoke, rowState } from "../fleet-steps.mjs";

const SCENARIO = "F31-partial-spend";
const NEGATIVE = process.env.HERMES_E2E_F31P_NEGATIVE || "";
const onWindows = platform() === "win32";
const PROJECT = "Mixed";
const LABEL_A = "priced agent";
const LABEL_B = "unpriced agent";
const LABEL_SHELL = "plain shell";
// List price of claude-sonnet-4-6 per million tokens: $3 in, $15 out.
// 4,000 in and 24,000 out: $0.012 + $0.36 = $0.372.
const PRICED = { model: "claude-sonnet-4-6", input_tokens: 4_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 24_000 };
const UNPRICED = { model: "claude-fake-1", input_tokens: 5_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 };
const B_CALL = NEGATIVE === "priced" ? { ...PRICED, output_tokens: 100 } : UNPRICED;
const PARTIAL = "≈$0.37 (estimated) · 1 session n/a";
// The project header counts them short; its tooltip starts with PARTIAL.
const HEADER_PARTIAL = "≈$0.37 (estimated) · 1 n/a";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? `   NEGATIVE CONTROL: ${NEGATIVE}` : ""}`);
  const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f31p-"));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  const recordDir = join(work, "records");
  const privateHome = join(work, "home");
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(privateHome, { recursive: true });

  const fake = fakeClaudeOnPath(work, log);
  onCleanup(fake.undo);
  if (!fake.usable) {
    log("this scenario needs the fake claude on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
  }

  const env = { HERMES_FAKE_DIR: recordDir };
  const app = await (onWindows
    ? launchApp({ runDir: join(evidenceDir, "run-1"), log, env, home: "real", resetData: true })
    : launchApp({ runDir: join(evidenceDir, "run-1"), log, env, home: "private", homeDir: privateHome }));
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  log(`two Claude sessions in terminals (through hi run) and a plain shell, all in the "${PROJECT}" project`);
  const a = await createClaudeTerminal(bridge, log);
  await bridge.waitForTerminal(a, /fake-cli: ready/, { timeoutMs: 30_000 });
  const b = await createClaudeTerminal(bridge, log);
  await bridge.waitForTerminal(b, /fake-cli: ready/, { timeoutMs: 30_000 });
  const shell = await createPlainTerminal(bridge, log);
  for (const [id, label] of [[a, LABEL_A], [b, LABEL_B], [shell, LABEL_SHELL]]) {
    await invoke(bridge, "update_session_group", { sessionId: id, group: PROJECT });
    await invoke(bridge, "update_session_label", { sessionId: id, label });
  }
  await bridge.waitFor(`the three sessions under the "${PROJECT}" header, with their names`, `
    const section = e2e.all(".project-section").find((s) => s.querySelector('[data-session-item-id="${a}"]'));
    if (!section) return null;
    const ids = ${JSON.stringify([a, b, shell])};
    if (!ids.every((id) => section.querySelector('[data-session-item-id="' + id + '"]'))) return null;
    const text = e2e.norm(section.innerText);
    return ${JSON.stringify([LABEL_A, LABEL_B, LABEL_SHELL])}.every((l) => text.includes(l));
  `, { timeoutMs: 15_000 });
  await sleep(1500); // the SessionStart signals and the transcript watches settle

  const headerCost = () => bridge.eval(`
    const section = e2e.all(".project-section").find((s) => s.querySelector('[data-session-item-id="${a}"]'));
    const c = section?.querySelector(".project-header-cost");
    // All of its text, a part the header cuts short included: what is on
    // screen is checked apart (assertHeaderFits).
    return c ? { text: e2e.norm(c.textContent), kind: c.dataset.spend, unknown: c.dataset.unknown, title: c.title } : null;
  `);
  const statusCost = () => bridge.eval(`
    const c = e2e.first(".status-bar-cost");
    return c ? { text: e2e.norm(c.querySelector(".status-bar-cost-amount").innerText), kind: c.dataset.spend, unknown: c.dataset.unknown, title: c.title } : null;
  `);
  const waitForBoth = async (what, text, headerText = text) => {
    const read = async () => ({ header: await headerCost(), status: await statusCost() });
    const deadline = Date.now() + 15_000;
    let seen = await read();
    while (Date.now() < deadline && !(seen.header?.text === headerText && seen.status?.text === text)) {
      await sleep(200);
      seen = await read();
    }
    log(`  ${what}: header ${JSON.stringify(seen.header)}; status bar ${JSON.stringify(seen.status)}`);
    return seen;
  };
  // What of the header's spend is on screen: each part's box against the
  // spend's own box and the project header's, and whether any is cut.
  const headerFit = () => bridge.eval(`
    const section = e2e.all(".project-section").find((s) => s.querySelector('[data-session-item-id="${a}"]'));
    const c = section?.querySelector(".project-header-cost");
    if (!c) return null;
    const header = c.closest(".project-header");
    const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const within = (inner, outer) => inner.width > 0 && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
    const part = (cls) => {
      const el = c.querySelector("." + cls);
      if (!el) return null;
      const b = box(el);
      return { text: el.textContent, whole: el.scrollWidth <= el.clientWidth, inSpend: within(b, box(c)), inHeader: within(b, box(header)) };
    };
    return {
      sidebarWidth: e2e.first(".session-list")?.offsetWidth ?? null,
      spend: { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, inHeader: within(box(c), box(header)) },
      amount: part("project-header-cost-amount"),
      qualifier: part("project-header-cost-qualifier"),
      unknown: part("project-header-cost-unknown"),
    };
  `);
  const assertHeaderFits = async (what) => {
    const fit = await headerFit();
    log(`  ${what}: on screen ${JSON.stringify(fit)}`);
    assert(fit?.sidebarWidth === 240, `the sidebar is at its default width, 240 px (${fit?.sidebarWidth})`);
    for (const name of ["amount", "unknown"]) {
      const p = fit[name];
      assert(p && p.whole && p.inSpend && p.inHeader, `the header's ${JSON.stringify(p?.text ?? null)} is on screen whole (${JSON.stringify(p)})`);
    }
    assert(fit.spend.scrollWidth <= fit.spend.clientWidth + 1 && fit.spend.inHeader, `nothing of the header's spend runs past its edge (${fit.spend.scrollWidth} px of text in ${fit.spend.clientWidth} px)`);
  };
  const tooltipNames = (title) => {
    const lines = String(title ?? "").split("\n");
    const at = lines.findIndex((l) => l === "No cost known for:");
    return at < 0 ? [] : lines.slice(at + 1).map((l) => l.trim()).filter(Boolean);
  };
  const call = async (id, usage) => {
    // Show the session first, as a person would before typing into it.
    await bridge.clickWhenReady(`return e2e.click(e2e.must(document.querySelector('.session-item[data-session-item-id="${id}"]'), "the session's row"));`);
    await bridge.waitFor("its terminal", `return window.__HERMES_E2E__.terminalIds().includes(${JSON.stringify(id)});`, { timeoutMs: 10_000 });
    writeFileSync(join(recordDir, "usage-next.json"), JSON.stringify(usage));
    await bridge.typeInTerminal(id, "c");
    const input = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    await bridge.waitForTerminal(id, new RegExp(`model call \\(${input} input tokens\\)`), { timeoutMs: 10_000 });
  };

  // ── 1. Nothing known: n/a ──────────────────────────────────────────
  log("step 1: before any model call: n/a in the rows, the project header and the status bar");
  for (const id of [a, b]) {
    const row = await rowState(bridge, id);
    assert(row?.spend?.kind === "na" && row.spend.text === "n/a", `the row of ${id === a ? LABEL_A : LABEL_B} says "${row?.spend?.text}"`);
  }
  const none = await waitForBoth("nothing known", "n/a");
  assert(none.header?.text === "n/a" && none.header.kind === "na", `the "${PROJECT}" header says n/a (${JSON.stringify(none.header?.text ?? null)})`);
  assert(none.status?.text === "n/a" && none.status.kind === "na", `the status bar says n/a (${JSON.stringify(none.status?.text ?? null)})`);
  assert(none.header.unknown === "2" && none.status.unknown === "2", "both count the two agent sessions as unknown, not the plain shell");
  await bridge.screenshot(join(evidenceDir, "01-nothing-known.png"));

  // ── 2. A is priced, B has no cost yet ──────────────────────────────
  log(`step 2: ${LABEL_A} makes a call on a priced model`);
  await call(a, PRICED);
  const rowA = await bridge.waitFor(`the row of ${LABEL_A} to show its estimate`, `
    const s = document.querySelector('.session-item[data-session-item-id="${a}"] .session-spend');
    return s && s.dataset.spend === "estimated" ? e2e.norm(s.innerText) : null;
  `, { timeoutMs: 15_000 });
  assert(rowA === "≈$0.37", `the row of ${LABEL_A} says "${rowA}"`);
  const partial = await waitForBoth("A priced, B unknown", PARTIAL, HEADER_PARTIAL);
  assert(partial.header?.text === HEADER_PARTIAL, `the "${PROJECT}" header says "${partial.header?.text}", not the known part as the total`);
  assert(partial.header.title.split("\n")[0] === PARTIAL, `the header's tooltip says it in full: "${partial.header.title.split("\n")[0]}"`);
  assert(partial.status?.text === PARTIAL, `the status bar says "${partial.status?.text}"`);
  assert(partial.header.kind === "estimated" && partial.status.kind === "estimated", "both mark the sum as estimated");
  for (const [where, seen] of [["header", partial.header], ["status bar", partial.status]]) {
    const names = tooltipNames(seen.title);
    assert(names.length === 1 && names[0] === LABEL_B, `the ${where}'s tooltip names the session whose cost is unknown: ${JSON.stringify(names)}`);
    assert(/Estimated by Hermes/.test(seen.title), `the ${where}'s tooltip says the known part is an estimate`);
  }
  if (NEGATIVE === "clip") {
    log("  NEGATIVE CONTROL: the header's spend is one line cut at the right edge again");
    await bridge.eval(`
      const st = document.createElement("style");
      st.textContent = ".project-header .project-header-cost[data-spend] { display: block !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }";
      document.head.appendChild(st);
      return true;
    `);
    await sleep(300);
  }
  await bridge.screenshot(join(evidenceDir, "02-partial-sum.png"));
  await assertHeaderFits("A priced, B unknown, at the default sidebar width");

  // ── 3. B's call has tokens but no price ────────────────────────────
  log(`step 3: ${LABEL_B} makes a call on a model Hermes has no list price for${NEGATIVE === "priced" ? " (NEGATIVE CONTROL: a priced one)" : ""}`);
  await call(b, B_CALL);
  const usageB = await bridge.waitFor(`the store to hold ${LABEL_B}'s tokens`, `
    const u = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(b)}).usage;
    return u && u.inputTokens === ${B_CALL.input_tokens} ? u : null;
  `, { timeoutMs: 15_000 });
  log(`  ${LABEL_B} usage: ${JSON.stringify(usageB)}`);
  await sleep(500);
  const still = await waitForBoth("B's tokens without a price", PARTIAL, HEADER_PARTIAL);
  assert(still.header?.text === HEADER_PARTIAL && still.status?.text === PARTIAL, `B's tokens have no price: still "${PARTIAL}" (header "${still.header?.text}", status bar "${still.status?.text}")`);
  assert(still.header.unknown === "1" && still.status.unknown === "1", "one session is counted as unknown");
  await bridge.screenshot(join(evidenceDir, "03-unpriced-tokens.png"));
  await assertHeaderFits("B's tokens without a price");

  // ── 4. The plain shell ─────────────────────────────────────────────
  log("step 4: the plain shell has no spend and is not in the tooltips");
  const shellRow = await rowState(bridge, shell);
  assert(shellRow && shellRow.spend === null, "the plain shell row has no spend badge");
  assert(!String(still.header.title).includes(LABEL_SHELL) && !String(still.status.title).includes(LABEL_SHELL), "neither tooltip names the plain shell");
});
