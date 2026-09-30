/**
 * Fleet caps (F31, N22): parsing, saving and live updates of the four caps
 * in Settings > Limits, and the `usage` event in the per-session store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetFleetCapsForTest,
  FLEET_SETTING_KEYS,
  getFleetCaps,
  loadFleetCaps,
  parseCapValue,
  parseFleetCaps,
  setFleetCap,
  subscribeFleetCaps,
} from "../fleet/fleetSettings";
import { _resetSessionEventStoreForTest, dispatchSessionEvent, getSessionEventSnapshot } from "../agent/contract/sessionEventStore";
import { parseSessionEvent } from "../agent/contract/events";
import { spendOf } from "../fleet/spend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("cap values", () => {
  it.each<[Parameters<typeof parseCapValue>[0], string | undefined, number | null]>([
    ["sessionUsd", "5", 5],
    ["sessionUsd", " 0.50 ", 0.5],
    ["sessionUsd", "0", null],
    ["sessionUsd", "-1", null],
    ["sessionUsd", "abc", null],
    ["sessionUsd", "1e3", null],
    ["sessionUsd", "", null],
    ["sessionUsd", undefined, null],
    ["maxRunning", "3", 3],
    ["maxRunning", "2.5", null],
    ["maxMemoryMb", "4096", 4096],
  ])("%s %j -> %j", (field, raw, expected) => {
    expect(parseCapValue(field, raw)).toBe(expected);
  });

  it("reads all four from settings; unknown or broken values mean off", () => {
    expect(
      parseFleetCaps({
        [FLEET_SETTING_KEYS.sessionUsd]: "2",
        [FLEET_SETTING_KEYS.featureUsd]: "nope",
        [FLEET_SETTING_KEYS.maxRunning]: "3",
      }),
    ).toEqual({ sessionUsd: 2, featureUsd: null, maxRunning: 3, maxMemoryMb: null });
  });
});

describe("the caps store", () => {
  beforeEach(() => _resetFleetCapsForTest());

  it("loads once, saves through settings and tells subscribers at once", async () => {
    await loadFleetCaps(async () => ({ [FLEET_SETTING_KEYS.maxRunning]: "4" }));
    expect(getFleetCaps().maxRunning).toBe(4);
    const saved: [string, string][] = [];
    let woke = 0;
    subscribeFleetCaps(() => woke++);
    await setFleetCap("sessionUsd", 1.5, async (k, v) => {
      saved.push([k, v]);
    });
    await setFleetCap("maxRunning", null, async (k, v) => {
      saved.push([k, v]);
    });
    expect(saved).toEqual([
      ["fleet_spend_cap_session_usd", "1.5"],
      ["fleet_max_running_agents", ""],
    ]);
    expect(getFleetCaps()).toEqual({ sessionUsd: 1.5, featureUsd: null, maxRunning: null, maxMemoryMb: null });
    expect(woke).toBe(2);
  });

  it("unreadable settings leave no caps (never throws at startup)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(loadFleetCaps(async () => Promise.reject(new Error("db locked")))).resolves.toEqual(getFleetCaps());
    expect(getFleetCaps().sessionUsd).toBeNull();
    warn.mockRestore();
  });
});

describe("usage in the session store (contract addition)", () => {
  beforeEach(() => _resetSessionEventStoreForTest());

  it("keeps the latest totals the agent reported; a part it stops reporting keeps its last value", () => {
    expect(getSessionEventSnapshot("s").usage).toBeNull();
    dispatchSessionEvent("s", { type: "usage", at: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.1 });
    dispatchSessionEvent("s", { type: "usage", at: 2, inputTokens: 30, outputTokens: null, costUsd: 0.3 });
    expect(getSessionEventSnapshot("s").usage).toEqual({ inputTokens: 30, outputTokens: 2, costUsd: 0.3, confidence: "exact", at: 2 });
  });

  it("an estimate is marked, follows later estimates, and never replaces what the agent reported", () => {
    dispatchSessionEvent("s", { type: "usage", at: 1, inputTokens: 100, outputTokens: 5, costUsd: 0.2, confidence: "estimated" });
    expect(getSessionEventSnapshot("s").usage).toEqual({ inputTokens: 100, outputTokens: 5, costUsd: 0.2, confidence: "estimated", at: 1 });
    dispatchSessionEvent("s", { type: "usage", at: 2, inputTokens: 300, outputTokens: 9, costUsd: null, confidence: "estimated" });
    // An estimate is a complete running total: a later one without a price
    // (a call on a model Hermes has no price for) is n/a, never the old figure.
    expect(getSessionEventSnapshot("s").usage).toEqual({ inputTokens: 300, outputTokens: 9, costUsd: null, confidence: "estimated", at: 2 });
    // The agent's own report takes over, and its null parts are "n/a", not the estimate's.
    dispatchSessionEvent("s", { type: "usage", at: 3, inputTokens: 400, outputTokens: null, costUsd: 0.5 });
    expect(getSessionEventSnapshot("s").usage).toEqual({ inputTokens: 400, outputTokens: null, costUsd: 0.5, confidence: "exact", at: 3 });
    dispatchSessionEvent("s", { type: "usage", at: 4, inputTokens: 999, outputTokens: 99, costUsd: 9, confidence: "estimated" });
    expect(getSessionEventSnapshot("s").usage).toEqual({ inputTokens: 400, outputTokens: null, costUsd: 0.5, confidence: "exact", at: 3 });
  });

  it("an estimated cost that loses its price goes back to n/a while the tokens keep rising", () => {
    dispatchSessionEvent("s", { type: "usage", at: 1, inputTokens: 1000, outputTokens: 10, costUsd: 2.0, confidence: "estimated" });
    expect(getSessionEventSnapshot("s").usage?.costUsd).toBe(2);
    dispatchSessionEvent("s", { type: "usage", at: 2, inputTokens: 5000, outputTokens: 20, costUsd: null, confidence: "estimated" });
    expect(getSessionEventSnapshot("s").usage).toEqual({ inputTokens: 5000, outputTokens: 20, costUsd: null, confidence: "estimated", at: 2 });
    expect(spendOf(getSessionEventSnapshot("s").usage)).toEqual({ kind: "na", costUsd: null });
  });

  it("the parser keeps an estimate's mark and refuses an unknown one", () => {
    expect(parseSessionEvent({ type: "usage", at: 1, costUsd: 1, confidence: "estimated" })).toEqual({
      type: "usage",
      at: 1,
      inputTokens: null,
      outputTokens: null,
      costUsd: 1,
      confidence: "estimated",
    });
    expect(parseSessionEvent({ type: "usage", at: 1, costUsd: 1, confidence: "guessed" })).toBeNull();
    expect(parseSessionEvent({ type: "usage", at: 1, costUsd: 1, confidence: null })).toEqual({ type: "usage", at: 1, inputTokens: null, outputTokens: null, costUsd: 1 });
  });

  it("the parser refuses a negative, fractional or string amount", () => {
    expect(parseSessionEvent({ type: "usage", at: 1, inputTokens: 1.5 })).toBeNull();
    expect(parseSessionEvent({ type: "usage", at: 1, costUsd: -1 })).toBeNull();
    expect(parseSessionEvent({ type: "usage", at: 1, costUsd: "1" })).toBeNull();
    expect(parseSessionEvent({ type: "usage", at: 1, costUsd: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseSessionEvent({ type: "usage", at: 1 })).toEqual({ type: "usage", at: 1, inputTokens: null, outputTokens: null, costUsd: null });
  });
});
