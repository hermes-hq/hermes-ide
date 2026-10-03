#!/usr/bin/env node
// Scenario (README claim "webgl-rendering"): the terminal draws with WebGL
// where the system supports it, recognises web links in its output, and
// fits itself to the window when the window changes size.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/webgl-rendering.mjs
//
//   1. a plain terminal. EXPECT: when the web view can create a WebGL2
//      context at all, the terminal on screen holds one and draws on its own
//      canvases; when it cannot (software-only display), the terminal still
//      shows its output and the log says WebGL was not available
//   2. print a https address and point the mouse at it. EXPECT: the terminal
//      treats it as a link (pointer cursor over it; not over plain text)
//   3. make the window narrower and shorter, then wider. EXPECT: the
//      terminal's columns and rows follow the window both ways

import { platform } from "node:os";
import { join } from "node:path";
import { launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";

const SCENARIO = "webgl-rendering";
const URL = "https://example.com/hermes-link-check";

const info = (bridge, id) => bridge.eval(`return window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});`);

async function resize(bridge, width, height) {
  await bridge.eval(`
    await window.__TAURI_INTERNALS__.invoke("plugin:window|set_size", { label: "main", value: { Logical: { width: ${width}, height: ${height} } } });
    return true;
  `);
  await bridge.waitFor(`the window at ${width} px`, `return innerWidth <= ${width} + 2 && innerWidth >= ${width} - 40;`, { timeoutMs: 10_000 });
  await sleep(800);
}

/**
 * The width the program in the terminal is told (it wraps by this), read
 * from the shell: PowerShell on Windows, a POSIX shell elsewhere.
 */
async function shellCols(bridge, id, tag) {
  const cmd = platform() === "win32" ? `echo "cols-${tag}=$([Console]::WindowWidth)"` : `echo cols-${tag}=$(tput cols)`;
  await bridge.typeInTerminal(id, `${cmd}\n`);
  const { line } = await bridge.waitForTerminal(id, new RegExp(`^cols-${tag}=\\d+$`), { timeoutMs: 20_000 });
  return Number(line.split("=")[1]);
}

/**
 * Move the mouse over a cell of the terminal (column, viewport row) and
 * report whether the terminal shows the link pointer there.
 */
function hoverCell(bridge, id, col, row) {
  return bridge.eval(`
    const view = e2e.must(document.querySelector('div[data-session-id=${JSON.stringify(id)}]'), "the terminal's pane");
    const screen = e2e.must(view.querySelector(".xterm-screen"), "the terminal screen");
    const { cols, rows } = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    const r = screen.getBoundingClientRect();
    const x = r.left + (${col} + 0.5) * (r.width / cols);
    const y = r.top + (${row} + 0.5) * (r.height / rows);
    for (const type of ["mouseover", "mousemove"]) {
      screen.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, view: window }));
    }
    await new Promise((done) => setTimeout(done, 400));
    // The link detector runs on a mouse move; it marks the terminal element.
    return !!view.querySelector(".xterm-cursor-pointer") || !!view.querySelector(".xterm.xterm-cursor-pointer, .xterm-screen.xterm-cursor-pointer");
  `);
}

await runScenario(SCENARIO, async ({ log, assert, apps, evidenceDir }) => {
  log("step 1: launch, open a plain terminal, see how it draws");
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);
  await resize(bridge, 1200, 800);
  const id = await createPlainTerminal(bridge, log);
  await bridge.typeInTerminal(id, "echo render-check-ok\n");
  await bridge.waitForTerminal(id, /^render-check-ok$/, { timeoutMs: 20_000 });

  // Can this web view make a WebGL2 context at all? (A software-only display
  // may have none; then the terminal is meant to fall back, not fail.)
  const system = await bridge.eval(`
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    const renderer = gl ? (gl.getParameter(gl.RENDERER) || "") : null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return { webgl2: !!gl, renderer };
  `);
  const term = await info(bridge, id);
  const gl = await bridge.eval(`return window.__HERMES_E2E__.graphicsContexts();`);
  log(`  web view WebGL2: ${system.webgl2} (${system.renderer ?? "none"}); terminal: ${JSON.stringify(term)}; contexts: ${JSON.stringify(gl)}`);
  if (system.webgl2) {
    assert(gl.available, "the app found WebGL usable");
    assert(term.webgl === true, "the terminal on screen draws with a WebGL context");
    assert(gl.sessions.includes(id), "the graphics contexts list names this terminal");
    assert(term.canvases > 0, `the WebGL renderer draws on its own canvases (${term.canvases})`);
  } else {
    log("  this display has no WebGL2: checking the fallback instead");
    assert(term.webgl === false && !gl.sessions.includes(id), "with no WebGL the terminal holds no WebGL context");
    assert(!gl.available, "and the app knows WebGL is not available here");
  }
  await bridge.screenshot(join(evidenceDir, "01-terminal.png"));

  log("step 2: print a web address and point at it");
  await bridge.typeInTerminal(id, "clear\n");
  await bridge.waitFor("the screen to clear", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || [];
    return !lines.some((l) => l.trim() === "render-check-ok");
  `, { timeoutMs: 10_000 }).catch(() => {});
  await bridge.typeInTerminal(id, `echo 'plain-words-here ${URL}'\n`);
  await bridge.waitForTerminal(id, new RegExp(`^plain-words-here ${URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`), { timeoutMs: 20_000 });
  // Where the printed line is on screen (viewport row) and where the address
  // starts. The last `rows` rows of the buffer are the screen; they are read
  // unjoined, so a command line that wraps in a narrow window (CI) cannot
  // shift the row.
  const where = await bridge.eval(`
    const { rows } = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    const screen = window.__HERMES_E2E__.terminalTail(${JSON.stringify(id)}, rows) || [];
    const index = screen.findIndex((l) => l.startsWith("plain-words-here https://"));
    return { row: index, col: index >= 0 ? screen[index].indexOf("https://") : -1, total: screen.length, rows };
  `);
  log(`  the address is on screen row ${where.row}, column ${where.col} (${where.total} lines, ${where.rows} rows)`);
  assert(where.row >= 0 && where.col > 0, "the printed line is on screen");
  const overText = await hoverCell(bridge, id, 2, where.row);
  const overLink = await hoverCell(bridge, id, where.col + 8, where.row);
  log(`  pointer over plain text: ${overText}; over the address: ${overLink}`);
  assert(overLink === true, "pointing at the address shows it as a link");
  const leaveLink = await hoverCell(bridge, id, 2, where.row);
  assert(overText === false && leaveLink === false, "plain words on the same line are not a link");
  await bridge.screenshot(join(evidenceDir, "02-link.png"));

  log("step 3: resize the window; the terminal follows");
  const big = await info(bridge, id);
  await resize(bridge, 800, 520);
  const small = await bridge.waitFor("the terminal to fit the smaller window", `
    const t = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    return t.cols < ${big.cols} && t.rows < ${big.rows} ? t : null;
  `, { timeoutMs: 10_000 });
  log(`  1200x800: ${big.cols}x${big.rows}; 800x520: ${small.cols}x${small.rows}`);
  assert(small.cols < big.cols && small.rows < big.rows, "a smaller window gives the terminal fewer columns and rows");
  assert((await shellCols(bridge, id, "small")) === small.cols, "the program in the terminal is told the smaller width");
  await bridge.screenshot(join(evidenceDir, "03-small.png"));
  await resize(bridge, 1200, 800);
  const again = await bridge.waitFor("the terminal to fit the larger window", `
    const t = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    return t.cols > ${small.cols} && t.rows > ${small.rows} ? t : null;
  `, { timeoutMs: 10_000 });
  log(`  back at 1200x800: ${again.cols}x${again.rows}`);
  assert(Math.abs(again.cols - big.cols) <= 1 && Math.abs(again.rows - big.rows) <= 1, "back at the first size, it has the columns and rows it had");
  assert((await shellCols(bridge, id, "large")) === again.cols, "and the program is told the larger width again");
});
