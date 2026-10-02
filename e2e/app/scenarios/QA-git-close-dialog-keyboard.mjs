#!/usr/bin/env node
// QA-git (NEWCOMER-01): "Close session?" is a real modal dialog, and Enter
// never closes the session while Cancel has focus.
//
// A task runs on the current checkout (nothing to ask about its files), so
// the × shows the close confirmation. It is an alertdialog (aria-modal,
// labelled by its title "Close “<label>”?", described by "<agent> is still
// running in it. Closing stops it."), the confirm button has focus, Tab stays
// inside, Enter on the focused Cancel closes nothing, Escape cancels and
// focus goes back to the × that opened it.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (a
// window-wide Enter handler confirmed the close).

import { join } from "node:path";
import { L, endScenario, gitFixtures, launchTask, scenarioContext, sessionLabel, showSessionsPanel, sleep } from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-close-dialog-keyboard";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("closekeys", log);

const key = (bridge, k, opts = {}) =>
  bridge.eval(`const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, code: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(opts)} })); return true;`);

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  await L.completeTaskWelcome(bridge, fx.repo);
  const r = await launchTask(bridge, { task: "Read the docs", where: "current-checkout", log });
  const label = await sessionLabel(bridge, r.sessionId);
  await showSessionsPanel(bridge);
  const openDialog = async () => {
    await bridge.clickWhenReady(`
      const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
      const b = e2e.must(item && item.querySelector(".session-item-close"), "×");
      b.focus();
      return e2e.click(b);
    `);
    await bridge.waitFor("the close confirmation", `return !!e2e.first(".close-dialog");`);
    await sleep(300);
  };

  log("step 1: the × opens the confirmation");
  await openDialog();
  await bridge.screenshot(join(evidenceDir, "01-close-dialog.png"));
  const sem = await bridge.eval(`
    const d = e2e.first(".close-dialog");
    const by = (attr) => { const id = d.getAttribute(attr); const el = id && document.getElementById(id); return el ? e2e.norm(el.innerText) : null; };
    return { role: d.getAttribute("role"), modal: d.getAttribute("aria-modal"), title: by("aria-labelledby"), body: by("aria-describedby"),
      focus: document.activeElement?.className ?? "" };
  `);
  log(`  semantics: ${JSON.stringify(sem)}`);
  check(sem.role === "alertdialog" && sem.modal === "true", "it is announced as a modal alert dialog");
  check(sem.title === `Close “${label}”?`, `the title names the session (${sem.title})`);
  check(/is still running in it\. Closing stops it\.$/.test(sem.body ?? ""), `the body says what closing stops (${sem.body})`);
  check(/close-dialog-btn-confirm/.test(sem.focus), "the confirm button has focus");

  log("step 2: Tab stays inside");
  for (let i = 0; i < 4; i++) await key(bridge, "Tab");
  check(await bridge.eval(`return e2e.first(".close-dialog").contains(document.activeElement);`), "focus is still inside after four Tabs");
  await key(bridge, "Tab", { shiftKey: true });
  check(await bridge.eval(`return e2e.first(".close-dialog").contains(document.activeElement);`), "and after Shift+Tab");

  log("step 3: Enter on the focused Cancel");
  await bridge.eval(`const c = e2e.first(".close-dialog .close-dialog-btn"); c.focus(); c.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })); return true;`);
  await sleep(1500);
  check((await bridge.terminalIds()).includes(r.sessionId), "Enter on Cancel keeps the session");

  log("step 4: Escape cancels and gives focus back to the ×");
  if (!(await bridge.exists(".close-dialog"))) await openDialog();
  await key(bridge, "Escape");
  await sleep(500);
  check(!(await bridge.exists(".close-dialog")), "Escape closes the confirmation");
  check((await bridge.terminalIds()).includes(r.sessionId), "the session is still open");
  check(await bridge.eval(`return !!document.activeElement?.classList.contains("session-item-close");`), "focus is back on the × that opened it");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
