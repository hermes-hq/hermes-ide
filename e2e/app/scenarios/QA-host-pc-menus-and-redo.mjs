#!/usr/bin/env node
// QA-host-pc-menus-and-redo (XP-07, XP-08) — under the Windows/Linux rules:
//
//   right-click menus  show the chords that work there (Split Right is
//                      Ctrl+Shift+D: the old Ctrl+D ends the shell), and the
//                      terminal's Copy/Paste show Ctrl+Shift+C/V
//   Ctrl+Shift+Z       in a text field is the field's Redo, not Flow Mode;
//                      Flow Mode is Ctrl+Shift+Y
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { emulatePlatform, newTerminal, pickPlainShellAndCreate, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-pc-menus-and-redo";
const EXPECTED = {
  "terminal.split-right": "Ctrl+Shift+D",
  "terminal.split-down": "Ctrl+Shift+S",
  "terminal.copy": "Ctrl+Shift+C",
  "terminal.paste": "Ctrl+Shift+V",
  "pane.split-right": "Ctrl+Shift+D",
  "pane.split-down": "Ctrl+Shift+S",
  "pane.close": "Ctrl+Shift+W",
};

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { bridge } = await startApp("qa-menus", evidenceDir, log, onCleanup, apps);
  await emulatePlatform(bridge, "linux", log);
  const sid = await newTerminal(bridge, "menus");
  await bridge.chooseMenuItem("view.split-horizontal");
  await pickPlainShellAndCreate(bridge, "split", log);
  await sleep(800);

  log("step 1: the right-click menus (captured, never shown)");
  const menus = await bridge.eval(`
    const captured = [];
    const origFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? "";
      if (/show_context_menu/.test(url)) {
        try { captured.push(JSON.parse(init.body).items); } catch { captured.push([]); }
        return Promise.resolve(new Response("null", { status: 200, headers: { "Tauri-Response": "ok", "Content-Type": "application/json" } }));
      }
      return origFetch(input, init);
    };
    try {
      const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]');
      const screen = host.querySelector(".xterm-screen");
      const r = screen.getBoundingClientRect();
      screen.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, button: 2 }));
      await new Promise((res) => setTimeout(res, 300));
      host.closest(".split-pane").querySelector(".split-pane-header")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
      await new Promise((res) => setTimeout(res, 300));
    } finally {
      window.fetch = origFetch;
    }
    return captured;
  `);
  const items = menus.flat().filter((i) => i && i.id);
  for (const i of items) log(`  ${i.id.padEnd(24)} ${i.accelerator ?? "-"}`);
  assert(items.some((i) => i.id === "terminal.split-right") && items.some((i) => i.id === "pane.close"), "both menus were captured");
  const wrong = items.filter((i) => i.id in EXPECTED && i.accelerator !== EXPECTED[i.id]).map((i) => `${i.id} shows ${i.accelerator}`);
  assert(wrong.length === 0, `the menus show the chords that work here${wrong.length ? ": NOT " + wrong.join(", ") : ""}`);

  log("step 2: Ctrl+Shift+Z in the command palette's field");
  await bridge.chooseMenuItem("view.command-palette");
  await bridge.waitFor("a focused text field", `const el = document.activeElement; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.closest(".xterm");`, { timeoutMs: 10_000 });
  const press = (k, code) =>
    bridge.eval(`
      const el = document.activeElement;
      const before = document.querySelector(".app")?.classList.contains("flow-mode") ?? null;
      const ev = new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, code: ${JSON.stringify(code)}, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "keyCode", { get: () => ${JSON.stringify(k)}.charCodeAt(0) });
      const notPrevented = el.dispatchEvent(ev);
      await new Promise((res) => setTimeout(res, 600));
      const after = document.querySelector(".app")?.classList.contains("flow-mode") ?? null;
      return { before, after, defaultPrevented: !notPrevented };
    `);
  const z = await press("Z", "KeyZ");
  log(`  Ctrl+Shift+Z: ${JSON.stringify(z)}`);
  assert(z.after === z.before && !z.defaultPrevented, "Ctrl+Shift+Z is left to the field (Redo)");
  const y = await press("Y", "KeyY");
  log(`  Ctrl+Shift+Y: ${JSON.stringify(y)}`);
  await bridge.screenshot(join(evidenceDir, "01-flow-mode.png"));
  assert(y.after !== y.before, "Ctrl+Shift+Y toggles Flow Mode");
  if (y.after) await press("Y", "KeyY");
});
