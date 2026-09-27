import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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
    // eslint-disable-next-line no-console
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
