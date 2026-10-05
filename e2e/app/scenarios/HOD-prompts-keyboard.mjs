#!/usr/bin/env node
// HOD-prompts-keyboard: Prompts (⌘J), the one palette for library prompts,
// used from a Claude Code session and from the task launcher with the
// keyboard only. A fake `claude` (bracketed-paste mode, like the real TUI)
// records what it receives.
//
//   A  From the session: ⌘J opens Prompts with the keyboard in its search.
//      Shift+Tab reaches the filters and "Tasks" narrows the list; typing
//      searches; the arrows choose "Add a regression test for a bug"; its
//      preview reads as sections (no raw template tags). Return with the
//      required "Bug" blank empty goes to that blank; once typed, ⌘Return
//      inserts: Prompts closes and Claude Code's input has one typed line
//      ("<title>: follow the pasted prompt.") and the paste, and nothing is
//      sent until Return in the terminal. Then the agent's prompt is that
//      line plus the rendered text with the bug in it.
//   B  From the launcher: the task already typed goes into the prompt's
//      first blank; ⌘J opens Prompts in the launcher's place (one surface);
//      Return uses it as the task and the launcher comes back with the text
//      and a "Prompt:" chip.
//   C  Layout: the search stays inside the palette, no list scrolls
//      sideways, row titles have room. Screenshots in both themes.

import { join } from "node:path";
import { runLauncherQa, menuAction, sleep } from "../qa-launcher-steps.mjs";
import { typeInto, waitLauncherReady } from "../launcher-steps.mjs";

const NAME = "HOD-prompts-keyboard";
const ENTRY = "add-regression-test";
const TITLE = "Add a regression test for a bug";
const BUG = "Typing fast in the terminal drops characters (#482)";

const launchAgent = (bridge, agentId, cwd) =>
  bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId, cwd, label: `${agentId} session` })});`, { timeoutMs: 60_000 });

/** A key pressed on whatever has the keyboard (the app handles it like a real one). */
const press = (bridge, key, mods = {}) =>
  bridge.eval(`
    const el = document.activeElement || document.body;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, metaKey: ${!!mods.meta}, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} }));
    return { tag: document.activeElement?.tagName, cls: String(document.activeElement?.className ?? ""), arg: document.activeElement?.closest("[data-arg]")?.getAttribute("data-arg") ?? null };
  `);

const picker = (bridge) =>
  bridge.eval(`
    const root = e2e.first('[data-testid="prompt-picker"]');
    if (!root) return null;
    const box = root.getBoundingClientRect();
    const input = e2e.first(".pp-input")?.getBoundingClientRect();
    const list = e2e.first(".pp-list");
    const titles = e2e.all(".pp-row-title").map((e) => e.getBoundingClientRect().width);
    return {
      context: root.getAttribute("data-context"),
      focused: document.activeElement === e2e.first(".pp-input"),
      chosen: e2e.first(".pp-pane-inner")?.getAttribute("data-entry") ?? null,
      rows: e2e.all(".pp-row").map((e) => e.getAttribute("data-entry")),
      kinds: e2e.all(".pp-row").map((e) => e.getAttribute("data-kind")),
      groups: e2e.all(".pp-group").map((e) => e2e.norm(e.innerText)),
      filter: e2e.first('.pp-chips [aria-pressed="true"]')?.getAttribute("data-filter") ?? null,
      receives: e2e.first('[data-testid="prompt-receives"]')?.textContent ?? "",
      gives: e2e.norm(e2e.first(".pp-gives")?.innerText ?? ""),
      lead: !!e2e.first(".pp-lead"),
      need: e2e.norm(e2e.first(".pp-need")?.innerText ?? ""),
      bug: e2e.first('[data-arg="bug"] textarea')?.value ?? null,
      inputInside: !!input && input.right <= box.right + 0.5 && input.left >= box.left - 0.5,
      listSideways: !!list && list.scrollWidth > list.clientWidth + 1,
      narrowestTitle: titles.length ? Math.min(...titles) : 0,
    };
  `);

async function chooseEntry(bridge, id) {
  // The arrows only: down until the entry is the chosen one (or the end).
  for (let i = 0; i < 30; i++) {
    const s = await picker(bridge);
    if (s?.chosen === id) return true;
    await press(bridge, "ArrowDown");
    await sleep(120);
  }
  return (await picker(bridge))?.chosen === id;
}

async function shoot(bridge, evidenceDir, name) {
  for (const theme of ["frosted-dark", "frosted-light"]) {
    await bridge.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true;`);
    await sleep(350);
    await bridge.screenshot(join(evidenceDir, `${name}-${theme}.png`));
  }
  await bridge.eval(`document.documentElement.dataset.theme = "frosted-dark"; return true;`);
}

await runLauncherQa(
  NAME,
  async ({ bridge, fx, log, check, assert, evidenceDir }) => {
    const sid = await launchAgent(bridge, "claude", fx.repo);
    assert(!!sid, "a Claude Code session started (Terminal mode)");
    await bridge.waitFor("the fake claude to be ready", `return (window.__HERMES_E2E__.readTerminal(${JSON.stringify(sid)}) || []).some((l) => l.includes("fake-cli: ready"));`, { timeoutMs: 45_000 });
    const record = () => fx.records().find((r) => r.env?.HERMES_SESSION_ID === sid);

    // ── A: from the session ─────────────────────────────────────────
    log("step A1: ⌘J opens Prompts with the keyboard in the search");
    await menuAction(bridge, "view.prompt-composer");
    await bridge.waitFor("Prompts", `return !!e2e.first('[data-testid="prompt-picker"][data-context="session"] .pp-input');`, { timeoutMs: 20_000 });
    await bridge.waitFor("the first rows", `return e2e.all(".pp-row").length > 2;`, { timeoutMs: 30_000 });
    let s = await picker(bridge);
    log(`  groups ${JSON.stringify(s.groups)}, first rows ${JSON.stringify(s.rows.slice(0, 5))}`);
    check(s.focused, "the search has the keyboard");
    check(s.groups.some((g) => /For you/i.test(g)), "it opens on what fits (For you)");
    check(s.kinds.every((k) => k === "prompt" || k === "workflow"), "and with nothing typed it opens on tasks (personas and styles have their own filters)");
    check(s.inputInside && !s.listSideways, "the search stays inside the palette and the list never scrolls sideways");
    check(s.narrowestTitle > 150, `row titles have room (${Math.round(s.narrowestTitle)} px at the narrowest)`);
    await shoot(bridge, evidenceDir, "01-session-open");

    log("step A2: Shift+Tab to the filters, Tasks, back to the search, type, choose");
    const atChip = await press(bridge, "Tab", { shift: true });
    check(/h-chip-button/.test(atChip.cls), "Shift+Tab from the search reaches the filters");
    await bridge.eval(`const c = e2e.first('.pp-chips [data-filter="task"]'); c.focus(); c.click(); return true;`);
    await bridge.eval(`e2e.first(".pp-input").focus(); return true;`);
    await typeInto(bridge, ".pp-input", "regression test");
    await bridge.waitFor(`${ENTRY} among the results`, `return !!e2e.first('.pp-row[data-entry="${ENTRY}"]') && e2e.first(".pp-list")?.getAttribute("data-busy") !== "true";`, { timeoutMs: 20_000 });
    check(await chooseEntry(bridge, ENTRY), `the arrows choose "${TITLE}"`);
    await bridge.waitFor("its preview", `return /follow|regression/i.test(e2e.first('[data-testid="prompt-receives"]')?.textContent ?? "");`, { timeoutMs: 20_000 });
    s = await picker(bridge);
    log(`  filter ${s.filter}, kinds ${JSON.stringify([...new Set(s.kinds)])}, gives "${s.gives}"`);
    check(s.filter === "task" && s.kinds.every((k) => k === "prompt" || k === "workflow"), "the Tasks filter shows tasks only");
    check(!/<\/?(context|task|output_format)>/.test(s.receives), "the preview reads as sections, never as raw template tags");
    check(/Gives you:/.test(s.gives), "it says what the prompt gives you");

    log("step A3: Return with the Bug blank empty goes to the blank; type; ⌘Return inserts");
    const atBlank = await press(bridge, "Enter");
    await sleep(300);
    s = await picker(bridge);
    check(atBlank.arg === "bug" || (await bridge.eval(`return document.activeElement?.closest("[data-arg]")?.getAttribute("data-arg") ?? null;`)) === "bug", "Return goes to the empty required blank");
    check(/Needed/.test(s.need), "and says it is needed");
    await typeInto(bridge, '[data-arg="bug"] textarea', BUG);
    await sleep(300);
    s = await picker(bridge);
    check(s.receives.includes(BUG), "the preview shows the bug in place");
    check(s.lead, "it says Hermes types one lead line before the paste");
    await shoot(bridge, evidenceDir, "02-session-filled");
    const promptsBefore = (record()?.prompts ?? []).length;
    await press(bridge, "Enter", { meta: true });
    await bridge.waitFor("Prompts to close", `return !e2e.first('[data-testid="prompt-picker"]');`, { timeoutMs: 10_000 });
    const shown = await bridge
      .waitFor("the paste in the terminal", `const t = (window.__HERMES_E2E__.readTerminal(${JSON.stringify(sid)}) || []).join("\\n"); return /\\[pasted \\d+ chars\\]/.test(t) ? t : false;`, { timeoutMs: 15_000 })
      .catch(() => "");
    const lead = `${TITLE}: follow the pasted prompt.`;
    log(`  terminal tail: ${JSON.stringify(String(shown).split("\n").slice(-4).join(" | "))}`);
    check(String(shown).includes(lead), "the terminal shows the typed lead line");
    check(/\[pasted \d+ chars\]/.test(String(shown)), "and the prompt as one paste");
    await sleep(1200);
    check((record()?.prompts ?? []).length === promptsBefore, "nothing was sent: no Enter after it");
    await bridge.screenshot(join(evidenceDir, "03-session-inserted.png"));
    await bridge.typeInTerminal(sid, "\r");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (record()?.prompts ?? []).length <= promptsBefore) await sleep(200);
    const sent = record()?.prompts?.[promptsBefore] ?? "";
    log(`  claude received ${sent.length} chars: ${JSON.stringify(sent.slice(0, 160))}…`);
    check(sent.startsWith(lead), "Return in the terminal sends it, the lead line first");
    check(sent.includes(`Add a regression test for: ${BUG}`), "with the rendered prompt and the bug in it");

    // ── B: from the launcher ────────────────────────────────────────
    log("step B1: ⌘N, a task typed, ⌘J opens Prompts in the launcher's place");
    await menuAction(bridge, "file.new-session");
    await waitLauncherReady(bridge);
    if (await bridge.exists(".task-launcher-start-over")) await bridge.click(".task-launcher-start-over");
    await typeInto(bridge, ".task-launcher-task", BUG);
    await menuAction(bridge, "view.prompt-composer");
    await bridge.waitFor("Prompts in the launcher", `return !!e2e.first('[data-testid="prompt-picker"][data-context="launcher"] .pp-input');`, { timeoutMs: 20_000 });
    const oneSurface = await bridge.eval(`
      const sheet = e2e.first(".task-launcher-sheet");
      const pp = e2e.first('.task-launcher-overlay [data-testid="prompt-picker"]');
      return { sheetShown: !!sheet && getComputedStyle(sheet).display !== "none" && sheet.getClientRects().length > 0, inOverlay: !!pp, width: pp ? Math.round(pp.getBoundingClientRect().width) : 0 };
    `);
    log(`  launcher: sheet shown ${oneSurface.sheetShown}, Prompts ${oneSurface.width} px wide`);
    check(!oneSurface.sheetShown && oneSurface.inOverlay, "Prompts takes the launcher sheet's place in the same overlay (no dialog on a dialog)");
    check(oneSurface.width >= 700, "at full size");
    await typeInto(bridge, ".pp-input", "regression test");
    await bridge.waitFor(`${ENTRY} among the results`, `return !!e2e.first('.pp-row[data-entry="${ENTRY}"]') && e2e.first(".pp-list")?.getAttribute("data-busy") !== "true";`, { timeoutMs: 20_000 });
    check(await chooseEntry(bridge, ENTRY), "the arrows choose it");
    await bridge.waitFor("the launcher's text in the Bug blank", `return e2e.first('[data-arg="bug"] textarea')?.value === ${JSON.stringify(BUG)};`, { timeoutMs: 10_000 }).catch(() => null);
    s = await picker(bridge);
    check(s.bug === BUG, "what was typed in the launcher went into the prompt's first blank");
    await shoot(bridge, evidenceDir, "04-launcher-prompts");
    await bridge.eval(`e2e.first(".pp-input").focus(); return true;`);
    await press(bridge, "Enter");
    await bridge.waitFor("the launcher again", `const s = e2e.first(".task-launcher-sheet"); return !e2e.first('[data-testid="prompt-picker"]') && !!s && getComputedStyle(s).display !== "none";`, { timeoutMs: 10_000 });
    const back = await bridge.eval(`return { task: e2e.first(".task-launcher-task")?.value ?? "", chip: e2e.norm(e2e.first(".task-launcher-library-prompt")?.innerText ?? "") };`);
    log(`  launcher chip "${back.chip}", task ${JSON.stringify(back.task.slice(0, 120))}…`);
    check(back.task.includes(`Add a regression test for: ${BUG}`), "the task is the rendered prompt with the launcher's text in it");
    check(new RegExp(`Prompt: ${TITLE}`).test(back.chip), "and its chip names the prompt");
    await shoot(bridge, evidenceDir, "05-launcher-back");
    await press(bridge, "Escape");
  },
  {
    tag: "hod-prompts",
    before: (fx) => {
      // Typed text is part of the prompt (the lead line), as in the real TUI.
      fx.setFake("mode", "bracketed-paste prompts");
    },
  },
);
