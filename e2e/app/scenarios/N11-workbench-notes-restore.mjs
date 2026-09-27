#!/usr/bin/env node
// Scenario (N11): the Workbench layout and a session's notes survive a
// restart.
//
// A user opens an Agent-view session, switches the Workbench to the Git tab,
// drags the Files/Notes divider, writes a note, closes the window, and opens
// Hermes again. The same tab, divider position and note must be back.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N11-workbench-notes-restore.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { launchApp, sleep } from "../harness.mjs";
import { closeWindow, completeOnboarding, createAgentSession, dismissWhatsNew, runScenario } from "../n11-steps.mjs";

const NOTE = "N11 restore check: run the migration, then deploy.";

// Workbench state as the user sees it.
const READ_WORKBENCH = `
  const panel = e2e.first(".workbench-panel");
  if (!panel) return null;
  // textContent: the tabs are upper-cased by CSS only.
  const selected = e2e.all('.workbench-tab[aria-selected="true"]', panel).map((t) => t.textContent.trim());
  const split = panel.querySelector(".workbench-split");
  const notes = panel.querySelector(".workbench-notes-textarea");
  return {
    tab: selected[0] ?? null,
    split: split ? Number(split.getAttribute("aria-valuenow")) : null,
    note: notes ? notes.value : null,
  };
`;

await runScenario("N11-workbench-notes-restore", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  // One private home + data folder shared by both launches.
  const shared = mkdtempSync(join(tmpdir(), "hermes-e2e-"));
  onCleanup(() => {
    if (basename(shared).startsWith("hermes-e2e-")) rmSync(shared, { recursive: true, force: true });
  });
  {
    // ── 1. First launch ────────────────────────────────────────────
    log("step 1: launch the test app");
    const first = await launchApp({ runDir: join(evidenceDir, "run-1"), log, homeDir: join(shared, "home") });
    apps.push(first);
    const b1 = first.bridge;
    await completeOnboarding(b1, log);

    // ── 2. Agent session with a customised Workbench ───────────────
    log("step 2: create an Agent-view session and customise its Workbench");
    await createAgentSession(b1, log);
    await b1.waitFor("the Workbench panel", `return !!e2e.first(".workbench-panel");`, { timeoutMs: 20_000 });
    const initial = await b1.eval(READ_WORKBENCH);
    log(`  Workbench before changes: ${JSON.stringify(initial)}`);
    assert(initial.tab === "Files" && initial.note === "", "a new Workbench starts on Files with an empty note");

    await b1.clickByName("Git", { within: ".workbench-tabs" });
    await b1.waitFor("the Git tab to be selected", `
      return e2e.first('.workbench-tab[aria-selected="true"]')?.textContent.trim() === "Git";
    `);

    // Drag the Files/Notes divider up by a third of the panel's height.
    const dragged = await b1.eval(`
      const panel = e2e.first(".workbench-panel");
      const handle = e2e.must(e2e.first(".workbench-split", panel), "Files/Notes divider");
      const r = handle.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const to = y - panel.getBoundingClientRect().height / 3;
      const ev = (type, clientY) => new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
        pointerId: 1, isPrimary: true, clientX: x, clientY,
      });
      handle.dispatchEvent(ev("pointerdown", y));
      for (let i = 1; i <= 10; i++) {
        window.dispatchEvent(ev("pointermove", y + ((to - y) * i) / 10));
        await new Promise((res) => requestAnimationFrame(res));
      }
      window.dispatchEvent(ev("pointerup", to));
      await new Promise((res) => setTimeout(res, 100));
      return Number(handle.getAttribute("aria-valuenow"));
    `);
    log(`  divider moved: files share ${initial.split}% -> ${dragged}%`);
    assert(dragged < initial.split - 5, "dragging the divider changed the Files/Notes split");

    // Type the note. The textarea is a controlled React input, so set the
    // value and fire the same input event the browser fires for typing.
    await b1.eval(`
      const ta = e2e.must(e2e.first(".workbench-notes-textarea"), "notes box");
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(NOTE)});
      ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(NOTE)} }));
      return true;
    `);
    const before = await b1.waitFor("the note to be in the Workbench", `
      const s = (() => { ${READ_WORKBENCH} })();
      return s && s.note === ${JSON.stringify(NOTE)} ? s : null;
    `);
    log(`  Workbench before restart: ${JSON.stringify(before)}`);
    await sleep(500);
    await b1.screenshot(join(evidenceDir, "01-before-restart.png"));

    // ── 3. Close the window (like the user quitting) ───────────────
    log("step 3: close the window");
    const closed = await closeWindow(first, log);
    assert(closed, "the app exited after its window was closed");

    // ── 4. Second launch on the same data ──────────────────────────
    log("step 4: launch the app again on the same home and data folder");
    const second = await launchApp({ runDir: join(evidenceDir, "run-2"), log, homeDir: join(shared, "home") });
    apps.push(second);
    const b2 = second.bridge;
    await dismissWhatsNew(b2, log);
    assert(!(await b2.exists(".onboarding-dialog")), "the welcome screens do not come back (same data folder)");
    await b2.waitFor("the restored session in the session list", `return e2e.all(".session-item").length === 1;`, {
      timeoutMs: 30_000,
    });
    const after = await b2.waitFor("the restored Workbench", `
      const s = (() => { ${READ_WORKBENCH} })();
      return s && s.note !== null ? s : null;
    `, { timeoutMs: 30_000 });
    log(`  Workbench after restart:  ${JSON.stringify(after)}`);
    await sleep(500);
    await b2.screenshot(join(evidenceDir, "02-after-restart.png"));

    assert(after.tab === "Git", "the Workbench reopened on the Git tab");
    assert(after.split === before.split, `the Files/Notes split is back at ${before.split}%`);
    assert(after.note === NOTE, `the session's note is back: "${after.note}"`);

    const exit = await second.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    assert(!exit.forced && exit.code === 0, "the app quit cleanly");
  }
});
