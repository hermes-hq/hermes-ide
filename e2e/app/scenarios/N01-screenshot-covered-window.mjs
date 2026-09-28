#!/usr/bin/env node
// Scenario: a screenshot shows the window it was asked for, even when another
// test app covers it, and a window that shows one flat colour is still
// refused.
//
// On the Linux runner every test app opens at the same spot of a virtual
// display with no window manager, so the app started last covers the first.
// Reading the covered window's pixels used to give black ("the capture is
// one flat colour"). The app now raises the window and has it repaint before
// each capture, and takes a flat capture again a few times.
//
//   1. Start app A and mark the left half of its page magenta.
//   2. Start app B next to it (it covers A) and mark its left half cyan.
//   3. Several rounds of: give A's and B's marks a colour of their own for
//      this round (each page draws it before the next step), then screenshot
//      A, then B. A's picture must show A's colour of this round and B's
//      picture B's, at 40 points spread over the left half — never black,
//      never the other app, never a colour from an earlier round, and never
//      torn rows of old and new pixels (what a covered window that was not
//      repainted gave on the Linux runner). B's screenshot raises B over A again, so every
//      round starts with A covered.
//   4. macOS only: cover all of A's page with one colour; the screenshot
//      must still be refused as a flat colour (the retries do not weaken
//      that check). On Windows and Linux the capture includes the window's
//      native title and menu bar, which a page cannot paint over, so there
//      the refusal is proven by the unit tests of e2e_evidence.rs and
//      harness.test.mjs instead.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N01-screenshot-covered-window.mjs

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, pngPixels } from "../harness.mjs";

const SCENARIO = "N01-screenshot-covered-window";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

const MAGENTA = "#ff00ff";
const CYAN = "#00ffff";
// A colour per round for each app; no two alike, none near the app's own
// dark background, so a stale or wrong picture never matches by accident.
// Round 1 already differs from the steps 1-2 colours.
const A_COLOURS = ["#ffff00", "#ff0000", "#ff8000", "#ff80c0", "#808000", "#ff00ff"];
const B_COLOURS = ["#00ff00", "#0000ff", "#8000ff", "#80c0ff", "#008080", "#00ffff"];
const ROUNDS = 12;

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** Close enough to `want` that colour management cannot explain the gap. */
function near(got, want) {
  const ch = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = ch(got);
  const b = ch(want);
  return a.every((v, i) => Math.abs(v - b[i]) <= 24);
}

/**
 * Paint the left half of the page (or all of it) one colour, above
 * everything, and give the page a moment to draw it.
 */
function mark(bridge, colour, { whole = false } = {}) {
  return bridge.eval(`
    let el = document.getElementById("n01-marker");
    if (!el) {
      el = document.createElement("div");
      el.id = "n01-marker";
      document.body.appendChild(el);
    }
    el.style.cssText = "position:fixed;left:0;top:0;height:100vh;z-index:2147483647;pointer-events:none;"
      + "width:${whole ? "100vw" : "50vw"};background:${colour};";
    // A covered window may not be given frames; the screenshot is what must
    // bring it forward and repaint it, so do not wait for ever here.
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    return true;
  `);
}

/**
 * Points spread over the marked left half, below the native title and menu
 * bar. A covered window read before it repainted can come back as torn rows
 * of old and new pixels, so one point is not enough to tell.
 */
function gridPoints(width, height) {
  const points = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 8; j++) {
      points.push([Math.floor(width * (0.05 + 0.1 * i)), Math.floor(height * (0.2 + 0.1 * j))]);
    }
  }
  return points;
}

/**
 * Screenshot `app`; answer the first point of its left half that does not
 * show `want` ("x,y is #rrggbb"), or null when every point shows it.
 */
async function shoot(app, name, file, want) {
  const shot = await app.bridge.screenshot(join(evidenceDir, file));
  const points = gridPoints(shot.width, shot.height);
  const colours = pngPixels(shot.file, points);
  const bad = colours.findIndex((c) => !near(c, want));
  const wrong = bad < 0 ? null : `${points[bad].join(",")} is ${colours[bad]}`;
  log(
    `  ${name}: ${shot.width}x${shot.height}, taken in ${shot.attempts} attempt(s), ` +
      `${colours.filter((c) => near(c, want)).length}/${points.length} points of the left half are ${want}` +
      (wrong ? ` (${wrong})` : ""),
  );
  return wrong;
}

let failed = false;
let appA = null;
let appB = null;
const scratch = mkdtempSync(join(tmpdir(), "hermes-e2e-n01shot-"));
try {
  // Own data folders, so two apps never share one (on Windows both would
  // otherwise use the test app's data folder under the real home).
  const dataA = join(scratch, "data-a");
  const dataB = join(scratch, "data-b");
  mkdirSync(dataA);
  mkdirSync(dataB);

  log("step 1: start app A and mark the left half of its page magenta");
  appA = await launchApp({ runDir: join(evidenceDir, "run-a"), log, env: { HERMES_DATA_DIR: dataA } });
  await mark(appA.bridge, MAGENTA);

  log("step 2: start app B next to A and mark its left half cyan");
  appB = await launchApp({ runDir: join(evidenceDir, "run-b"), log, env: { HERMES_DATA_DIR: dataB } });
  await mark(appB.bridge, CYAN);

  log(`step 3: ${ROUNDS} rounds of new colours, then a screenshot of A, then of B`);
  for (let round = 1; round <= ROUNDS; round++) {
    const wantA = A_COLOURS[(round - 1) % A_COLOURS.length];
    const wantB = B_COLOURS[(round - 1) % B_COLOURS.length];
    await mark(appA.bridge, wantA);
    await mark(appB.bridge, wantB);
    const tag = String(round).padStart(2, "0");
    const a = await shoot(appA, "A", `${tag}-a.png`, wantA);
    assert(a === null, `round ${round}: A's screenshot shows A as it is now (${wantA} all over its left half${a ? `; ${a}` : ""})`);
    const b = await shoot(appB, "B", `${tag}-b.png`, wantB);
    assert(b === null, `round ${round}: B's screenshot shows B as it is now (${wantB} all over its left half${b ? `; ${b}` : ""})`);
  }

  if (platform() === "darwin") {
    log("step 4: cover all of A's page with one colour; its screenshot must be refused");
    await mark(appA.bridge, MAGENTA, { whole: true });
    let refusal = null;
    try {
      await appA.bridge.screenshot(join(evidenceDir, "flat-a.png"));
    } catch (e) {
      refusal = String(e?.message ?? e);
    }
    log(`  answer: ${refusal ?? "a screenshot was saved"}`);
    assert(refusal !== null && /one flat colour/.test(refusal), "a window showing one flat colour is refused");
    assert(/in all \d+ attempts/.test(refusal), "the app took it again before refusing it");
    await mark(appA.bridge, MAGENTA);
    const after = await shoot(appA, "A", "after-flat-a.png", MAGENTA);
    assert(after === null, "once A shows more than one colour again, its screenshot is taken");
  } else {
    log("step 4: skipped on this OS: the capture includes the native title and menu bar, so a page cannot make it one colour");
  }
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
} finally {
  for (const [name, app] of [
    ["B", appB],
    ["A", appA],
  ]) {
    if (!app) continue;
    const exit = await app.stop();
    log(`quit ${name}: ${JSON.stringify(exit)}`);
  }
  rmSync(scratch, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
