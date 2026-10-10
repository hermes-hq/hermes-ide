/**
 * Closing a plain shell that sits at its prompt does not ask "Close
 * session?": nothing is running. A session started for an agent (even while
 * the agent is still starting), an agent seen in the terminal, a shell
 * running a program, an Agent view session, or a failed check still asks.
 */
import { describe, it, expect, vi } from "vitest";
import { closeNeedsConfirm } from "../state/closeConfirm";

const shell = { mode: "terminal" as const, ai_provider: null, detected_agent: null };

describe("closeNeedsConfirm", () => {
  it("a plain shell at its prompt closes without asking", async () => {
    expect(await closeNeedsConfirm(shell, async () => true)).toBe(false);
  });

  it("a plain shell running a program asks", async () => {
    expect(await closeNeedsConfirm(shell, async () => false)).toBe(true);
  });

  it("a session saved without a mode is a terminal", async () => {
    expect(await closeNeedsConfirm({ ai_provider: null }, async () => true)).toBe(false);
  });

  it("a session started for an agent asks, even before the agent is up, without checking the shell", async () => {
    const check = vi.fn(async () => true);
    expect(await closeNeedsConfirm({ ...shell, ai_provider: "claude" }, check)).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("an agent seen running in the terminal asks", async () => {
    expect(await closeNeedsConfirm({ ...shell, detected_agent: { name: "Codex" } }, async () => true)).toBe(true);
  });

  it("an Agent view session always asks", async () => {
    const check = vi.fn(async () => true);
    expect(await closeNeedsConfirm({ ...shell, mode: "agent" }, check)).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("an unknown session asks", async () => {
    expect(await closeNeedsConfirm(undefined, async () => true)).toBe(true);
  });

  it("asks when the check fails", async () => {
    expect(await closeNeedsConfirm(shell, async () => { throw new Error("no session"); })).toBe(true);
  });
});
