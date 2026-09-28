/** C0 contracts: the turn ledger seam (ref names and the empty commands). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { getTurnDiff, isTurnRefSessionId, listTurns, parseTurnRef, turnRef, TURN_REF_PREFIX } from "../agent/contract/turns";

beforeEach(() => invoke.mockReset());

describe("turnRef", () => {
  it("names refs/hermes/<session>/turn/<n>", () => {
    expect(turnRef("sess-1", 3)).toBe("refs/hermes/sess-1/turn/3");
    expect(TURN_REF_PREFIX).toBe("refs/hermes/");
  });

  it("refuses ids git would refuse and turn numbers below 1", () => {
    expect(() => turnRef("", 1)).toThrow(/session id/);
    expect(() => turnRef("has space", 1)).toThrow(/session id/);
    expect(() => turnRef("../escape", 1)).toThrow(/session id/);
    expect(() => turnRef("a".repeat(129), 1)).toThrow(/session id/);
    expect(() => turnRef("ok", 0)).toThrow(/turn number/);
    expect(() => turnRef("ok", 1.5)).toThrow(/turn number/);
    expect(isTurnRefSessionId("A-b_9")).toBe(true);
    expect(isTurnRefSessionId("-lead")).toBe(false);
  });

  it("parses back what it names and nothing else", () => {
    expect(parseTurnRef(turnRef("sess-1", 12))).toEqual({ sessionId: "sess-1", n: 12 });
    expect(parseTurnRef("refs/heads/main")).toBeNull();
    expect(parseTurnRef("refs/hermes/sess-1/turn/0")).toBeNull();
    expect(parseTurnRef("refs/hermes/sess-1/turn/01")).toBeNull();
    expect(parseTurnRef("refs/hermes/sess-1/turn/x")).toBeNull();
    expect(parseTurnRef("refs/hermes/sess 1/turn/1")).toBeNull();
  });
});

describe("the commands", () => {
  it("call the backend with camelCase arguments and hand back its answer", async () => {
    invoke.mockResolvedValueOnce([]);
    await expect(listTurns("s1")).resolves.toEqual([]);
    expect(invoke).toHaveBeenLastCalledWith("list_turns", { sessionId: "s1" });
    invoke.mockResolvedValueOnce(null);
    await expect(getTurnDiff("s1", 2)).resolves.toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("get_turn_diff", { sessionId: "s1", n: 2 });
  });
});
