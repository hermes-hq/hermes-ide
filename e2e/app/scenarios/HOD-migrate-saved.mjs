#!/usr/bin/env node
// HOD-migrate-saved: updating from 2.0 to 2.1 keeps every prompt the person
// saved, and old ids keep working.
//
//   run 1  a fresh install saves what a 2.0 user has, through the same
//          settings the 2.0 prompt Builder writes: a custom prompt template
//          (with its own role and style), a group, pins on a built-in id
//          ("debug-root-cause") and on the custom template. The app quits;
//          its database is then put back to the 2.0.0 shape (schema 6, no
//          library tables), as a 2.0.0 install leaves it.
//   run 2  the 2.1 build opens that database: it takes a backup, adds the
//          library tables (schema 7), and
//          - every saved prompt setting is byte-identical;
//          - the Library lists the custom prompt under My templates, and its
//            text has the task, the custom role's instruction and the
//            constraint;
//          - the 2.0 built-ins are there as read-only Hermes classics, the
//            pinned "debug-root-cause" among them; an id the catalog carries
//            ("security-auditor") resolves to the library entry;
//          - the prompt Builder still lists the custom prompt under My
//            templates, and gained a Library tab.
//
// Negative control: HERMES_E2E_HOD_NEGATIVE=drop deletes the saved template
// from the database before run 2; the "kept" checks must then fail.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { invoke, libraryState, openEntry, openLibrary, typeValue } from "../library-steps.mjs";

const NAME = "HOD-migrate-saved";
const NEGATIVE = process.env.HERMES_E2E_HOD_NEGATIVE === "drop";
const DB_FILE = "hermes_idea_v3.db";

const SAVED = {
  prompt_templates: JSON.stringify([
    {
      id: "user-ship-checklist",
      name: "Ship checklist",
      description: "Before a release",
      category: "planning",
      fields: { task: "Walk through the release checklist for {{version}}", scope: "", constraints: "No new dependencies", roleIds: ["custom-role-release"], styleSelections: [] },
      recommendedRoles: ["backend-eng"],
      recommendedStyles: ["concise"],
      builtIn: false,
      group: "Release",
    },
  ]),
  custom_roles: JSON.stringify([{ id: "custom-role-release", label: "Release captain", description: "Runs releases", systemInstruction: "You run releases calmly and check every step twice.", builtIn: false }]),
  custom_styles: JSON.stringify([{ id: "custom-style-terse", label: "Terse", description: "Few words", levels: ["a", "b", "Use few words.", "d", "e"], builtIn: false }]),
  template_groups: JSON.stringify(["Release"]),
  pinned_templates: JSON.stringify(["debug-root-cause", "user-ship-checklist"]),
};

await runLauncherQa(
  NAME,
  async ({ bridge, fx, log, check, assert, evidenceDir, relaunch, current }) => {
    for (const [key, value] of Object.entries(SAVED)) await invoke(bridge, "set_setting", { key, value });
    const dataDir = current().dataDir;
    await current().stop();

    // Back to the 2.0.0 shape: schema 6, no library tables.
    const dbPath = join(dataDir, DB_FILE);
    assert(existsSync(dbPath), `the database is at ${DB_FILE}`);
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE IF EXISTS library_item_state; DROP TABLE IF EXISTS library_affinity; DROP TABLE IF EXISTS library_installs; PRAGMA user_version = 6;");
    if (NEGATIVE) db.exec("DELETE FROM settings WHERE key = 'prompt_templates';");
    db.close();
    const backupsBefore = existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")).length : 0;
    log(`  database set to schema 6 without library tables; ${backupsBefore} backups so far`);

    const app = await relaunch(2);
    const b = app.bridge;
    await b.waitFor("the app (returning launch)", `return !!e2e.first(".activity-bar") && !e2e.first(".setup-backdrop, .onboarding-backdrop");`, { timeoutMs: 30_000 });
    await sleep(500);
    const settings = await invoke(b, "get_settings");
    for (const [key, value] of Object.entries(SAVED)) check(settings[key] === value, `${key} is byte-identical after the update`);

    await openLibrary(b);
    await b.click('.lib-nav-item[data-nav="mine"]');
    await b.waitFor("My templates", `return !!e2e.first('.lib-row[data-entry="mine:user-ship-checklist"]');`, { timeoutMs: 15_000 }).catch(() => null);
    const mine = await libraryState(b);
    log(`  My templates: ${mine.rows.join(", ")}`);
    check(mine.rows.includes("mine:user-ship-checklist"), "the Library lists the custom prompt under My templates");
    if (mine.rows.includes("mine:user-ship-checklist")) {
      await openEntry(b, "mine:user-ship-checklist");
      const st = await libraryState(b);
      log(`  its text: ${JSON.stringify((st.preview ?? "").slice(0, 300))}`);
      check(
        (st.preview ?? "").includes("Walk through the release checklist") && (st.preview ?? "").includes("You run releases calmly") && (st.preview ?? "").includes("No new dependencies"),
        "with its task, its custom role's instruction and its constraint",
      );
      await b.screenshot(join(evidenceDir, "01-my-templates.png"));
    }

    await b.click('.lib-nav-item[data-nav="classics"]');
    await b.waitFor("Hermes classics", `return e2e.all('.lib-row[data-entry^="classic:"]').length > 0;`, { timeoutMs: 15_000 });
    await typeValue(b, ".lib-search-input", "root cause");
    await b.waitFor("the pinned built-in", `return !!e2e.first('.lib-row[data-entry="classic:template:debug-root-cause"]');`, { timeoutMs: 15_000 }).catch(() => null);
    const classics = await libraryState(b);
    check(classics.rows.includes("classic:template:debug-root-cause"), "the pinned built-in debug-root-cause is there as a Hermes classic");
    const resolved = await invoke(b, "library_resolve", { ids: ["debug-root-cause", "security-auditor", "user-ship-checklist", "backend-eng"] });
    log(`  library_resolve: ${JSON.stringify(resolved)}`);
    check(resolved["security-auditor"] === "security-auditor", "a built-in id the catalog carries resolves to the library entry");
    check(!resolved["user-ship-checklist"], "the person's own id is never taken over by the library");
    await b.screenshot(join(evidenceDir, "02-classics.png"));
    await b.click('[data-testid="library-view"] .lib-head > .h-close-btn');
    await b.waitFor("the Library to close", `return !e2e.first('[data-testid="library-view"]');`);

    // The prompt Builder still has it, and a Library tab.
    const term = await b.eval(`return await window.__HERMES_E2E__.newTerminal(${JSON.stringify({ label: "builder", cwd: fx.repo })});`, { timeoutMs: 30_000 });
    assert(!!term, "a terminal for the Builder");
    await sleep(800);
    await menuAction(b, "view.command-palette");
    await b.waitFor("the palette", `return !!e2e.first(".command-palette-input");`);
    await typeValue(b, ".command-palette-input", "Prompt Composer");
    await sleep(300);
    await b.clickWhenReady(`const i = e2e.all(".command-palette-item").find((e) => /Prompt Composer/.test(e.innerText)); return i ? e2e.click(i) : false;`);
    await b.waitFor("the prompt Builder", `return !!e2e.first(".prompt-composer .template-picker-btn");`, { timeoutMs: 15_000 });
    await b.click(".prompt-composer .template-picker-btn");
    await b.waitFor("the template picker", `return !!e2e.first(".template-picker-tabs");`);
    await b.clickWhenReady(`const t = e2e.all(".template-picker-tab").find((e) => /My/i.test(e.innerText)); return t ? e2e.click(t) : false;`);
    await sleep(400);
    const builder = await b.eval(`return { names: e2e.all(".template-picker-item-name").map((e) => e2e.norm(e.innerText)), libraryTab: !!e2e.first(".template-picker-library-tab") };`);
    log(`  Builder, My templates: ${JSON.stringify(builder)}`);
    await b.screenshot(join(evidenceDir, "03-builder.png"));
    check(builder.names.includes("Ship checklist"), "the prompt Builder still lists the custom prompt under My templates");
    check(builder.libraryTab, "and has a Library tab");

    await current().stop();
    const after = new DatabaseSync(dbPath, { readOnly: true });
    const version = after.prepare("PRAGMA user_version").get().user_version;
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'library_%' ORDER BY name").all().map((r) => r.name);
    const kept = Object.fromEntries(after.prepare("SELECT key, value FROM settings WHERE key IN ('prompt_templates','custom_roles','custom_styles','template_groups','pinned_templates')").all().map((r) => [r.key, r.value]));
    after.close();
    const backupsAfter = existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")).length : 0;
    log(`  after quitting: schema ${version}, library tables ${tables.join(", ")}, backups ${backupsBefore} -> ${backupsAfter}`);
    check(version === 7 && tables.length === 3, "the database is at schema 7 with the three library tables");
    check(backupsAfter === backupsBefore + 1, "one backup was taken before the update");
    check(Object.entries(SAVED).every(([k, v]) => kept[k] === v), "and every saved prompt setting is still byte-identical on disk");
  },
  { tag: "hod-migrate" },
);
