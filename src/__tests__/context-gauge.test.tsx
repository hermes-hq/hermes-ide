// @vitest-environment jsdom
/**
 * F14 — the context gauge. It shows what the agent itself reported (a
 * `context` SessionEvent) and nothing otherwise: no report, or a window Hermes
 * does not know, means no gauge rather than a guess. A compaction counts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("no backend"))) }));

import {
  _resetSessionEventStoreForTest,
  dispatchSessionEvent,
  getSessionEventSnapshot,
} from "../agent/contract/sessionEventStore";
import { parseSessionEvent } from "../agent/contract/events";
import { contextGauge } from "../utils/contextGauge";
import { SessionContextGauge } from "../components/SessionFleetTags";
import { I18nProvider } from "../i18n/I18nProvider";

const usage = (usedTokens: number, contextLimit: number | null, at = 1) =>
  parseSessionEvent({ type: "context", at, source: "transcript:claude", usedTokens, contextLimit, model: "claude-fake-1" })!;

beforeEach(() => _resetSessionEventStoreForTest());

describe("the store keeps the last context report and counts compactions", () => {
  it("records exactly what was reported", () => {
    expect(getSessionEventSnapshot("s").context).toBeNull();
    dispatchSessionEvent("s", usage(83_003, 200_000, 10));
    dispatchSessionEvent("s", usage(120_000, 200_000, 11));
    const snap = getSessionEventSnapshot("s");
    expect(snap.context).toEqual({ usedTokens: 120_000, contextLimit: 200_000, model: "claude-fake-1", at: 11 });
    expect(snap.compactions).toBe(0);
    dispatchSessionEvent("s", parseSessionEvent({ type: "compacted", at: 12, trigger: "auto", preTokens: 190_000 })!);
    expect(getSessionEventSnapshot("s").compactions).toBe(1);
    expect(getSessionEventSnapshot("s").context?.usedTokens).toBe(120_000);
    expect(getSessionEventSnapshot("other").context).toBeNull();
  });
});

describe("contextGauge", () => {
  it("is reported input tokens over the window, to the nearest point", () => {
    // 83,003 / 200,000 = 41.5015 %
    expect(contextGauge({ usedTokens: 83_003, contextLimit: 200_000, model: null, at: 0 })).toEqual({
      percent: 42,
      usedTokens: 83_003,
      contextLimit: 200_000,
      level: "ok",
    });
    for (const used of [0, 1, 999, 54_400, 159_999, 160_000, 189_999, 190_000, 199_999, 200_000]) {
      const g = contextGauge({ usedTokens: used, contextLimit: 200_000, model: null, at: 0 })!;
      expect(Math.abs(g.percent - (used / 200_000) * 100)).toBeLessThanOrEqual(1);
    }
  });

  it("warns at 80 % and is critical at 95 %, and never passes 100", () => {
    const at = (used: number) => contextGauge({ usedTokens: used, contextLimit: 1000, model: null, at: 0 })!;
    expect(at(794).level).toBe("ok");
    expect(at(800).level).toBe("warn");
    expect(at(950).level).toBe("critical");
    expect(at(5000).percent).toBe(100);
  });

  it("is nothing without a report or without a known window", () => {
    expect(contextGauge(null)).toBeNull();
    expect(contextGauge({ usedTokens: 5000, contextLimit: null, model: "unknown-model", at: 0 })).toBeNull();
  });
});

describe("SessionContextGauge on a session row", () => {
  const renderGauge = (sessionId: string) =>
    render(
      <I18nProvider>
        <SessionContextGauge sessionId={sessionId} />
      </I18nProvider>,
    );

  it("renders nothing for a terminal whose program reported nothing", () => {
    const { container } = renderGauge("plain-shell");
    expect(container.querySelector(".session-context-gauge")).toBeNull();
  });

  it("renders nothing when the window is unknown", () => {
    dispatchSessionEvent("s", usage(5000, null));
    const { container } = renderGauge("s");
    expect(container.querySelector(".session-context-gauge")).toBeNull();
  });

  it("shows the percentage and the exact numbers, and follows new reports", () => {
    dispatchSessionEvent("s", usage(83_003, 200_000));
    const { container } = renderGauge("s");
    const gauge = container.querySelector(".session-context-gauge") as HTMLElement;
    expect(gauge.dataset.percent).toBe("42");
    expect(gauge.dataset.level).toBe("ok");
    expect(screen.getByText("42% context")).toBeTruthy();
    expect(gauge.title).toContain((83_003).toLocaleString());
    expect(gauge.title).toContain((200_000).toLocaleString());
    act(() => {
      dispatchSessionEvent("s", usage(182_000, 200_000, 2));
    });
    expect(gauge.dataset.percent).toBe("91");
    expect(gauge.dataset.level).toBe("warn");
    expect((gauge.querySelector(".session-context-gauge-fill") as HTMLElement).style.width).toBe("91%");
  });
});
