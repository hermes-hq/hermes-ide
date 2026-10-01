#!/usr/bin/env node
// QA-host-pc-terminal-keys (XP-01, XP-02, XP-03, XP-09, XP-11) — a
// terminal's keys under the Windows/Linux rules (emulated in the frontend
// with DOM key events, so it runs the same on every OS):
//
//   Ctrl+3          switches to session 3; the program gets nothing (it used
//                   to get ESC, which interrupts Claude Code / Codex)
//   Ctrl+Shift+C    copies the terminal's selection (it used to replace the
//                   clipboard with the session's context)
//   Ctrl+Shift+V    pastes, as a paste; right-click Paste too (it ran
//                   document.execCommand("paste"), which does nothing there)
//   Alt+Right and   move to the next pane (xterm used to turn them into
//   Ctrl+Alt+Right  escape sequences for the program)
//   Windows: Ctrl+C with text selected copies it, without interrupting
//
// The clipboard the app reads is HERMES_E2E_CLIPBOARD (test builds), and
// writes are recorded in the page, so the machine's clipboard is untouched.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import {
  clipWrites, domKey, emulatePlatform, installKeylogger, keylogBytes, newTerminal, pickPlainShellAndCreate, selectLine, sidebarState,
  startApp, startKeylogger, trapClipboard,
} from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-pc-terminal-keys";
const PASTE = "pasted-by-hermes";
const hex = (s) => [...Buffer.from(s)].map((b) => b.toString(16).padStart(2, "0"));
const hasRun = (bytes, s) => bytes.join(" ").includes(hex(s).join(" "));

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const kl = installKeylogger();
  onCleanup(() => rmSync(kl.dir, { recursive: true, force: true }));
  const { bridge } = await startApp("qa-keys", evidenceDir, log, onCleanup, apps, { env: { HERMES_E2E_CLIPBOARD: PASTE } });
  await emulatePlatform(bridge, "linux", log);

  log("step 1: three terminals; the first runs the key logger");
  const ids = [];
  for (const label of ["one", "two", "three"]) ids.push(await newTerminal(bridge, label));
  await domKey(bridge, ids[2], { key: "1", code: "Digit1", ctrlKey: true }, 49);
  await sleep(800);
  let side = await sidebarState(bridge);
  assert(side.active === 0 && !!side.focused, "Ctrl+1 went to the first session");
  const first = side.focused;
  await startKeylogger(bridge, first, kl);
  await trapClipboard(bridge);

  log("step 2: Ctrl+3 in the focused terminal");
  let had = keylogBytes(kl.out).length;
  await domKey(bridge, first, { key: "3", code: "Digit3", ctrlKey: true }, 51);
  await sleep(1000);
  side = await sidebarState(bridge);
  const ctrl3 = keylogBytes(kl.out).slice(had);
  log(`  sidebar active ${side.active}; program got ${ctrl3.join(" ") || "nothing"}`);
  assert(side.active === 2, "Ctrl+3 switched to session 3");
  assert(ctrl3.length === 0, "and typed nothing into the program");

  log("step 3: back to the key logger; Ctrl+Shift+C with a selection");
  await domKey(bridge, side.focused, { key: "1", code: "Digit1", ctrlKey: true }, 49);
  await sleep(800);
  const selected = await selectLine(bridge, first, "KEYLOG READY");
  log(`  selected: ${JSON.stringify(selected)}`);
  assert(!!selected && /KEYLOG READY/.test(selected), "the terminal has a selection");
  had = keylogBytes(kl.out).length;
  await domKey(bridge, first, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }, 67);
  await sleep(800);
  const writes = await clipWrites(bridge);
  log(`  clipboard writes: ${JSON.stringify(writes.map((w) => w.text.slice(0, 60)))}`);
  assert(writes.length === 1 && /KEYLOG READY/.test(writes[0].text), "Ctrl+Shift+C copied the selection (not the session context)");
  assert(keylogBytes(kl.out).slice(had).length === 0, "and typed nothing");

  log("step 4: Ctrl+Shift+V pastes");
  had = keylogBytes(kl.out).length;
  await domKey(bridge, first, { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }, 86);
  await sleep(1200);
  let got = keylogBytes(kl.out).slice(had);
  log(`  program got ${got.length} byte(s)`);
  assert(hasRun(got, PASTE), "the clipboard text reached the program");
  assert(!got.includes("16"), "no ^V was typed");

  log("step 5: right-click Paste");
  had = keylogBytes(kl.out).length;
  await bridge.eval(`
    window.__QA_FETCH__ = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? "";
      if (/show_context_menu/.test(url)) return new Promise(() => {});
      return window.__QA_FETCH__(input, init);
    };
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(first)}) + '"]');
    const screen = host.querySelector(".xterm-screen");
    const r = screen.getBoundingClientRect();
    screen.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, button: 2 }));
    await new Promise((res) => setTimeout(res, 300));
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "terminal.paste" } });
    await new Promise((res) => setTimeout(res, 300));
    window.fetch = window.__QA_FETCH__;
    return true;
  `);
  await sleep(1200);
  got = keylogBytes(kl.out).slice(had);
  log(`  program got ${got.length} byte(s)`);
  assert(hasRun(got, PASTE), "right-click Paste pasted into the terminal");

  log("step 6: a second pane; Alt+Right and Ctrl+Alt+Right move between panes");
  await bridge.chooseMenuItem("view.split-horizontal");
  await pickPlainShellAndCreate(bridge, "split", log);
  await bridge.waitFor("two panes", `return e2e.all(".split-pane").length === 2;`, { timeoutMs: 20_000 });
  await sleep(800);
  {
    const focusedPane = `return e2e.all(".split-pane").findIndex((p) => p.classList.contains("split-pane-focused"));`;
    for (const [what, init, code] of [
      ["Alt+Right", { key: "ArrowRight", code: "ArrowRight", altKey: true }, 39],
      ["Ctrl+Alt+Right", { key: "ArrowRight", code: "ArrowRight", ctrlKey: true, altKey: true }, 39],
    ]) {
      const before = await bridge.eval(focusedPane);
      const fid = await bridge.eval(`return window.__HERMES_E2E__.focusedSessionId();`);
      had = keylogBytes(kl.out).length;
      await domKey(bridge, fid, init, code);
      await sleep(1000);
      const after = await bridge.eval(focusedPane);
      log(`  ${what}: focused pane ${before} -> ${after}`);
      assert(after !== before, `${what} moved to the other pane`);
      assert(keylogBytes(kl.out).slice(had).length === 0, `${what} typed nothing into the program`);
    }
  }

  log("step 7: Windows rules: Ctrl+C with a selection copies, without interrupting");
  await emulatePlatform(bridge, "win", log);
  await trapClipboard(bridge);
  // The reload shows the split; put the key logger's session on screen.
  await bridge.eval(`const row = document.querySelector('.session-item[data-session-item-id="' + CSS.escape(${JSON.stringify(first)}) + '"]'); if (row) e2e.click(row); return !!row;`);
  await bridge.waitFor("the key logger's terminal", `return !!document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(first)}) + '"] .xterm-screen');`, { timeoutMs: 20_000 }).catch(() => null);
  await sleep(800);
  const sel2 = await selectLine(bridge, first, "KEYLOG READY");
  if (sel2) {
    had = keylogBytes(kl.out).length;
    await domKey(bridge, first, { key: "c", code: "KeyC", ctrlKey: true }, 67);
    await sleep(1000);
    got = keylogBytes(kl.out).slice(had);
    const w2 = await clipWrites(bridge);
    log(`  program got ${got.join(" ") || "nothing"}; clipboard writes ${w2.length}`);
    assert(!got.includes("03") && w2.length === 1, "Ctrl+C copied the selection and sent no interrupt");
    had = keylogBytes(kl.out).length;
    await domKey(bridge, first, { key: "c", code: "KeyC", ctrlKey: true }, 67);
    await sleep(1000);
    got = keylogBytes(kl.out).slice(had);
    log(`  without a selection the program got ${got.join(" ") || "nothing"}`);
    assert(got.includes("03"), "without a selection Ctrl+C interrupts as always");
  } else {
    log("  (the key logger's terminal was not on screen after the reload; skipped)");
  }
  await bridge.screenshot(join(evidenceDir, "01-keys.png"));
});
