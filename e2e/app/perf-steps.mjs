// Shared steps for the F14 (context gauge) and F24 (fleet performance)
// scenarios: turning a feature flag on through the hidden Settings > Flags
// section, a fake `claude` on the app's PATH, and a Claude terminal session.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT } from "./harness.mjs";
import { finishWizard, openWizard } from "./n11-steps.mjs";

const onWindows = platform() === "win32";

/** Settings > (7 clicks on the title) > Flags: set one flag's override. */
export async function setFlagOverride(bridge, flagId, value, assert) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.eval(`
    const title = e2e.must(e2e.first(".settings-title"), "settings title");
    for (let i = 0; i < 7; i++) e2e.click(title);
    return true;
  `);
  await bridge.waitFor("the hidden Flags tab", `return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Flags");`);
  await bridge.eval(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Flags");
    return e2e.click(e2e.must(tab, "Flags tab"));
  `);
  const select = `e2e.first('select[data-flag-id="${flagId}"]')`;
  await bridge.waitFor(`the ${flagId} flag control`, `return !!${select};`);
  const result = await bridge.eval(`
    const sel = e2e.must(${select}, "${flagId} select");
    const label = e2e.norm(sel.closest(".settings-group")?.querySelector(".settings-label")?.innerText);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { value: sel.value, label };
  `);
  assert(result.value === value, `flag "${result.label}" set to "${value}"`);
  await bridge.waitFor("the override to be saved", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
    return overrides[${JSON.stringify(flagId)}] === ${value === "on" ? "true" : "false"};
  `);
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

/**
 * Put a `claude` that runs tools/fake-agents/fake-cli.mjs first on this
 * process's PATH (the app inherits it) and drop every folder that holds a
 * real one. Windows terminals rebuild PATH from the registry, so there the
 * fake also goes on the user's registry Path — only on a CI runner, and
 * `undo` restores it. Returns { fakeBin, undo, usable }: `usable` is false
 * on Windows outside CI, where the scenario cannot put the fake in reach.
 */
export function fakeClaudeOnPath(work, log) {
  const fakeBin = join(work, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakeCli = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
  if (onWindows) {
    writeFileSync(join(fakeBin, "claude.cmd"), `@"${process.execPath}" "${fakeCli}" %*\r\n`);
  } else {
    writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`);
    chmodSync(join(fakeBin, "claude"), 0o755);
  }
  const hasRealClaude = (dir) => ["claude", "claude.exe", "claude.cmd"].some((n) => existsSync(join(dir, n)));
  process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasRealClaude(d))].join(delimiter);
  for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_")) delete process.env[name];

  const onCi = process.env.GITHUB_ACTIONS === "true";
  if (!onWindows) return { fakeBin, undo: () => {}, usable: true };
  if (!onCi) return { fakeBin, undo: () => {}, usable: false };
  let old = null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    const m = out.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
    old = m ? m[1].trim() : "";
  } catch {
    old = null; // no user Path yet
  }
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old ? `${old};${fakeBin}` : fakeBin, "/f"]);
  log("  (CI runner: added the fake claude folder to the user's registry Path)");
  const undo = () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    log("  (CI runner: restored the user's registry Path)");
  };
  return { fakeBin, undo, usable: true };
}

/** New Session wizard: a Claude session in a terminal (not the Agent view). */
export async function createClaudeTerminal(bridge, log) {
  const before = await bridge.terminalIds();
  await openWizard(bridge);
  await bridge.clickWhenReady(`
    const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(card, "the Claude card"));
  `);
  await bridge.eval(`
    const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
    if (box && box.checked) e2e.click(box);
    return true;
  `);
  await finishWizard(bridge, log);
  const id = await bridge.waitFor(
    "the Claude terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  log(`  Claude terminal session: ${id}`);
  return id;
}

/** The row of a session in the session list, as a person sees it. */
export function sessionRow(bridge, sessionId) {
  return bridge.eval(`
    const row = document.querySelector('[data-session-item-id="${sessionId}"]');
    if (!row) return null;
    const gauge = row.querySelector(".session-context-gauge");
    const memory = row.querySelector(".session-memory-tag");
    return {
      text: e2e.norm(row.innerText),
      gauge: gauge ? { text: e2e.norm(gauge.innerText), percent: Number(gauge.dataset.percent), level: gauge.dataset.level, title: gauge.title, visible: e2e.visible(gauge) } : null,
      memory: memory ? { text: e2e.norm(memory.innerText), bytes: Number(memory.dataset.bytes), title: memory.title } : null,
    };
  `);
}

/**
 * Diagnostics for the F24 memory budget, read with the OS's own tools (not
 * the app's): every process below `pid`, grouped by kind, largest first:
 * [{ kind, count, mb }]. A web view helper is told apart by its --type
 * (renderer, gpu-process, ...); command lines are otherwise not kept.
 * Returns null when the OS tool is not there.
 */
export function processTreeByKind(pid) {
  let rows;
  try {
    if (onWindows) {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ($_.Name + ' ' + [regex]::Match([string]$_.CommandLine, '--type=[\\w-]+').Value) }",
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      );
      rows = out.split(/\r?\n/).filter(Boolean).map((l) => {
        const [p, pp, ws, kind] = l.split("|");
        return { pid: Number(p), ppid: Number(pp), bytes: Number(ws), kind: kind.trim() };
      });
    } else {
      const out = execFileSync("ps", ["-Ao", "pid=,ppid=,rss=,comm="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      rows = out.split("\n").filter(Boolean).map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return m && { pid: Number(m[1]), ppid: Number(m[2]), bytes: Number(m[3]) * 1024, kind: m[4].split("/").pop() };
      }).filter(Boolean);
    }
  } catch {
    return null;
  }
  const children = new Map();
  for (const r of rows) if (r.pid !== r.ppid) children.set(r.ppid, [...(children.get(r.ppid) || []), r]);
  const groups = new Map();
  const seen = new Set();
  const stack = [...(children.get(pid) || [])];
  const self = rows.find((r) => r.pid === pid);
  if (self) stack.push(self);
  while (stack.length) {
    const r = stack.pop();
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    const g = groups.get(r.kind) || { kind: r.kind, count: 0, bytes: 0 };
    g.count++;
    g.bytes += r.bytes;
    groups.set(r.kind, g);
    stack.push(...(children.get(r.pid) || []));
  }
  return [...groups.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .map((g) => ({ kind: g.kind, count: g.count, mb: Math.round((g.bytes / 1048576) * 10) / 10 }));
}
