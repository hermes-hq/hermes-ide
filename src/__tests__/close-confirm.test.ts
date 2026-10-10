/**
 * Closing a terminal whose shell sits at its prompt does not ask "Close
 * session?": nothing is running. A terminal running a program, an Agent view
 * session, or a failed check still asks.
 */
import { describe, it, expect, vi } from "vitest";
import { closeNeedsConfirm } from "../state/closeConfirm";

describe("closeNeedsConfirm", () => {
  it("a terminal whose shell is at its prompt closes without asking", async () => {
    expect(await closeNeedsConfirm("terminal", async () => true)).toBe(false);
  });

  it("a terminal running a program asks", async () => {
    expect(await closeNeedsConfirm("terminal", async () => false)).toBe(true);
  });

  it("a session saved without a mode is a terminal", async () => {
    expect(await closeNeedsConfirm(undefined, async () => true)).toBe(false);
  });

  it("an Agent view session always asks, without checking the shell", async () => {
    const check = vi.fn(async () => true);
    expect(await closeNeedsConfirm("agent", check)).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("asks when the check fails", async () => {
    expect(await closeNeedsConfirm("terminal", async () => { throw new Error("no session"); })).toBe(true);
  });
});
