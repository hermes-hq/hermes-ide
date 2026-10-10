import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { ILinkHandler } from "@xterm/xterm";

/** Schemes a click in the terminal may hand to the system browser or mail app. */
const OPENABLE = /^(https?:\/\/|mailto:)/i;

let opener: (uri: string) => void = (uri) => {
  shellOpen(uri).catch(console.warn);
};

/** Test builds only: record the links a click would open instead of opening them. */
export function setTerminalLinkOpener(fn: (uri: string) => void): void {
  opener = fn;
}

/** Open a link the terminal shows in the system's default app. Anything else
 *  (file:, javascript:, custom schemes) is ignored. */
export function openTerminalLink(uri: string): void {
  if (!OPENABLE.test(uri)) return;
  opener(uri);
}

/** Hyperlinks a program prints with OSC 8 (Claude Code does, for PR and docs
 *  links). Without this xterm falls back to confirm() + window.open(), which
 *  do nothing inside the app's web view, so the click is lost. */
export const terminalLinkHandler: ILinkHandler = {
  activate: (_event, uri) => openTerminalLink(uri),
  allowNonHttpProtocols: true,
};
