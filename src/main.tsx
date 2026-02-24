import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import { installWindowInstrumentation } from "./debug/windowInstrumentation";

// Install window-level event capture BEFORE React mounts.
// This ensures we see every keydown/beforeinput/input/composition event
// from the very first keystroke, before xterm.js or React process them.
installWindowInstrumentation();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
