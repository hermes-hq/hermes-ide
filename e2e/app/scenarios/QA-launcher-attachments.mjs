#!/usr/bin/env node
// QA-launcher-attachments: files and images attached in the task launcher
// reach the agent — on the REAL app, with fake agents.
//
//   1. A screenshot pasted into the task field becomes a chip (with its
//      preview) and the text is left as typed; the image is saved by the app.
//   2. A file dropped on the launcher (a path with a space in it) becomes a
//      chip too, and no terminal behind the launcher gets its path typed.
//   3. Launch: the agent's first prompt is the task followed by both paths;
//      the saved image holds exactly the pasted bytes.
//
// Negative control: a build before the feature has no chip after the paste,
// so step 1 fails at once.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLauncher, pressKey, setRepo, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa } from "../qa-launcher-steps.mjs";

// A real 1×1 PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TASK = "Make the page match the screenshot";

await runLauncherQa("QA-launcher-attachments", async ({ bridge, fx, log, check, assert, evidenceDir }) => {
  const docs = join(fx.work, "design docs");
  mkdirSync(docs, { recursive: true });
  const spec = join(docs, "login spec.md");
  writeFileSync(spec, "# Login\nThe button is blue.\n");

  const chips = () => bridge.eval(`return e2e.all(".task-launcher-attachment-body").map((el) => ({ path: el.dataset.path, image: el.dataset.image, text: e2e.norm(el.innerText), thumb: !!el.querySelector("img[src^='blob:']") }));`);

  // A terminal behind the launcher: a drop on the launcher must not type into it.
  const behind = await bridge.eval(`return await window.__HERMES_E2E__.newTerminal({ label: "Behind" });`, { timeoutMs: 30_000 });
  await bridge.waitFor("the terminal's prompt", `return (window.__HERMES_E2E__.readTerminal(${JSON.stringify(behind)}) || []).some((l) => l.trim().length > 0);`, { timeoutMs: 30_000 });

  log("step 1: paste a screenshot into the task field");
  await openLauncher(bridge);
  await setRepo(bridge, fx.repo);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await bridge.eval(`
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (c) => c.charCodeAt(0));
    const file = new File([bytes], "image.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [file], types: ["Files"], getData: () => "" } });
    e2e.must(e2e.first(".task-launcher-task"), "the task field").dispatchEvent(paste);
    return true;`);
  await bridge.waitFor("the pasted image's chip", `return e2e.all(".task-launcher-attachment-body").length === 1;`, { timeoutMs: 10_000 }).catch(() => {});
  await bridge.waitFor("its preview", `return !!e2e.first(".task-launcher-attachment-thumb[src^='blob:']");`, { timeoutMs: 10_000 }).catch(() => {});
  let now = await chips();
  log(`  chips: ${JSON.stringify(now)}`);
  assert(now.length === 1 && now[0].image === "true" && now[0].text === "pasted-image-1.png", "the pasted screenshot is a chip named pasted-image-1.png");
  check(now[0].thumb, "the chip shows the image's preview");
  const saved = now[0].path;
  check(existsSync(saved), `the app saved the pasted image (${saved})`);
  check((await bridge.eval(`return e2e.first(".task-launcher-task").value;`)) === TASK, "the task text is left as typed");

  log("step 2: drop a file on the launcher");
  await bridge.eval(`
    // A point on the launcher that is also over the terminal pane behind it.
    const row = e2e.must(e2e.first(".task-launcher-attachments"), "the attachments row").getBoundingClientRect();
    const pane = e2e.must(e2e.first(".split-pane"), "the terminal pane").getBoundingClientRect();
    const x = Math.max(row.left, pane.left) + 30;
    if (x > row.right || x > pane.right) throw new Error("no point on the launcher over the pane");
    const dpr = window.devicePixelRatio || 1;
    const position = { x: x * dpr, y: (row.top + row.height / 2) * dpr };
    const target = { kind: "AnyLabel", label: "main" };
    const send = (event, payload) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", { target, event, payload });
    await send("tauri://drag-enter", { paths: [${JSON.stringify(spec)}], position });
    await send("tauri://drag-over", { position });
    await send("tauri://drag-drop", { paths: [${JSON.stringify(spec)}], position });
    return true;`);
  await bridge.waitFor("the dropped file's chip", `return e2e.all(".task-launcher-attachment-body").length === 2;`, { timeoutMs: 10_000 }).catch(() => {});
  now = await chips();
  log(`  chips: ${JSON.stringify(now)}`);
  assert(now.length === 2 && fx.samePath(now[1].path, spec) && now[1].text === "login spec.md", "the dropped file is a chip, named where it is");
  await bridge.screenshot(join(evidenceDir, "01-attachments.png"));
  await new Promise((r) => setTimeout(r, 1000)); // a path typed into the terminal shows within this
  const behindText = ((await bridge.eval(`return window.__HERMES_E2E__.readTerminal(${JSON.stringify(behind)}) || [];`)) ?? []).join("\n");
  check(!behindText.includes("login spec"), "the terminal behind the launcher did not get the dropped path");

  log("step 3: launch");
  await waitLaunchEnabled(bridge);
  const before = fx.records().length;
  await pressKey(bridge, ".task-launcher-task", "Enter");
  await waitLauncherClosed(bridge);
  const all = await fx.waitForRecords(before + 1);
  const argv = (all[all.length - 1].argv ?? []).join("\n");
  log(`  agent argv: ${JSON.stringify(argv).slice(0, 600)}`);
  check(argv.includes(TASK), "the first prompt has the task");
  check(argv.includes("Attached files (read them):"), "the first prompt says files are attached");
  check(argv.includes(saved), "the first prompt names the saved screenshot");
  check(argv.includes(spec), "the first prompt names the dropped file, space and all");
  check(argv.indexOf(TASK) < argv.indexOf(saved), "the paths come after the task");
  check(readFileSync(saved).equals(Buffer.from(PNG_BASE64, "base64")), "the saved image holds exactly the pasted bytes");
});
