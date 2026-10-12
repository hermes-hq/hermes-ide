#!/usr/bin/env node
// QA-launcher-new-project-folder: ⌘N makes a new project folder, the IDE's
// "New Project", on the REAL app with fake agents.
//
//   1. The project menu's New folder… opens a form: a name, where it goes
//      and what it starts with (git, .gitignore and AGENTS.md on, README
//      off). Create makes the folder at once with exactly that, CLAUDE.md
//      importing AGENTS.md, and picks it as the launcher's project.
//   2. A name that already exists there is refused with a reason, and the
//      existing folder is left as it was.
//   3. Launch starts the agent in the new folder, the session's project.
//
// Negative control: a build before the change has no New folder… button, so
// step 1 fails at once.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invoke, launcherState, newTerminals, openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-new-project-folder", async ({ bridge, fx, log, check, assert, evidenceDir }) => {
  const parent = join(fx.work, "projects");
  mkdirSync(join(parent, "taken"), { recursive: true });
  writeFileSync(join(parent, "taken", "keep.txt"), "mine\n");
  const folder = join(parent, "fresh-app");

  const openForm = async () => {
    await bridge.clickWhenReady(`
      if (e2e.first(".task-launcher-new-folder")) return true;
      return e2e.click(e2e.must(e2e.first('[data-chip="project"]'), "the project chip"));
    `);
    await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".task-launcher-new-folder"), "New folder…"));`);
    await bridge.waitFor("the New folder form", `return !!e2e.first(".new-folder-form .new-folder-name");`);
  };
  const formState = () =>
    bridge.eval(`
      const box = (c) => e2e.first(".new-folder-form ." + c + " input");
      return {
        parent: e2e.first(".new-folder-parent")?.value ?? null,
        git: box("new-folder-git")?.checked, gitignore: box("new-folder-gitignore")?.checked,
        agents: box("new-folder-agents")?.checked, readme: box("new-folder-readme")?.checked,
        error: e2e.norm(e2e.first(".new-folder-error")?.innerText ?? ""),
      };
    `);

  // ── 1. New folder… ─────────────────────────────────────────────────
  log("step 1: ⌘N, the project menu's New folder…");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Set up the app");
  await openForm();
  const f0 = await formState();
  log(`  form: ${JSON.stringify(f0)}`);
  check(f0.git === true && f0.gitignore === true && f0.agents === true && f0.readme === false, "git, .gitignore and AGENTS.md start on, README off");
  await typeInto(bridge, ".new-folder-parent", parent);

  // ── 2. A name that exists is refused ───────────────────────────────
  log("step 2: a folder that already exists");
  await typeInto(bridge, ".new-folder-name", "taken");
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".new-folder-create"), "Create folder"));`);
  await bridge.waitFor("the reason", `return !!e2e.first(".new-folder-error");`, { timeoutMs: 15_000 });
  const f1 = await formState();
  log(`  refused: ${JSON.stringify(f1.error)}`);
  check(/already exists/.test(f1.error), "it says the folder already exists");
  check(JSON.stringify(readdirSync(join(parent, "taken"))) === JSON.stringify(["keep.txt"]), "the existing folder is untouched");

  log("step 1 (cont.): create fresh-app");
  await typeInto(bridge, ".new-folder-name", "fresh-app");
  await bridge.screenshot(join(evidenceDir, "00-new-folder-form.png"));
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".new-folder-create"), "Create folder"));`);
  await bridge.waitFor("the form to close", `return !e2e.first(".new-folder-form");`, { timeoutMs: 20_000 });
  await bridge.screenshot(join(evidenceDir, "01-new-folder-picked.png"));
  const made = existsSync(folder) ? readdirSync(folder).sort() : null;
  log(`  ${folder}: ${JSON.stringify(made)}`);
  assert(made !== null, "the folder was made");
  check(JSON.stringify(made) === JSON.stringify([".git", ".gitignore", "AGENTS.md", "CLAUDE.md"]), "it holds a repository, .gitignore, AGENTS.md and CLAUDE.md, nothing else");
  check(readFileSync(join(folder, "AGENTS.md"), "utf8").startsWith("# fresh-app\n"), "AGENTS.md is titled with the project's name");
  check(readFileSync(join(folder, "CLAUDE.md"), "utf8") === "@AGENTS.md\n", "CLAUDE.md imports AGENTS.md");
  const st = await launcherState(bridge);
  log(`  launcher: project=${JSON.stringify(st.project)} where=${JSON.stringify(st.where)} blocks=${JSON.stringify(st.blocks)} preview=${JSON.stringify(st.preview)}`);
  check(st.project.includes("fresh-app"), "the new folder is the launcher's project");

  // ── 3. Launch ──────────────────────────────────────────────────────
  log("step 3: Launch");
  await waitLaunchEnabled(bridge);
  const before = fx.records().length;
  const terms = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await newTerminals(bridge, terms, 1, "the agent's terminal");
  const all = await fx.waitForRecords(before + 1);
  const r = all[all.length - 1];
  log(`  record: ${JSON.stringify({ cwd: r.cwd })}`);
  check(fx.samePath(r.cwd, folder), "the agent runs in the new folder");
  const session = (await invoke(bridge, "get_sessions")).find((s) => fx.samePath(s.working_directory, folder)) ?? null;
  check(!!session, "the session's working folder is the new folder");
  await bridge.screenshot(join(evidenceDir, "02-launched.png"));
});
