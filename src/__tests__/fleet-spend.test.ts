/**
 * F31 — honest cost and limits: spend is only what an agent reported, and a
 * soft cap interrupts the session and raises a `limit` inbox item, once per
 * cap value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateSpendCaps, formatUsd, sumReported, tripKeyFor, type SpendSession } from "../fleet/spend";
import { createSpendCapWatcher, getCapTrip, _resetCapTripsForTest } from "../fleet/spendCapWatcher";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import { _resetInboxForTest, listInboxItems, raiseInboxItem } from "../agent/contract/inbox";
import { NO_CAPS, type FleetCaps } from "../fleet/fleetSettings";

const s = (id: string, costUsd: number | null, feature: string | null = null): SpendSession => ({
  id,
  label: `label-${id}`,
  costUsd,
  feature: feature ? { key: `p1::${feature}`, label: feature } : null,
});

describe("formatUsd / sumReported", () => {
  it("formats dollars the way the rows show them", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.4125)).toBe("$0.41");
    expect(formatUsd(12)).toBe("$12.00");
  });

  it("adds up only what was reported; nothing reported is null, not zero", () => {
    expect(sumReported([null, null])).toBeNull();
    expect(sumReported([])).toBeNull();
    expect(sumReported([null, 0.5, 0.25])).toBe(0.75);
    expect(sumReported([0])).toBe(0);
  });
});

describe("evaluateSpendCaps", () => {
  it("trips a session cap at or above the cap, never below", () => {
    const trips = evaluateSpendCaps([s("a", 1.0), s("b", 0.99), s("c", 2)], { sessionUsd: 1, featureUsd: null }, new Set());
    expect(trips.map((t) => t.key)).toEqual(["a", "c"]);
    expect(trips[0]).toMatchObject({ kind: "session", sessionIds: ["a"], leadSessionId: "a", spentUsd: 1, capUsd: 1 });
  });

  it("never trips for an agent that reports no cost (n/a is not zero and not a guess)", () => {
    expect(evaluateSpendCaps([s("a", null)], { sessionUsd: 0.01, featureUsd: 0.01 }, new Set())).toEqual([]);
  });

  it("adds a feature's reported costs and stops every session of it", () => {
    const sessions = [s("a", 0.6, "hermes/login"), s("b", 0.5, "hermes/login"), s("c", null, "hermes/login"), s("d", 5, "hermes/other"), s("e", 9)];
    const trips = evaluateSpendCaps(sessions, { sessionUsd: null, featureUsd: 1 }, new Set());
    const login = trips.find((t) => t.label === "hermes/login")!;
    expect(login.spentUsd).toBeCloseTo(1.1);
    expect(login.sessionIds).toEqual(["a", "b", "c"]);
    expect(login.leadSessionId).toBe("a");
    expect(trips.find((t) => t.label === "hermes/other")?.sessionIds).toEqual(["d"]);
    // A session outside any feature is not part of a feature cap.
    expect(trips.some((t) => t.sessionIds.includes("e"))).toBe(false);
  });

  it("does not trip twice for the same cap value, but a raised cap trips again when crossed", () => {
    const tripped = new Set([tripKeyFor("session", "a", 1)]);
    expect(evaluateSpendCaps([s("a", 3)], { sessionUsd: 1, featureUsd: null }, tripped)).toEqual([]);
    expect(evaluateSpendCaps([s("a", 3)], { sessionUsd: 2, featureUsd: null }, tripped)).toHaveLength(1);
  });

  it("does nothing with no caps", () => {
    expect(evaluateSpendCaps([s("a", 100, "f")], NO_CAPS, new Set())).toEqual([]);
  });
});

describe("the spend cap watcher", () => {
  let caps: FleetCaps;
  beforeEach(() => {
    _resetSessionEventStoreForTest();
    _resetInboxForTest(() => 42);
    _resetCapTripsForTest();
    caps = { ...NO_CAPS, sessionUsd: 1 };
  });

  const usage = (id: string, costUsd: number | null, at = 1) =>
    dispatchSessionEvent(id, { type: "usage", at, inputTokens: 100, outputTokens: 10, costUsd });

  function watcher(interrupt = vi.fn(async () => true)) {
    return {
      interrupt,
      w: createSpendCapWatcher({
        sessions: () => [
          { id: "s1", label: "Task one" },
          { id: "s2", label: "Task two" },
        ],
        featureOf: () => null,
        caps: () => caps,
        interrupt,
        raise: raiseInboxItem,
        describe: (t) => `cap ${t.capUsd} reached by ${t.label}`,
      }),
    };
  }

  it("interrupts the session over the cap and raises one limit item in the inbox", () => {
    const { w, interrupt } = watcher();
    usage("s1", 0.4);
    usage("s2", null);
    expect(w.check()).toEqual([]);
    expect(interrupt).not.toHaveBeenCalled();

    usage("s1", 1.2, 2);
    const trips = w.check();
    expect(trips).toHaveLength(1);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith("s1");
    expect(listInboxItems()).toEqual([
      { id: "inbox-1", kind: "limit", sessionId: "s1", detail: "cap 1 reached by Task one", createdAt: 42, source: "cap" },
    ]);
    expect(getCapTrip("s1")?.capUsd).toBe(1);
    expect(getCapTrip("s2")).toBeNull();

    // More spending on the same cap: soft, so nothing happens again.
    usage("s1", 3, 3);
    expect(w.check()).toEqual([]);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(listInboxItems()).toHaveLength(1);
  });

  it("forgets the mark when the cap changes, and a higher cap trips again once crossed", () => {
    const { w, interrupt } = watcher();
    usage("s1", 1.5);
    w.check();
    expect(getCapTrip("s1")).not.toBeNull();
    caps = { ...NO_CAPS, sessionUsd: 2 };
    expect(w.check()).toEqual([]);
    expect(getCapTrip("s1")).toBeNull();
    usage("s1", 2.5, 2);
    expect(w.check()).toHaveLength(1);
    expect(interrupt).toHaveBeenCalledTimes(2);
  });

  it("a cap set again after another value is a new cap: it trips again", () => {
    const { w, interrupt } = watcher();
    usage("s1", 1.25);
    expect(w.check()).toHaveLength(1);
    caps = { ...NO_CAPS, sessionUsd: 2 };
    expect(w.check()).toEqual([]);
    caps = { ...NO_CAPS, sessionUsd: 1 };
    const again = w.check();
    expect(again).toHaveLength(1);
    expect(again[0].capUsd).toBe(1);
    expect(interrupt).toHaveBeenCalledTimes(2);
    // The same line is still open in the inbox: not listed twice.
    expect(listInboxItems()).toHaveLength(1);
    expect(getCapTrip("s1")?.capUsd).toBe(1);
    // ...and, keeping that value, it does not trip a third time.
    usage("s1", 1.5, 2);
    expect(w.check()).toEqual([]);
    expect(interrupt).toHaveBeenCalledTimes(2);
  });

  it("turning the cap off and on with the same value re-arms it too", () => {
    const { w, interrupt } = watcher();
    usage("s1", 1.25);
    w.check();
    caps = { ...NO_CAPS };
    expect(w.check()).toEqual([]);
    caps = { ...NO_CAPS, sessionUsd: 1 };
    expect(w.check()).toHaveLength(1);
    expect(interrupt).toHaveBeenCalledTimes(2);
  });

  it("an interrupt that fails still leaves the inbox item", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { w } = watcher(vi.fn(async () => {
      throw new Error("Session s1 not found");
    }));
    usage("s1", 9);
    w.check();
    await Promise.resolve();
    await Promise.resolve();
    expect(listInboxItems()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
