// Shared steps for the QA-status-* scenarios (attention inbox, away
// messages, Collision Radar, spend totals, status bar, session rows): a
// fresh app with fake Claude Code / Codex on PATH (launcher-steps), a local
// web server standing in for the away address, and helpers that make an
// agent block for real (the fake CLI's PermissionRequest hook).

import { createServer } from "node:http";
import { sleep } from "./harness.mjs";
import { completeClassicOnboarding, launcherFixtures, onMac } from "./launcher-steps.mjs";
import { invoke, setInput } from "./fleet-steps.mjs";

export { sleep, invoke };

/** A local server for away messages: every request body, answered with `status`. */
export function receiver(status = 200) {
  const got = [];
  let answer = status;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ at: Date.now(), body });
      res.writeHead(answer);
      res.end();
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({
        url: `http://127.0.0.1:${server.address().port}/hermes`,
        got,
        /** From now on answer with this HTTP status. */
        answerWith: (next) => {
          answer = next;
        },
        close: () => server.close(),
      }),
    ),
  );
}

/** Wait (polling) until the receiver has at least `n` requests; returns how many it has. */
export async function waitForMessages(rx, n, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (rx.got.length < n && Date.now() < deadline) await sleep(250);
  return rx.got.length;
}

/** A fresh install with the fake agents, past the welcome screens. */
export async function startApp(tag, evidenceDir, log, onCleanup, apps, { env } = {}) {
  const fx = launcherFixtures(tag, log);
  onCleanup(() => fx.cleanup());
  // Windows terminals rebuild PATH from the registry (see N12): the fake
  // agents must be on it there too (CI runners only).
  const undoPath = fx.addFakeBinToRegistryPath();
  if (undoPath) onCleanup(undoPath);
  const app = await fx.launch(evidenceDir, 1, { first: true, ...(env ? { env } : {}) });
  apps.push(app);
  await completeClassicOnboarding(app.bridge);
  return { fx, app, bridge: app.bridge };
}

/** Settings > General > Away notifications: type the address, press Enter, close. */
export async function setAwayUrl(bridge, url) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the away field", `return !!e2e.first("#away-notify-url");`);
  await setInput(bridge, "#away-notify-url", url);
  await bridge.eval(`const i = e2e.first("#away-notify-url"); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true;`);
  await bridge.waitFor("the address saved", `return (await window.__TAURI_INTERNALS__.invoke("get_settings")).away_notify_url === ${JSON.stringify(url)};`);
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings closed", `return !e2e.first(".settings-close");`);
}

/** Start a fake agent through the launch path the task launcher uses; waits for its launch record. */
export async function startAgent(bridge, fx, { agentId = "claude", cwd, label }, records) {
  const id = await bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId, cwd, label })});`, { timeoutMs: 30_000 });
  await fx.waitForRecords(records);
  return id;
}

/** The fake agent asks for permission (its own PermissionRequest hook). */
export async function block(bridge, id) {
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(id)}, data: btoa("p") }); return true;`);
  await bridge.waitFor("needs approval", `return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(id)}).kind === "needs_approval";`, { timeoutMs: 15_000 });
}

/** Type into a session's terminal (bytes, as the keyboard sends them). */
export function writeTo(bridge, id, data) {
  return bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(id)}, data: btoa(${JSON.stringify(data)}) }); return true;`);
}

/** ⌘I (Ctrl+Shift+I elsewhere) as a key event in the webview. */
export function pressNextWaiting(bridge) {
  const init = onMac ? { key: "i", code: "KeyI", metaKey: true } : { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true };
  return bridge.eval(`
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { ...${JSON.stringify(init)}, bubbles: true, cancelable: true }));
    return true;`);
}
