// @vitest-environment jsdom
/**
 * Links in the terminal open in the system browser: plain URLs (found by the
 * web-links addon) and OSC 8 hyperlinks (printed by Claude Code and others).
 * Only web and mail links are opened.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shellOpen = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

import { openTerminalLink, terminalLinkHandler } from "../terminal/links";

describe("terminal links", () => {
  beforeEach(() => shellOpen.mockClear());

  it("an OSC 8 hyperlink click opens the URL in the system browser", () => {
    terminalLinkHandler.activate(new MouseEvent("click"), "https://github.com/hermes-hq/hermes-ide/pull/494", {
      start: { x: 1, y: 1 },
      end: { x: 10, y: 1 },
    });
    expect(shellOpen).toHaveBeenCalledWith("https://github.com/hermes-hq/hermes-ide/pull/494");
  });

  it("opens http, https and mailto links", () => {
    openTerminalLink("http://localhost:5173/");
    openTerminalLink("HTTPS://example.com");
    openTerminalLink("mailto:someone@example.com");
    expect(shellOpen).toHaveBeenCalledTimes(3);
  });

  it("ignores file, javascript and custom schemes", () => {
    openTerminalLink("file:///etc/passwd");
    openTerminalLink("javascript:alert(1)");
    openTerminalLink("vscode://file/x");
    expect(shellOpen).not.toHaveBeenCalled();
  });
});
