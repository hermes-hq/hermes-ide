#!/usr/bin/env node
// HOD-migrate-saved: updating from 2.0 to 2.1 keeps every prompt the person
// saved, and old ids keep working.
//
//   run 1  a fresh install saves what a 2.0 user has, through the same
//          settings the 2.0 prompt Builder writes: a custom prompt template
//          (with its own role and style), an edited copy of a built-in that
//          uses built-in role and style ids ("backend-eng", "detailed"), a
//          group, pins on a built-in id ("debug-root-cause") and on the
//          custom template. The app quits; its database is then put back to
//          the 2.0.0 shape (schema 6, no library tables), as a 2.0.0 install
//          leaves it.
//   run 2  the 2.1 build opens that database: it takes a backup, adds the
//          library tables (schema 7), and
//          - every saved prompt setting is byte-identical;
//          - the Library lists the custom prompt under Mine, and its
//            text has the task, the custom role's instruction and the
//            constraint;
//          - every 2.0 built-in is a library entry now: the old ids resolve
//            through the catalog's aliases ("debug-root-cause" ->
//            "find-root-cause", "backend-eng" -> "backend-engineer",
//            "detailed" -> "thorough"), no Hermes classics are left, and the
//            pin on "debug-root-cause" is a pin on "find-root-cause";
//          - Prompts (⌘J, which replaced the Builder) is one list with a
//            Mine filter, says the 2.0 items are under Mine, lists both saved
//            templates, the custom role and the custom style there, and the
//            edited built-in's text has the library persona its old role id
//            resolves to;
//          - the 2.0 settings are never written: Mine lives in my_prompts.
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
    {
      id: "user-root-cause-copy",
      name: "Root cause, my way",
      description: "An edited copy of a 2.0 built-in",
      category: "debugging",
      fields: { task: "Find why the nightly import fails", scope: "", constraints: "Root cause first", roleIds: ["backend-eng"], styleSelections: [{ id: "detailed", level: 3 }] },
      recommendedRoles: ["backend-eng"],
      recommendedStyles: [{ id: "detailed", level: 3 }],
      builtIn: false,
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

    const resolved = await invoke(b, "library_resolve", { ids: ["debug-root-cause", "security-auditor", "user-ship-checklist", "backend-eng", "detailed"] });
    log(`  library_resolve: ${JSON.stringify(resolved)}`);
    check(resolved["debug-root-cause"] === "find-root-cause", "the built-in template id debug-root-cause resolves to its library entry find-root-cause");
    check(resolved["backend-eng"] === "backend-engineer" && resolved["detailed"] === "thorough", "built-in role and style ids resolve to library personas and styles");
    check(resolved["security-auditor"] === "security-auditor", "a built-in id the catalog carries as an id resolves to the library entry");
    check(!resolved["user-ship-checklist"], "the person's own id is never taken over by the library");
    const noClassics = await b.eval(`return !e2e.first('.lib-nav-item[data-nav="classics"]');`);
    check(noClassics, "every 2.0 built-in is a library entry: no Hermes classics are left");
    await b.click('.lib-nav-item[data-nav="pinned"]');
    await b.waitFor("the carried pin", `return !!e2e.first('.lib-row[data-entry="find-root-cause"]');`, { timeoutMs: 15_000 }).catch(() => null);
    const pins = await libraryState(b);
    log(`  Pinned: ${pins.rows.join(", ")}`);
    check(pins.rows.includes("find-root-cause"), "the 2.0 pin on debug-root-cause is a pin on its library entry find-root-cause");
    await b.screenshot(join(evidenceDir, "02-pinned.png"));
    await b.click('[data-testid="library-view"] .lib-head > .h-close-btn');
    await b.waitFor("the Library to close", `return !e2e.first('[data-testid="library-view"]');`);

    // Prompts (⌘J, the one palette that replaced the Builder) lists everything under Mine.
    const term = await b.eval(`return await window.__HERMES_E2E__.newTerminal(${JSON.stringify({ label: "builder", cwd: fx.repo })});`, { timeoutMs: 30_000 });
    assert(!!term, "a terminal for Prompts");
    await sleep(800);
    await menuAction(b, "view.command-palette");
    await b.waitFor("the palette", `return !!e2e.first(".command-palette-input");`);
    await typeValue(b, ".command-palette-input", "Prompts");
    await sleep(300);
    await b.clickWhenReady(`const i = e2e.all(".command-palette-item").find((e) => /^Prompts/.test(e2e.norm(e.innerText))); return i ? e2e.click(i) : false;`);
    await b.waitFor("Prompts", `return !!e2e.first('[data-testid="prompt-picker"] .pp-input');`, { timeoutMs: 15_000 });
    // The palette's notes come after its first paint (Mine is read, then the note is set).
    await b
      .waitFor("the note about the 2.0 items", `return e2e.all(".pp-note").some((e) => /under Mine/.test(e2e.norm(e.innerText)));`, { timeoutMs: 10_000 })
      .catch(() => null);
    const opened = await b.eval(`return {
      notes: e2e.all(".pp-note").map((e) => e2e.norm(e.innerText)),
      chips: e2e.all(".pp-chips [data-filter]").map((e) => e.getAttribute("data-filter")),
      tabs: e2e.all(".template-picker-tab").length,
    };`);
    log(`  Prompts on open: ${JSON.stringify(opened)}`);
    check(opened.tabs === 0 && opened.chips.includes("mine") && opened.chips[0] === "all", "Prompts opens as one list with a Mine filter (no Library / My Templates tabs)");
    check(opened.notes.some((n) => /under Mine/.test(n)), "and says the 2.0 templates, roles and styles are under Mine");
    await b.click('.pp-chips [data-filter="mine"]');
    await b.waitFor("Mine", `return !!e2e.first('.pp-row[data-key="mine:user-root-cause-copy"]');`, { timeoutMs: 15_000 }).catch(() => null);
    const mineRows = await b.eval(`return e2e.all(".pp-row").map((e) => e.getAttribute("data-key"));`);
    log(`  Prompts, Mine: ${JSON.stringify(mineRows)}`);
    await b.screenshot(join(evidenceDir, "03-prompts-mine.png"));
    check(
      ["mine:user-ship-checklist", "mine:user-root-cause-copy", "mine:custom-role-release", "mine:custom-style-terse"].every((k) => mineRows.includes(k)),
      "Mine holds both saved templates, the custom role and the custom style",
    );
    // The edited built-in: its old role and style ids brought their library entries into its text.
    await b.click('.pp-row[data-key="mine:user-root-cause-copy"]');
    await b.waitFor(
      "the edited built-in's text",
      `return /Find why the nightly import fails/.test(e2e.first('[data-testid="prompt-receives"]')?.textContent ?? "");`,
      { timeoutMs: 20_000 },
    ).catch(() => null);
    const preview = await b.eval(`return e2e.first('[data-testid="prompt-receives"]')?.textContent ?? "";`);
    log(`  its text: ${JSON.stringify(preview.slice(0, 300))}`);
    await b.screenshot(join(evidenceDir, "04-prompts-migrated-entry.png"));
    check(/backend engineer/i.test(preview) && !/Senior Backend Engineer/.test(preview), "the old role id backend-eng brings the library persona Backend engineer");
    check(preview.includes("Find why the nightly import fails") && preview.includes("Root cause first"), "with the saved task and constraint");
    check(!/<\/?(task|context|role)>/.test(preview), "and reads as text, not template source");
    const myPrompts = JSON.parse((await invoke(b, "get_settings")).my_prompts ?? "[]");
    check(myPrompts.length === 4, "Mine is stored once, in my_prompts");

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
