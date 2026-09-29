import React from "react";
import ReactDOM from "react-dom/client";
import { exit } from "@tauri-apps/plugin-process";
import App from "./App";
import { getStartupProblem } from "./api/startupProblem";
import { StartupProblemScreen } from "./components/StartupProblemScreen";
import { initFeatureFlags, isFeatureFlagEnabled } from "./featureFlags";
import { startSessionEventChannel } from "./agent/contract/channel";
import { getSettings } from "./api/settings";
import { initStatusStripPreference } from "./statusStrip/preference";
import { startTurnLedgerBridge } from "./agent/turns/turnLedgerBridge";
import { startDoneWhen } from "./doneWhen/controller";
import { startLimitInbox } from "./limits/limitStatus";
import "./styles/tokens.css";
import "./styles/base.css";

// Dev-only debug hook: expose Tauri's `emit` on window so console tests
// can inject synthetic events (e.g. a `prompt is too long` result event
// to manually exercise the error banner) without needing the
// `withGlobalTauri` config or chasing Vite's resolved-deps path.  Lives
// behind `import.meta.env.DEV` so production builds never carry it.
if (import.meta.env.DEV) {
  import("@tauri-apps/api/event").then(({ emit, listen }) => {
    (window as unknown as { __hermes?: unknown }).__hermes = { emit, listen };
    // Console-discoverability: log once on boot so devs know it's there.
    console.info(
      "[hermes-dev] window.__hermes = { emit, listen } available for console testing",
    );
  });
}

// Test-only hooks for the automation bridge.  The flag is replaced at build
// time, so normal builds drop this import and the file behind it entirely.
if (import.meta.env.VITE_HERMES_E2E === "1") {
  void import("./e2e/hooks");
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// If Hermes could not open its data (for example, it was saved by a newer
// version), explain that instead of starting the workspace.
// In that case the backend sets up nothing else (no app state), so any other
// command would fail: do not call the backend before this check resolves.
void getStartupProblem().then((problem) => {
  if (problem) {
    root.render(
      <React.StrictMode>
        <StartupProblemScreen problem={problem} onQuit={() => void exit(0)} />
      </React.StrictMode>,
    );
    return;
  }
  // Feature flags are read once, here, before the workspace renders — see
  // src/featureFlags/index.ts. Not earlier: the check above must resolve
  // before any other backend call. It never rejects, and gives up after a
  // short timeout (flags then stay at their stable default for this launch),
  // so a slow backend can never leave a blank window.
  // The one channel every agent's session events arrive on (2.0 contracts,
  // docs/adr/004-2.0-contracts.md). Attached before the workspace renders so
  // no event is missed; a failure to attach only logs.
  void import("@tauri-apps/api/event")
    .then(({ listen }) => startSessionEventChannel(listen))
    .catch((e) => console.warn("[session-event] channel not attached:", e));
  // The status-strip preference (F11) rides on the same settings read.
  void getSettings()
    .then((settings) => initStatusStripPreference(settings))
    .catch(() => {});
  // N19: a session that hits its usage limit waits in the attention inbox.
  startLimitInbox();
  void initFeatureFlags().finally(() => {
    // Turn ledger (F20): forward turn boundaries to the backend snapshots
    // while the flag is on; tell the backend to stay off otherwise.
    startTurnLedgerBridge(isFeatureFlagEnabled("turnLedger"));
    // Done-When checks (F27) run through the launch helper, so they share
    // its flag. Attached before the workspace renders so no turn end is
    // missed.
    if (isFeatureFlagEnabled("launchHelper")) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) => startDoneWhen({ listen }))
        .catch((e) => console.warn("[done-when] not started:", e));
    }
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
});
