/**
 * M10 — interactive-tool envelopes (AskUserQuestion answer, ExitPlanMode
 * decision, canUseTool response) must survive the bridge being dead
 * between turns.
 *
 * Bug repro from the user's console:
 *   [respawn] fork=true overrides={"permissionMode":"plan"}  ← good
 *   [init] perm=plan                                          ← good
 *   [aq] send failed: "Agent session '<sid>' not found" (x8)  ← BAD: stuck
 *
 * Claude's --print subprocess exits after each turn.  The composer's
 * `submitAgentMessage` handles this with a retry-after-respawn; the
 * interactive-card handlers were calling `sendAgentInput` directly and
 * losing the response.  This test pins the retry contract.
 */
import { describe, it, expect, vi } from "vitest";
import { sendAgentEnvelopeWithRevive } from "../utils/sendAgentEnvelope";

describe("sendAgentEnvelopeWithRevive", () => {
  const ENV = { type: "user", message: { role: "user", content: [] } };

  it("happy path: send succeeds, no respawn fired", async () => {
    const send = vi.fn(async () => undefined);
    const respawn = vi.fn(async () => true);

    await sendAgentEnvelopeWithRevive("sid", ENV, { send, respawn });

    expect(send).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled();
  });

  it("dead bridge: respawns then retries the send", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Agent session 'sid' not found"))
      .mockResolvedValueOnce(undefined);
    const respawn = vi.fn(async () => true);

    await sendAgentEnvelopeWithRevive("sid", ENV, { send, respawn });

    expect(send).toHaveBeenCalledTimes(2);
    expect(respawn).toHaveBeenCalledTimes(1);
    // Both calls send the SAME envelope, by reference.
    expect(send.mock.calls[0][1]).toBe(ENV);
    expect(send.mock.calls[1][1]).toBe(ENV);
  });

  it("respawn fails: throws clear error, no second send attempt", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Agent session 'sid' not found"));
    const respawn = vi.fn(async () => false);

    await expect(
      sendAgentEnvelopeWithRevive("sid", ENV, { send, respawn }),
    ).rejects.toThrow(/Could not revive/i);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("non-not-found error: rethrows; no respawn", async () => {
    const send = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const respawn = vi.fn(async () => true);

    await expect(
      sendAgentEnvelopeWithRevive("sid", ENV, { send, respawn }),
    ).rejects.toThrow(/permission denied/);
    expect(respawn).not.toHaveBeenCalled();
  });

  it("retry's send error is rethrown verbatim", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Agent session 'x' not found"))
      .mockRejectedValueOnce(new Error("stdin pipe broken"));
    const respawn = vi.fn(async () => true);

    await expect(
      sendAgentEnvelopeWithRevive("sid", ENV, { send, respawn }),
    ).rejects.toThrow(/stdin pipe broken/);
  });

  it("not-found detection is case-insensitive (matches both 'Not found' and 'not found')", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Agent session 'x' Not Found"))
      .mockResolvedValueOnce(undefined);
    const respawn = vi.fn(async () => true);

    await sendAgentEnvelopeWithRevive("sid", ENV, { send, respawn });
    expect(respawn).toHaveBeenCalledTimes(1);
  });
});
