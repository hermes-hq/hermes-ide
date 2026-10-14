// Shared steps for the ACT-* scenarios (the session action bar): a fresh app
// with fake agents on PATH (launcher-steps: claude and codex; here also agy
// and opencode), a terminal session per agent, and the bar as a person sees
// it: its chips, its notice, its Commands list, and what the fake agent was
// actually sent (its launch record's prompts).

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, sleep } from "./harness.mjs";
import { onWindows } from "./launcher-steps.mjs";
import { startApp } from "./qa-status-steps.mjs";

export { sleep };

const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");

/** A fresh install with fake claude, codex, agy and opencode on PATH. */
export async function startActionsApp(tag, evidenceDir, log, onCleanup, apps) {
  const started = await startApp(tag, evidenceDir, log, onCleanup, apps);
  for (const [bin, agent] of [["agy", "antigravity"], ["opencode", "opencode"]]) {
    if (onWindows) {
      writeFileSync(join(started.fx.fakeBin, `${bin}.cmd`), `@set "HERMES_FAKE_AGENT=${agent}"\r\n@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
    } else {
      const file = join(started.fx.fakeBin, bin);
      writeFileSync(file, `#!/bin/sh\nHERMES_FAKE_AGENT=${agent} exec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
      chmodSync(file, 0o755);
    }
  }
  return started;
}

/**
 * Start an agent in a terminal session the way the launcher does, with the
 * fake in `mode` (read at its start), and wait until it is ready and waits.
 * In the fixtures' second repository by default (no Done-When checks, so
 * the pane shows only what the scenario is about).
 */
export async function startAgentSession(bridge, fx, { agentId, label, mode = "prompts bracketed-paste", cwd = fx.otherRepo, log }) {
  fx.setFake("mode", mode);
  const before = fx.records().length;
  const id = await bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId, cwd, label })});`, { timeoutMs: 30_000 });
  await fx.waitForRecords(before + 1);
  await bridge.waitForTerminal(id, /fake-cli: ready/, { timeoutMs: 30_000 });
  await waitUntilWaiting(bridge, id);
  log?.(`  ${agentId} session ${id} is ready (fake mode: ${mode})`);
  return id;
}

/** The session's status says the agent waits at its prompt. */
export function waitUntilWaiting(bridge, id, timeoutMs = 20_000) {
  return bridge.waitFor(
    `session ${id} to wait`,
    `const k = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(id)}).kind; return ["idle", "done_unread", "error", "limited", "check_failed"].includes(k) ? k : null;`,
    { timeoutMs },
  );
}

/** What the fake agent of a session was sent as prompts (its latest launch record). */
export function promptsOf(fx, index = -1) {
  const all = fx.records();
  return all.at(index)?.prompts ?? [];
}

/** In-page: the pane of a session (the bar inside it). */
const PANE = (id) => `([...document.querySelectorAll(".split-pane")].find((p) => p.querySelector('div[data-session-id="${id}"]')) || document)`;

/**
 * In-page expression: the chip of an action in a session's pane. On the
 * build before the session action bar (the negative control) the old quick
 * action with the same command, so the same scenario can prove what the old
 * bar did to a draft.
 */
export const chipExpr = (id, action, legacyText) =>
  `(${PANE(id)}.querySelector('[data-session-action="${action}"]') || [...${PANE(id)}.querySelectorAll(".pab-action")].find((b) => b.textContent.trim() === ${JSON.stringify(legacyText ?? "")}) || null)`;

export function clickChip(bridge, id, action, legacyText) {
  return bridge.eval(`return e2e.click(e2e.must(${chipExpr(id, action, legacyText)}, "the ${action} chip"));`);
}

/** The chip as a person sees it: label, disabled, tooltip. */
export function chipState(bridge, id, action) {
  return bridge.eval(`
    const el = ${chipExpr(id, action)};
    if (!el) return null;
    return { name: el.getAttribute("aria-label"), disabled: el.disabled, title: el.closest("[title]")?.getAttribute("title") ?? "", visible: e2e.visible(el), text: e2e.norm(el.innerText) };
  `);
}

/** The bar's notice in a session's pane (role=status), or null. */
export function noticeOf(bridge, id) {
  return bridge.eval(`const n = ${PANE(id)}.querySelector("[data-session-notice]"); return n ? e2e.norm(n.innerText) : null;`);
}

/** Open the Commands list of a session's bar; returns the section titles shown. */
export async function openCommands(bridge, id) {
  await bridge.eval(`return e2e.click(e2e.must(${PANE(id)}.querySelector("[data-session-commands]"), "the Commands button"));`);
  return bridge.waitFor(
    "the Commands list",
    `const pop = document.querySelector('[data-session-commands-popover="${id}"]');
     if (!pop || !pop.querySelector('[role="option"]')) return null;
     return [...pop.querySelectorAll(".session-commands-section-title")].map((t) => e2e.norm(t.textContent));`,
    { timeoutMs: 10_000 },
  );
}

/** Type into the Commands list's filter (a real input event). */
export function filterCommands(bridge, text) {
  return bridge.eval(`
    const input = e2e.must(document.querySelector(".session-commands [role=combobox]"), "the filter");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
}

/** A key on the Commands list's focused element. */
export function keyInCommands(bridge, key) {
  return bridge.eval(`
    const el = document.activeElement || document.body;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    return true;
  `);
}

/** Resize the window (logical px) and let the layout settle. */
export async function resizeWindow(bridge, width, height) {
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:window|set_size", { label: "main", value: { Logical: { width: ${width}, height: ${height} } } }); return true;`);
  await bridge.waitFor(`the window at ${width} px wide`, `return Math.abs(innerWidth - ${width}) <= 40;`, { timeoutMs: 10_000 });
  await sleep(700);
}

/** View ▸ Toggle Sidebar, as the menu sends it. */
export function toggleSidebar(bridge) {
  return bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "view.toggle-sidebar" } }); return true;`);
}

/** Each pane's bar as laid out: its form, whether it overflows or is cut, its chips, its Commands button. */
export function bars(bridge) {
  return bridge.eval(`
    return e2e.all(".split-pane").map((pane) => {
      const row = pane.querySelector(".session-actions-row");
      const sid = pane.querySelector("div[data-session-id]")?.getAttribute("data-session-id");
      if (!row) return { sid, bar: null };
      const p = pane.getBoundingClientRect();
      const cut = [...row.querySelectorAll("button")].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.right > p.right + 1 || r.left < p.left - 1);
      }).length;
      return {
        sid,
        bar: {
          layout: row.dataset.layout,
          inHeader: !!row.closest(".split-pane-label"),
          overflow: row.scrollWidth > row.clientWidth + 1,
          cut,
          paneWidth: Math.round(p.width),
          paneHeight: Math.round(p.height),
          chips: [...row.querySelectorAll("[data-session-action]")].map((c) => c.getAttribute("aria-label")),
          commands: e2e.norm(row.querySelector("[data-session-commands]")?.innerText ?? ""),
          prompts: !!row.querySelector("[data-session-prompts]"),
        },
      };
    });
  `);
}
