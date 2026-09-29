// @vitest-environment jsdom
/**
 * F24 — memory per session on the session row: one shared poller while any
 * row shows it, each row reads its own session, a failed reading keeps the
 * last one, and the tag is hidden behind the fleetPerf flag.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({ flagOn: true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../featureFlags", () => ({ isFeatureFlagEnabled: (id: string) => id === "fleetPerf" && h.flagOn }));

import { createFleetMemoryStore, formatMemory } from "../hooks/useFleetMemory";
import { SessionMemoryTag } from "../components/SessionFleetTags";
import { I18nProvider } from "../i18n/I18nProvider";
import type { FleetMemory } from "../types/process";

const MB = 1024 * 1024;
const reading = (sessions: Record<string, number>): FleetMemory => ({
  appBytes: 300 * MB,
  appProcesses: 3,
  appByProgram: [{ name: "hermes", processes: 3, bytes: 300 * MB }],
  disowned: [],
  sessions: Object.entries(sessions).map(([sessionId, mb]) => ({ sessionId, bytes: mb * MB, processes: mb > 0 ? 2 : 0 })),
});

beforeEach(() => {
  vi.useFakeTimers();
  h.flagOn = true;
  h.invoke.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatMemory", () => {
  it("fits a row", () => {
    expect(formatMemory(182 * MB)).toBe("182 MB");
    expect(formatMemory(1000)).toBe("1 MB");
    expect(formatMemory(1536 * MB)).toBe("1.5 GB");
  });
});

describe("createFleetMemoryStore", () => {
  it("polls only while someone listens, and keeps the last reading on a failure", async () => {
    const read = vi.fn<() => Promise<FleetMemory>>(() => Promise.resolve(reading({ a: 120, b: 0 })));
    const store = createFleetMemoryStore(read, 1000);
    expect(read).not.toHaveBeenCalled();
    const woken = vi.fn();
    const stop = store.subscribe(woken);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.bytesOf("a")).toBe(120 * MB);
    expect(store.bytesOf("b")).toBeNull(); // no processes: nothing to show
    expect(woken).toHaveBeenCalledTimes(1);

    read.mockImplementationOnce(() => Promise.reject(new Error("gone")));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.bytesOf("a")).toBe(120 * MB);

    stop();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("SessionMemoryTag", () => {
  const renderTag = (id: string) =>
    render(
      <I18nProvider>
        <SessionMemoryTag sessionId={id} />
      </I18nProvider>,
    );

  it("shows the session's memory once the backend answered", async () => {
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "fleet_memory" ? Promise.resolve(reading({ s1: 182, s2: 6 })) : Promise.reject(new Error(cmd)),
    );
    const view = renderTag("s1");
    await act(async () => {});
    const tag = view.container.querySelector(".session-memory-tag") as HTMLElement;
    expect(tag.textContent).toBe("182 MB");
    expect(tag.dataset.bytes).toBe(String(182 * MB));
    expect(tag.title).toContain("182 MB");
  });

  it("is hidden with the flag off and never asks the backend", async () => {
    h.flagOn = false;
    h.invoke.mockResolvedValue(reading({ s1: 182 }));
    const view = renderTag("s1");
    await act(async () => {});
    expect(view.container.querySelector(".session-memory-tag")).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
