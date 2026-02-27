/**
 * Platform detection + shortcut formatting tests.
 *
 * Tests the src/utils/platform.ts module by mocking navigator.userAgent
 * for each OS and verifying:
 * - Platform detection (PLATFORM, isMac, isWin, isLinux)
 * - fmt() token replacement for all 3 platforms
 * - isActionMod() returns correct modifier per platform
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";

// Ensure `navigator` exists in the Node test environment
beforeAll(() => {
  if (typeof globalThis.navigator === "undefined") {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "" },
      writable: true,
      configurable: true,
    });
  }
});

function mockUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    writable: true,
    configurable: true,
  });
}

describe("platform detection", () => {
  afterEach(() => {
    mockUserAgent("");
    vi.resetModules();
  });

  it("detects macOS from userAgent", async () => {
    mockUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
    const mod = await import("../utils/platform");
    expect(mod.PLATFORM).toBe("mac");
    expect(mod.isMac).toBe(true);
    expect(mod.isWin).toBe(false);
    expect(mod.isLinux).toBe(false);
  });

  it("detects Windows from userAgent", async () => {
    mockUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    const mod = await import("../utils/platform");
    expect(mod.PLATFORM).toBe("win");
    expect(mod.isMac).toBe(false);
    expect(mod.isWin).toBe(true);
    expect(mod.isLinux).toBe(false);
  });

  it("detects Linux from userAgent", async () => {
    mockUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36");
    const mod = await import("../utils/platform");
    expect(mod.PLATFORM).toBe("linux");
    expect(mod.isMac).toBe(false);
    expect(mod.isWin).toBe(false);
    expect(mod.isLinux).toBe(true);
  });

  it("defaults to mac for unknown userAgent", async () => {
    mockUserAgent("SomeUnknownBrowser/1.0");
    const mod = await import("../utils/platform");
    expect(mod.PLATFORM).toBe("mac");
  });

  it("defaults to mac when navigator.userAgent is empty", async () => {
    mockUserAgent("");
    const mod = await import("../utils/platform");
    expect(mod.PLATFORM).toBe("mac");
  });

  it("defaults to mac when navigator.userAgent is undefined", async () => {
    Object.defineProperty(navigator, "userAgent", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const mod = await import("../utils/platform");
    expect(mod.PLATFORM).toBe("mac");
  });
});

describe("fmt()", () => {
  afterEach(() => {
    mockUserAgent("");
    vi.resetModules();
  });

  it("formats {mod} as ⌘ on macOS", async () => {
    mockUserAgent("Macintosh");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}N")).toBe("⌘N");
  });

  it("formats {mod} as Ctrl+ on Windows", async () => {
    mockUserAgent("Windows NT 10.0");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}N")).toBe("Ctrl+N");
  });

  it("formats {mod} as Ctrl+ on Linux", async () => {
    mockUserAgent("Linux x86_64");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}N")).toBe("Ctrl+N");
  });

  it("formats {shift} as ⇧ on macOS", async () => {
    mockUserAgent("Macintosh");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}{shift}C")).toBe("⌘⇧C");
  });

  it("formats {shift} as Shift+ on Windows", async () => {
    mockUserAgent("Windows NT 10.0");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}{shift}C")).toBe("Ctrl+Shift+C");
  });

  it("formats {alt} as ⌥ on macOS", async () => {
    mockUserAgent("Macintosh");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}{alt}→")).toBe("⌘⌥→");
  });

  it("formats {alt} as Alt+ on Windows", async () => {
    mockUserAgent("Windows NT 10.0");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}{alt}→")).toBe("Ctrl+Alt+→");
  });

  it("formats {ctrl} as ⌃ on macOS", async () => {
    mockUserAgent("Macintosh");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{ctrl}C")).toBe("⌃C");
  });

  it("formats {ctrl} as Ctrl+ on Windows", async () => {
    mockUserAgent("Windows NT 10.0");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{ctrl}C")).toBe("Ctrl+C");
  });

  it("passes through text with no tokens unchanged", async () => {
    mockUserAgent("Macintosh");
    const { fmt } = await import("../utils/platform");
    expect(fmt("F11")).toBe("F11");
    expect(fmt("Escape")).toBe("Escape");
  });

  it("handles multiple tokens in one string", async () => {
    mockUserAgent("Windows NT 10.0");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}{shift}{alt}X")).toBe("Ctrl+Shift+Alt+X");
  });

  it("returns empty string for empty input", async () => {
    mockUserAgent("Macintosh");
    const { fmt } = await import("../utils/platform");
    expect(fmt("")).toBe("");
  });

  it("passes through unknown tokens unchanged", async () => {
    mockUserAgent("Macintosh");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{super}X")).toBe("{super}X");
  });

  it("formats standalone {mod} on Windows with trailing +", async () => {
    mockUserAgent("Windows NT 10.0");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}")).toBe("Ctrl+");
  });

  it("formats standalone {mod} on macOS without trailing artifact", async () => {
    mockUserAgent("Macintosh");
    const { fmt } = await import("../utils/platform");
    expect(fmt("{mod}")).toBe("⌘");
  });
});

describe("isActionMod()", () => {
  afterEach(() => {
    mockUserAgent("");
    vi.resetModules();
  });

  it("returns metaKey on macOS", async () => {
    mockUserAgent("Macintosh");
    const { isActionMod } = await import("../utils/platform");
    expect(isActionMod({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(isActionMod({ metaKey: false, ctrlKey: true })).toBe(false);
  });

  it("returns ctrlKey on Windows", async () => {
    mockUserAgent("Windows NT 10.0");
    const { isActionMod } = await import("../utils/platform");
    expect(isActionMod({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(isActionMod({ metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("returns ctrlKey on Linux", async () => {
    mockUserAgent("Linux x86_64");
    const { isActionMod } = await import("../utils/platform");
    expect(isActionMod({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(isActionMod({ metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("returns true on macOS when both modifiers are true", async () => {
    mockUserAgent("Macintosh");
    const { isActionMod } = await import("../utils/platform");
    expect(isActionMod({ metaKey: true, ctrlKey: true })).toBe(true);
  });

  it("returns false on macOS when both modifiers are false", async () => {
    mockUserAgent("Macintosh");
    const { isActionMod } = await import("../utils/platform");
    expect(isActionMod({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("returns true on Windows when both modifiers are true", async () => {
    mockUserAgent("Windows NT 10.0");
    const { isActionMod } = await import("../utils/platform");
    expect(isActionMod({ metaKey: true, ctrlKey: true })).toBe(true);
  });

  it("returns false on Windows when both modifiers are false", async () => {
    mockUserAgent("Windows NT 10.0");
    const { isActionMod } = await import("../utils/platform");
    expect(isActionMod({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});
