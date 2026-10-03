#!/usr/bin/env node
// Scenario (README claim "prompt-composer"): build a structured prompt in
// the Prompt Composer (a template, a task, a scope) and send it to the
// program running in the session.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/prompt-composer.mjs
//
//   1. a plain terminal running a stand-in for an agent: a program that
//      records every byte the terminal hands it (fixtures/keylogger.mjs)
//   2. open the Prompt Composer from the command palette (type to find it)
//   3. pick the "Root Cause Analysis" template, write a task and a scope.
//      EXPECT: the preview shows the task, the scope and the template's
//      constraints, each under its own heading
//   4. Send. EXPECT: the composer closes, and the program received exactly
//      that prompt as one paste, followed by Enter

import { platform } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { launchApp, sleep } from "../harness.mjs";
import { typeInto } from "../launcher-steps.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";
import { installKeylogger, keylogBytes, startKeylogger } from "../qa-host-steps.mjs";
import { menuAction } from "../qa-launcher-steps.mjs";

const SCENARIO = "prompt-composer";
const TASK = "Find why the nightly export drops the last row of every page";
const SCOPE = "src/export only";
const TEMPLATE = "Root Cause Analysis";
// Part of that template's constraints (src/lib/templates.ts).
const TEMPLATE_TEXT = "Identify the root cause before proposing fixes.";

/** What the program received so far, as text. */
const received = (kl) => Buffer.from(keylogBytes(kl.out).map((h) => parseInt(h, 16))).toString("utf8");

await runScenario(SCENARIO, async ({ log, assert, apps, evidenceDir, onCleanup }) => {
  log("step 1: a plain terminal running a program that records what it is sent");
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;
  const kl = installKeylogger();
  onCleanup(() => rmSync(kl.dir, { recursive: true, force: true }));
  await completeOnboarding(bridge, log);
  const id = await createPlainTerminal(bridge, log);
  await startKeylogger(bridge, id, kl);
  const before = received(kl);

  log("step 2: open the Prompt Composer from the command palette");
  await menuAction(bridge, "view.command-palette");
  await bridge.waitFor("the command palette", `return !!e2e.first(".command-palette-input");`);
  await typeInto(bridge, ".command-palette-input", "prompt comp");
  const hits = await bridge.waitFor("palette results", `
    const hits = e2e.all(".command-palette-item").map((e) => e2e.norm(e.innerText));
    return hits.length ? hits : null;
  `);
  log(`  palette "prompt comp": ${JSON.stringify(hits)}`);
  assert(hits.some((h) => h.startsWith("Prompt Composer")), "the palette finds Prompt Composer");
  await bridge.clickWhenReady(`
    const item = e2e.all(".command-palette-item").find((e) => e2e.norm(e.innerText).startsWith("Prompt Composer"));
    return e2e.click(e2e.must(item, "the Prompt Composer item"));
  `);
  await bridge.waitFor("the Prompt Composer", `return !!e2e.first(".prompt-composer");`);
  assert(!(await bridge.exists(".command-palette-input")), "the palette closed and the composer opened");

  log(`step 3: pick the "${TEMPLATE}" template, write a task and a scope`);
  await bridge.click(".prompt-composer .template-picker-btn");
  await bridge.clickWhenReady(`
    const item = e2e.all(".template-picker-item").find((e) => e2e.norm(e.querySelector(".template-picker-item-name")?.innerText ?? "") === ${JSON.stringify(TEMPLATE)});
    return e2e.click(e2e.must(item, "the template"));
  `);
  await sleep(300);
  const textareas = await bridge.eval(`return e2e.all(".prompt-composer-field textarea").map((t) => t.placeholder);`);
  log(`  fields: ${JSON.stringify(textareas)}`);
  await bridge.eval(`
    const [task, scope] = e2e.all(".prompt-composer-field textarea");
    const set = (el, value) => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(e2e.must(task, "the task field"), ${JSON.stringify(TASK)});
    set(e2e.must(scope, "the scope field"), ${JSON.stringify(SCOPE)});
    return true;
  `);
  const preview = await bridge.waitFor("the preview to show the task", `
    const p = e2e.first(".prompt-composer-preview-content")?.innerText ?? "";
    return p.includes(${JSON.stringify(TASK)}) ? p : null;
  `);
  log(`  preview:\n${preview}`);
  assert(preview.includes(`**Task:** ${TASK}`), "the preview has the task under its heading");
  assert(preview.includes(`**Scope:** ${SCOPE}`), "and the scope");
  assert(preview.includes(`**Constraints:** ${TEMPLATE_TEXT}`), "and the template's constraints");
  await bridge.screenshot(join(evidenceDir, "01-composer.png"));
  assert(received(kl) === before, "nothing is sent while the prompt is being built");

  log("step 4: Send");
  await bridge.click(".prompt-composer .prompt-composer-btn-send");
  await bridge.waitFor("the composer to close", `return !e2e.first(".prompt-composer");`);
  const expected = preview.replace(/\r\n?/g, "\n").trim();
  const got = await (async () => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const text = received(kl).slice(before.length);
      if (text.includes("\x1b[201~") || text.replace(/\r\n?/g, "\n").includes(`${TASK}`) && /\r$/.test(text)) return text;
      await sleep(200);
    }
    return received(kl).slice(before.length);
  })();
  log(`  the program received ${got.length} characters: ${JSON.stringify(got.slice(0, 160))}…`);
  const start = got.indexOf("\x1b[200~");
  const end = got.indexOf("\x1b[201~");
  let pasted;
  let after;
  if (platform() === "win32" && start < 0) {
    // The Windows console hands a program in raw mode the pasted text as
    // key presses, without the paste markers around it.
    log("  (no paste markers on Windows: checking the text and the Enter)");
    pasted = got.replace(/\r$/, "").replace(/\r\n?/g, "\n");
    after = got.endsWith("\r") ? "\r" : "";
  } else {
    assert(start >= 0 && end > start, "the prompt arrived as one paste");
    pasted = got.slice(start + 6, end).replace(/\r\n?/g, "\n");
    after = got.slice(end + 6);
  }
  assert(pasted.trim() === expected, "what the program got is exactly the prompt the preview showed");
  assert(pasted.includes(`**Task:** ${TASK}`) && pasted.includes(`**Scope:** ${SCOPE}`) && pasted.includes(TEMPLATE_TEXT), "with the task, the scope and the template's text");
  assert(after.startsWith("\r"), "followed by Enter, which submits it");
  await bridge.screenshot(join(evidenceDir, "02-sent.png"));
});
