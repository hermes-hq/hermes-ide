import { describe, it, expect } from "vitest";
import { LauncherReopen } from "../launcher/launcherReopen";

describe("⌘N while a launch is finishing (LauncherReopen)", () => {
  it("a ⌘N during a launch is kept, and a fresh launcher opens once the sheet has closed", () => {
    const r = new LauncherReopen();
    r.launchStarted();
    expect(r.requestOpen(true)).toBe(false);
    expect(r.closed()).toBe(true);
    // Only once.
    expect(r.closed()).toBe(false);
  });

  it("no ⌘N during the launch: the sheet just closes", () => {
    const r = new LauncherReopen();
    r.launchStarted();
    expect(r.closed()).toBe(false);
  });

  it("⌘N with no launch going on opens (or keeps) the launcher at once, and closing it later does not reopen it", () => {
    const r = new LauncherReopen();
    expect(r.requestOpen(false)).toBe(true);
    expect(r.requestOpen(true)).toBe(true);
    expect(r.closed()).toBe(false);
  });

  it("a failed launch keeps the sheet open and forgets the ⌘N", () => {
    const r = new LauncherReopen();
    r.launchStarted();
    expect(r.requestOpen(true)).toBe(false);
    r.launchFailed();
    // The person now closes the failed sheet with Esc: it stays closed.
    expect(r.closed()).toBe(false);
    // And a ⌘N on the open, failed sheet is an ordinary one.
    expect(r.requestOpen(true)).toBe(true);
  });

  it("⌘N after the launched sheet closed opens at once", () => {
    const r = new LauncherReopen();
    r.launchStarted();
    expect(r.closed()).toBe(false);
    expect(r.requestOpen(false)).toBe(true);
  });
});
