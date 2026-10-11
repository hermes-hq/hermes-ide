/**
 * A spend cap stops an Agent view session through the bridge (as its Stop
 * button does), not through the terminal interrupt, which only knows
 * terminal sessions and failed with "Session … not found".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { interruptForCap } from "../fleet/useFleetControls";

beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockResolvedValue(true);
});

describe("interruptForCap", () => {
  it("stops an Agent view session's turn through the bridge", async () => {
    await expect(interruptForCap({ mode: "agent" }, "s1")).resolves.toBe(true);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("send_agent_input", {
      sessionId: "s1",
      payload: { type: "_hermes_control", op: "interrupt" },
    });
  });

  it("interrupts a terminal session's agent in its terminal", async () => {
    await expect(interruptForCap({ mode: "terminal" }, "s2")).resolves.toBe(true);
    expect(h.invoke).toHaveBeenCalledWith("interrupt_session_agent", { sessionId: "s2" });
  });
});
