// Shared steps for the 2.0 fleet-control scenarios (F31 spend caps, F37
// Collision Radar, N22 task queue): relaunching against the same data to
// turn a flag on, setting a cap in Settings > Limits, pushing a session
// event through the Rust side of the event channel, and reading one row of
// the session list.

import { mkdtempSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, sleep } from "./harness.mjs";
import { dismissWhatsNew } from "./n11-steps.mjs";

const onWindows = platform() === "win32";

/**
 * A launcher that keeps the app's data between launches: a private home on
 * macOS and Linux (the scenario's own folder), the test app's data folder
 * under %APPDATA% on Windows (wiped on the first launch only).
 */
export function relauncher(evidenceDir, log, tag) {
  const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), `hermes-e2e-${tag}-home-`));
  return (run, { first = false } = {}) => {
    const runDir = join(evidenceDir, `run-${run}`);
    return onWindows
      ? launchApp({ runDir, log, home: "real", resetData: first })
      : launchApp({ runDir, log, home: "private", homeDir });
  };
}

export const invoke = (bridge, cmd, args = {}) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)});`);

/** Store flag overrides (read at the next launch, like the hidden Flags tab does). */
export async function setFlagOverrides(bridge, overrides) {
  await invoke(bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify(overrides) });
}

export async function waitForReturningLaunch(bridge, log) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `, { timeoutMs: 30_000 });
  await dismissWhatsNew(bridge, log);
}

/** Sets a React-controlled input the way typing does (value + input event). */
export function setInput(bridge, selector, value) {
  return bridge.eval(`
    const input = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  `);
}

/**
 * Settings > Limits: type `value` into one cap field ("" turns it off) and
 * press Enter, as a person would. Waits until the setting is stored.
 * `field` is sessionUsd | featureUsd | maxRunning | maxMemoryMb.
 */
export async function setCapInSettings(bridge, log, field, value) {
  const keys = {
    sessionUsd: "fleet_spend_cap_session_usd",
    featureUsd: "fleet_spend_cap_feature_usd",
    maxRunning: "fleet_max_running_agents",
    maxMemoryMb: "fleet_max_agent_memory_mb",
  };
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.waitFor("the Limits tab", `return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Limits");`);
  await bridge.eval(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Limits");
    return e2e.click(e2e.must(tab, "Limits tab"));
  `);
  const selector = `input[data-fleet-cap="${field}"]`;
  await bridge.waitFor(`the ${field} field`, `return !!e2e.first(${JSON.stringify(selector)});`);
  const label = await bridge.eval(`return e2e.norm(e2e.first('label[for="fleet-cap-${field}"]')?.textContent ?? "");`);
  await setInput(bridge, selector, String(value));
  // Confirm with Enter. Leaving the field (blur) only fires when the input
  // really has focus, which a window in the background (Windows runners)
  // never gives it; a key-down on the input reaches the app either way.
  const focus = await bridge.eval(`
    const input = e2e.first(${JSON.stringify(selector)});
    const focus = { active: document.activeElement === input, pageHasFocus: document.hasFocus() };
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true, view: window }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true, view: window }));
    return focus;
  `);
  log(`  pressed Enter in the ${field} field (input focused: ${focus.active}, window focused: ${focus.pageHasFocus})`);
  const stored = await bridge.waitFor(`the ${field} cap to be saved`, `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const stored = raw[${JSON.stringify(keys[field])}] ?? "";
    return stored === ${JSON.stringify(String(value))} ? { stored } : null;
  `, { timeoutMs: 5_000 }).then((r) => r.stored).catch(async () => {
    const raw = await invoke(bridge, "get_settings");
    throw new Error(`the ${field} cap was not saved as ${JSON.stringify(String(value))} (stored: ${JSON.stringify(raw[keys[field]])})`);
  });
  log(`  Settings > Limits > "${label}" = ${JSON.stringify(stored)}`);
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
  return label;
}

/** Fire a native menu item's action the way the menu bar (or its shortcut) does. */
export async function menuAction(bridge, action) {
  await invoke(bridge, "plugin:event|emit", { event: "menu-action", payload: { action } });
}

/**
 * Where Hermes offers its dashboard of estimated costs: whether View > Cost
 * Dashboard is enabled in the native menu (its shortcut goes with it),
 * whether the command palette lists it, and whether the menu's action
 * opens it. Leaves the palette and the dashboard closed.
 */
export async function costDashboardOffers(bridge) {
  const menuEnabled = await invoke(bridge, "menu_item_enabled_for_test", { id: "view.cost-dashboard" });
  await menuAction(bridge, "view.command-palette");
  await bridge.waitFor("the command palette", `return !!e2e.first(".command-palette .command-palette-input");`);
  const inPalette = await bridge.eval(`return e2e.all(".command-palette-label").some((el) => e2e.norm(el.innerText) === "Cost Dashboard");`);
  await menuAction(bridge, "view.command-palette");
  await bridge.waitFor("the command palette to close", `return !e2e.first(".command-palette");`);
  await menuAction(bridge, "view.cost-dashboard");
  await sleep(1000);
  const opens = await bridge.exists(".cost-dashboard");
  if (opens) {
    await bridge.click(".cost-dashboard-close");
    await bridge.waitFor("the Cost Dashboard to close", `return !e2e.first(".cost-dashboard");`);
  }
  return { menuEnabled, inPalette, opens };
}

/** Push one SessionEvent through the Rust side of the channel (test builds only). */
export async function emitFromRust(bridge, sessionId, event) {
  await invoke(bridge, "emit_session_event_for_test", { sessionId, event });
}

/** The session list row of a session: its text and the fleet badges on it. */
export function rowState(bridge, sessionId) {
  return bridge.eval(`
    const row = document.querySelector('.session-item[data-session-item-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    if (!row) return null;
    const spend = row.querySelector(".session-spend");
    const cap = row.querySelector(".session-cap-reached");
    const overlap = row.querySelector(".session-overlap-badge");
    return {
      text: e2e.norm(row.innerText),
      spend: spend ? { text: e2e.norm(spend.innerText), kind: spend.getAttribute("data-spend") } : null,
      cap: cap ? e2e.norm(cap.innerText) : null,
      overlap: overlap ? { text: e2e.norm(overlap.innerText), title: overlap.getAttribute("title"), with: overlap.getAttribute("data-overlap-with") } : null,
      agentTag: e2e.norm(row.querySelector(".session-agent-tag")?.innerText ?? ""),
    };
  `);
}

/** Lines of a fake agent's --log file (JSON lines), [] while it has none. */
export async function readJsonl(file) {
  const { existsSync, readFileSync } = await import("node:fs");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export async function waitForFile(description, check, { timeoutMs = 15_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${description}`);
    await sleep(100);
  }
}
