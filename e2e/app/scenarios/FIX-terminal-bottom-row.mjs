#!/usr/bin/env node
// FIX-terminal-bottom-row — a terminal's last row is always on screen, above
// the "Agent replies" bar and the status bar, and the program in it is told
// exactly the rows that are shown.
//
// A program that draws on the last row of the size its terminal reports
// (e2e/app/fixtures/bottom-row.mjs, like an agent's TUI drawing its status
// lines at the bottom) runs in a plain terminal session opened in a test
// repository, in a small window (900 × 560):
//
//   1. alternate screen, no turn yet (no bar)
//   2. the first turn lands: the bar appears under the terminal
//   3. a second turn
//   4. the window shrinks (760 × 480, then 640 × 420) with the bar there
//   5. the same program on the normal screen
//   6. View ▸ Split Down: the pane gives half its height to a new one
//
// EXPECT at every step: the terminal's last row is drawn above the bar's top
// edge and the status bar's, inside every box that clips it; the row the
// program drew last ("BOTTOM-ROW <r>x<c>") is the terminal's last row; and
// <r>, the PTY's row count, equals the rows the terminal shows. A pane too
// short for the bar's own row folds it into the pane header (ACT-8): the bar
// is then there as the header's turns chip, above the terminal.
//
// A guard, not a fix: a report of an agent's bottom lines missing in a small
// window turned out to be the agent leaving out its own footer when it has
// few rows; Hermes sized the terminal right. This keeps it that way.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { PROBE_OUTPUT, classifyProbe, commandLine, probeCommand } from "../shells.mjs";

const SCENARIO = "FIX-terminal-bottom-row";
const FIXTURE = join(REPO_ROOT, "e2e", "app", "fixtures", "bottom-row.mjs");

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

async function resize(bridge, width, height) {
  await invoke(bridge, "plugin:window|set_size", { label: "main", value: { Logical: { width, height } } });
  await bridge.waitFor(`the window at ${width} × ${height}`, `return innerWidth <= ${width} + 2 && innerWidth >= ${width} - 40 && innerHeight <= ${height} + 2;`, { timeoutMs: 10_000 });
}

/** Where the terminal of `sid` draws its last row, and what is on it. */
const measure = (sid) => `
  const id = ${JSON.stringify(sid)};
  const info = window.__HERMES_E2E__.terminalInfo(id);
  const pane = e2e.all(".split-pane").find((p) => p.querySelector(".terminal-viewport") && p.querySelector('div[data-session-id="' + CSS.escape(id) + '"]'));
  const screenEl = pane?.querySelector(".xterm-screen");
  if (!info || !screenEl) return null;
  const screen = screenEl.getBoundingClientRect();
  // The lowest edge anything that clips the terminal lets through.
  let clip = innerHeight;
  for (let el = screenEl.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowY !== "visible") clip = Math.min(clip, el.getBoundingClientRect().bottom);
  }
  const bar = pane.querySelector(".turn-bar")?.getBoundingClientRect() ?? null;
  // A short pane folds the bar into its header (ACT-8): one chip above the terminal.
  const folded = pane.querySelector(".turn-bar-compact")?.getBoundingClientRect() ?? null;
  const status = e2e.first(".status-bar")?.getBoundingClientRect() ?? null;
  const last = (window.__HERMES_E2E__.terminalTail(id, 1) || [""])[0];
  const m = /BOTTOM-ROW (\\d+)x(\\d+)/.exec(last);
  return {
    rows: info.rows, cols: info.cols,
    ptyRows: m ? Number(m[1]) : null, ptyCols: m ? Number(m[2]) : null,
    lastRow: last.trim(),
    screenBottom: Math.round(screen.bottom * 10) / 10,
    clipBottom: Math.round(clip * 10) / 10,
    barTop: bar ? Math.round(bar.top * 10) / 10 : null,
    foldedBottom: folded ? Math.round(folded.bottom * 10) / 10 : null,
    screenTop: Math.round(screen.top * 10) / 10,
    statusTop: status ? Math.round(status.top * 10) / 10 : null,
    window: innerWidth + "x" + innerHeight,
  };
`;

function problems(s, { bar }) {
  const out = [];
  if (!s) return ["no terminal on screen"];
  if (s.ptyRows === null) out.push(`the terminal's last row is not the program's bottom row ("${s.lastRow}")`);
  else if (s.ptyRows !== s.rows || s.ptyCols !== s.cols) out.push(`the PTY is ${s.ptyRows}×${s.ptyCols} but the terminal shows ${s.rows}×${s.cols}`);
  if (s.screenBottom > s.clipBottom + 0.5) out.push(`the last row ends at ${s.screenBottom}, below the visible edge ${s.clipBottom}`);
  if (bar && s.barTop === null && s.foldedBottom === null) out.push("the Agent replies bar is not there (neither under the terminal nor folded into the header)");
  if (s.foldedBottom !== null && s.foldedBottom > s.screenTop + 0.5) out.push(`the folded bar ends at ${s.foldedBottom}, over the terminal's top ${s.screenTop}`);
  if (s.barTop !== null && s.screenBottom > s.barTop + 0.5) out.push(`the last row ends at ${s.screenBottom}, under the bar's top ${s.barTop}`);
  if (s.statusTop !== null && s.screenBottom > s.statusTop + 0.5) out.push(`the last row ends at ${s.screenBottom}, under the status bar's top ${s.statusTop}`);
  return out;
}

await runScenario(SCENARIO, async ({ log, assert, apps, evidenceDir, onCleanup }) => {
  // A throwaway repository (synthetic identity) for the turn ledger.
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-bottom-row-")));
  onCleanup(() => rmSync(work, { recursive: true, force: true }));
  const repo = join(work, "repo");
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "app.txt"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");

  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);
  await resize(bridge, 900, 560);

  log("a plain terminal session in the test repository");
  const sid = await bridge.eval(`return await window.__HERMES_E2E__.newTerminal({ label: "bottom row", cwd: ${JSON.stringify(repo)} });`, { timeoutMs: 30_000 });
  await bridge.waitFor("the shell prompt", `
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sid)});
    return info && info.opened && (window.__HERMES_E2E__.readTerminal(${JSON.stringify(sid)}) || []).some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1500);
  await bridge.typeInTerminal(sid, `${probeCommand()}\n`);
  const shell = classifyProbe((await bridge.waitForTerminal(sid, PROBE_OUTPUT, { timeoutMs: 20_000 })).line);

  let shot = 0;
  /** Wait (up to 6 s) for the terminal to settle with its last row visible. */
  async function expectBottomVisible(what, { bar, id = sid }) {
    let s = null;
    let bad = [];
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      s = await bridge.eval(measure(id));
      bad = problems(s, { bar });
      if (bad.length === 0) break;
    }
    log(`  [${what}] ${JSON.stringify(s)}`);
    await bridge.screenshot(join(evidenceDir, `${String(++shot).padStart(2, "0")}-${what.replace(/[^a-z0-9]+/gi, "-")}.png`));
    assert(bad.length === 0, `${what}: the last row is visible above the bar and the status bar, and the PTY has the rows shown${bad.length ? ` (${bad.join("; ")})` : ""}`);
  }

  async function turn(n, change) {
    assert(await bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sid)}, ${JSON.stringify({ type: "turn_start", at: Date.now(), n, source: "e2e" })});`), `turn ${n} started`);
    change();
    await sleep(300);
    assert(await bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sid)}, ${JSON.stringify({ type: "turn_end", at: Date.now(), n, source: "e2e" })});`), `turn ${n} ended`);
    await bridge.waitFor(`the T${n} chip`, `
      const bar = e2e.first('.turn-bar[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]');
      return !!(bar && e2e.first('.turn-bar-turn[data-turn-n="${n}"]', bar));
    `, { timeoutMs: 20_000 });
  }

  const run = async (args, what) => {
    await bridge.typeInTerminal(sid, commandLine(shell, process.execPath, [FIXTURE, ...args]) + "\r");
    await bridge.waitForTerminal(sid, /BOTTOM-ROW \d+x/, { timeoutMs: 20_000 });
    log(`  ${what} is running`);
  };

  log("step 1: the program on the alternate screen, no turn yet");
  await run(["--alt"], "the alternate-screen program");
  await expectBottomVisible("alt screen, no bar", { bar: false });

  log("step 2: the first turn lands; the bar appears under the terminal");
  await turn(1, () => writeFileSync(join(repo, "app.txt"), "one\nTWO\nthree\nfour\n"));
  await expectBottomVisible("bar appeared", { bar: true });

  log("step 3: a second turn");
  await turn(2, () => writeFileSync(join(repo, "notes.txt"), "a\nb\nc\n"));
  await expectBottomVisible("second turn", { bar: true });

  log("step 4: the window shrinks with the bar there");
  await resize(bridge, 760, 480);
  await expectBottomVisible("760x480", { bar: true });
  await resize(bridge, 640, 420);
  await expectBottomVisible("640x420", { bar: true });

  log("step 5: the same program on the normal screen");
  await bridge.typeInTerminal(sid, "q");
  await sleep(500);
  await resize(bridge, 900, 560);
  await run([], "the normal-screen program");
  await expectBottomVisible("normal screen", { bar: true });
  await resize(bridge, 700, 440);
  await expectBottomVisible("normal screen 700x440", { bar: true });

  log("step 6: View ▸ Split Down; the pane gives half its height to a new one");
  await resize(bridge, 900, 560);
  await expectBottomVisible("before split", { bar: true });
  const before = await bridge.terminalIds();
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "view.split-vertical" } }); return true;`);
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  for (let i = 0; i < 6; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"), "the wizard's primary button"));
    `);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const second = await bridge.waitFor("the new pane's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await bridge.waitFor("two panes", `return e2e.all(".split-pane").length === 2;`);
  await expectBottomVisible("split down", { bar: true });
  await resize(bridge, 700, 480);
  await expectBottomVisible("split down 700x480", { bar: true });
  log(`  (the new pane: ${second})`);
  await bridge.typeInTerminal(sid, "q");
});
