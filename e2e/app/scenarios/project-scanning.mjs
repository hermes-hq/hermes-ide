#!/usr/bin/env node
// Scenario project-scanning (README claims "project-scanning",
// "context-injection" and "multi-project"): on the REAL app, two throwaway
// project folders are scanned and both attached to one agent session, and
// what the scan found reaches the agent through its context file, within a
// token budget.
//
//   web-app  package.json with React, tsconfig.json in strict mode,
//            .prettierrc (no semicolons, single quotes), src/components,
//            src/hooks
//   engine   Cargo.toml with Tokio, src/main.rs + src/lib.rs,
//            .editorconfig (4 spaces), and .hermes/context.json setting a
//            token budget of 40 tokens
//
// 1. The New Session wizard for Claude Code (a stand-in CLI that records
//    how it was started): both folders are added on the folder step with
//    Scan. The picker shows what the first scan found: web-app is
//    JavaScript/TypeScript with React, engine is Rust with Tokio.
// 2. Both projects are attached to the one session (the backend says so).
// 3. The deeper scan finds the architecture and the conventions: web-app is
//    a src layout (components, hooks) with typescript-strict-mode,
//    no-semicolons and single-quotes; engine is a Rust binary + library
//    with "indent: 4 spaces". The Context panel lists both projects, each
//    with its architecture, languages and conventions, and shows the token
//    budget.
// 4. The agent was started with a first prompt that points it at the
//    session's context file; that file names both projects with their
//    languages, frameworks and architecture, states the budget, and — the
//    budget being tighter than the context — keeps the first project's
//    conventions and drops the second's (the Context panel still lists
//    them: the scan found them, the budget left them out).
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_SCAN_NEGATIVE=one-project scans both folders but unselects
//   engine again before the session starts: the session has one project.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/project-scanning.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { openWizard, runScenario } from "../n11-steps.mjs";
import { startApp } from "../qa-host-steps.mjs";
import { invoke, menuAction, setInput } from "../fleet-steps.mjs";

const SCENARIO = "project-scanning";
const ONE_PROJECT = process.env.HERMES_E2E_SCAN_NEGATIVE === "one-project";
const BUDGET = 40;
const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";

function write(root, rel, text) {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}${ONE_PROJECT ? "   only ONE project attached (negative control)" : ""}`);
  const { fx, bridge } = await startApp("proj-scan", evidenceDir, log, onCleanup, apps);

  const webApp = join(fx.work, "web-app");
  write(webApp, "package.json", JSON.stringify({ name: "web-app", private: true, dependencies: { react: "^18.3.0", "react-dom": "^18.3.0" }, devDependencies: { typescript: "^5.4.0" } }, null, 2));
  write(webApp, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx" } }, null, 2));
  write(webApp, ".prettierrc", '{ "semi": false, "singleQuote": true }\n');
  write(webApp, "src/components/Button.tsx", "export const Button = () => <button>ok</button>\n");
  write(webApp, "src/hooks/useCount.ts", "export const useCount = () => 1\n");
  const engine = join(fx.work, "engine");
  write(engine, "Cargo.toml", '[package]\nname = "engine"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ntokio = "1"\n');
  write(engine, "src/main.rs", "fn main() {}\n");
  write(engine, "src/lib.rs", "pub fn run() {}\n");
  write(engine, ".editorconfig", "root = true\n\n[*]\nindent_style = space\nindent_size = 4\n");
  write(engine, ".hermes/context.json", JSON.stringify({ token_budget: BUDGET }) + "\n");
  log(`  project folders: ${webApp}, ${engine}`);

  // ── 1. Scan both folders on the wizard's folder step ───────────────
  log("step 1: New Session > Claude Code, add both folders with Scan");
  await openWizard(bridge);
  await bridge.click('.session-creator-provider-card[data-agent-id="claude"]');
  await sleep(300);
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "Next"));`);
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`, { timeoutMs: 20_000 });
  for (const folder of [webApp, engine]) {
    const name = folder.split(/[\\/]/).pop();
    await setInput(bridge, ".session-creator-scan-input", folder);
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
    await bridge.waitFor(`${name} scanned and selected`, `
      return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.querySelector(".project-picker-name")?.innerText.includes(${JSON.stringify(name)}));
    `, { timeoutMs: 20_000 });
  }
  if (ONE_PROJECT) {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".project-picker-item").find((el) => el.querySelector(".project-picker-name")?.innerText.includes("engine")), "engine"));`);
    await sleep(500);
    log("  negative control: engine unselected again");
  }
  const tags = await bridge.eval(`
    const out = {};
    for (const el of e2e.all(".project-picker-item")) {
      const name = e2e.norm(el.querySelector(".project-picker-name")?.firstChild?.textContent ?? "");
      out[name] = {
        languages: [...el.querySelectorAll(".workspace-lang-tag")].map((t) => e2e.norm(t.innerText)),
        frameworks: [...el.querySelectorAll(".workspace-fw-tag")].map((t) => e2e.norm(t.innerText)),
        attached: el.classList.contains("project-picker-item-attached"),
      };
    }
    return out;
  `);
  log(`  picker: ${JSON.stringify(tags)}`);
  await bridge.screenshot(join(evidenceDir, "01-scanned-in-wizard.png"));
  assert(tags["web-app"]?.languages.some((l) => /TypeScript/.test(l)) && tags["web-app"].frameworks.includes("React"), "web-app is detected as JavaScript/TypeScript with React");
  assert(tags.engine?.languages.includes("Rust") && tags.engine.frameworks.includes("Tokio"), "engine is detected as Rust with Tokio");
  assert(tags["web-app"].attached && tags.engine.attached, "both projects are selected for the session");

  const before = await bridge.terminalIds();
  for (let i = 0; i < 6 && (await bridge.exists(".session-creator")); i++) {
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
    `);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const sid = await bridge.waitFor("the Claude session", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  const [rec] = await fx.waitForRecords(1, 60_000);
  log(`  session ${sid}; the agent was started with: ${JSON.stringify(rec.argv)}`);

  // ── 2. Both projects attached to the one session ───────────────────
  log("step 2: both projects are attached to the session");
  const attached = (await invoke(bridge, "get_session_projects", { sessionId: sid })).map((p) => p.name).sort();
  assert(JSON.stringify(attached) === JSON.stringify(["engine", "web-app"]), `the session has both projects attached (${attached.join(", ")})`);

  // ── 3. The deeper scan: architecture and conventions ───────────────
  log("step 3: the deeper scan finds architecture and conventions; the Context panel shows them");
  const scanned = await bridge.waitFor("the deeper scan of both projects", `
    const projects = await window.__TAURI_INTERNALS__.invoke("get_session_projects", { sessionId: ${JSON.stringify(sid)} });
    if (projects.length < 2 || projects.some((p) => p.scan_status === "surface" || p.scan_status === "pending")) return null;
    return Object.fromEntries(projects.map((p) => [p.name, { status: p.scan_status, arch: p.architecture?.pattern, layers: p.architecture?.layers ?? [], conventions: p.conventions.map((c) => c.rule) }]));
  `, { timeoutMs: 30_000 });
  log(`  scan: ${JSON.stringify(scanned)}`);
  assert(scanned["web-app"].arch === "src-layout" && ["components", "hooks"].every((l) => scanned["web-app"].layers.includes(l)), "web-app: a src layout with components and hooks");
  assert(["typescript-strict-mode", "no-semicolons", "single-quotes"].every((c) => scanned["web-app"].conventions.includes(c)), "web-app: strict TypeScript, no semicolons, single quotes");
  assert(scanned.engine.arch === "rust-mixed" && scanned.engine.conventions.includes("indent: 4 spaces"), "engine: a Rust binary + library indented with 4 spaces");

  await bridge.clickWhenReady(`return e2e.click(e2e.must(document.querySelector('.session-item[data-session-item-id="${sid}"]'), "the session row"));`);
  await sleep(300);
  if (!(await bridge.exists(".context-panel-body"))) await menuAction(bridge, "view.context-panel");
  await bridge.waitFor("both projects in the Context panel", `return e2e.all(".ctx-domain-project-name").length === 2;`, { timeoutMs: 15_000 });
  const panel = {};
  for (const name of ["web-app", "engine"]) {
    await bridge.clickWhenReady(`
      const header = e2e.all(".ctx-domain-project-header").find((h) => e2e.norm(h.querySelector(".ctx-domain-project-name").innerText) === ${JSON.stringify(name)});
      return e2e.click(e2e.must(header, "${name} in the Context panel"));
    `);
    panel[name] = await bridge.waitFor(`${name}'s details`, `
      const d = e2e.first(".ctx-domain-project-detail");
      if (!d) return null;
      const rows = Object.fromEntries([...d.querySelectorAll(".ctx-kv")].map((r) => [e2e.norm(r.children[0].innerText), e2e.norm(r.children[1].innerText)]));
      return { rows, conventions: [...d.querySelectorAll(".ctx-domain-conv")].map((c) => e2e.norm(c.innerText)) };
    `);
    log(`  Context panel, ${name}: ${JSON.stringify(panel[name])}`);
  }
  assert(panel["web-app"].rows.Architecture === "src-layout" && /TypeScript/.test(panel["web-app"].rows.Languages ?? "") && panel["web-app"].conventions.includes("typescript-strict-mode"), "the panel shows web-app's architecture, languages and conventions");
  assert(panel.engine.rows.Architecture === "rust-mixed" && /Rust/.test(panel.engine.rows.Languages ?? "") && panel.engine.conventions.includes("indent: 4 spaces"), "the panel shows engine's architecture, languages and conventions");
  const budgetLabel = await bridge.waitFor("the token budget meter", `return e2e.norm(e2e.first(".ctx-budget-label")?.innerText ?? "") || null;`);
  log(`  budget meter: ${budgetLabel}`);
  assert(new RegExp(`/ ${BUDGET} tokens`).test(budgetLabel), `the panel shows the project's token budget (${budgetLabel})`);
  await bridge.screenshot(join(evidenceDir, "02-context-panel.png"));

  // ── 4. What the agent is pointed at ────────────────────────────────
  log("step 4: the agent's first prompt points at the context file, which holds both projects within the budget");
  const prompt = rec.argv[rec.argv.length - 1];
  const m = /Read the file at (.+?\.md) for project context/.exec(prompt);
  assert(!!m, `the agent's first prompt points it at a context file (${JSON.stringify(prompt)})`);
  const ctxFile = m[1];
  assert(existsSync(ctxFile), `the context file exists (${ctxFile})`);
  // The file is rewritten once the deeper scan lands.
  let body = "";
  for (let i = 0; i < 60; i++) {
    body = readFileSync(ctxFile, "utf8");
    if (body.includes("Architecture: rust-mixed") && body.includes("Architecture: src-layout")) break;
    await sleep(250);
  }
  log(`  context file:\n${body}`);
  const section = (name) => {
    const start = body.indexOf(`### ${name} (`);
    if (start < 0) return "";
    const rest = body.slice(start + 4);
    const next = rest.search(/\n(### |## )/);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const web = section("web-app");
  const eng = section("engine");
  assert(/- Languages: .*TypeScript/.test(web) && /- Frameworks: .*React/.test(web) && web.includes("- Architecture: src-layout"), "web-app's languages, framework and architecture are in the file");
  assert(/- Languages: .*Rust/.test(eng) && /- Frameworks: .*Tokio/.test(eng) && eng.includes("- Architecture: rust-mixed"), "engine's languages, framework and architecture are in the file");
  assert(/- All Languages: .*TypeScript.*Rust|- All Languages: .*Rust.*TypeScript/.test(body), "the summary combines both projects' languages");
  const used = Number(/- Token budget: ~(\d+) \/ (\d+) used/.exec(body)?.[1] ?? NaN);
  const budget = Number(/- Token budget: ~(\d+) \/ (\d+) used/.exec(body)?.[2] ?? NaN);
  assert(budget === BUDGET && used > budget, `the file states the budget (~${used} / ${budget}); the context is larger than it`);
  assert(/- Conventions: .*typescript-strict-mode/.test(web), "the first project keeps its conventions");
  assert(!eng.includes("- Conventions:"), "the second project's conventions are left out to fit the budget (the panel still lists them)");
});
