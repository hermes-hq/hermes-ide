// @vitest-environment jsdom
/**
 * M9 — onReady contract.  When the SessionCreator modal mounts, it
 * notifies the parent so the parent can dismiss its "opening…"
 * placeholder.  The parent shows immediate feedback the moment the
 * Cmd+N / button is pressed; the placeholder is hidden once
 * SessionCreator's first effect runs.
 *
 * This test pins:
 *   - onReady fires exactly once after mount
 *   - the prop is optional (no crash when omitted)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { SessionCreator } from "../components/SessionCreator";

describe("SessionCreator — onReady contract (M9)", () => {
  afterEach(() => cleanup());

  it("fires onReady exactly once after mount", async () => {
    const onReady = vi.fn();
    render(
      <SessionCreator
        onClose={() => {}}
        onCreate={async () => {}}
        onReady={onReady}
      />,
    );
    // Effects run synchronously in RTL's render — onReady should have
    // fired by now.
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("does not crash when onReady is omitted (optional prop)", () => {
    expect(() => {
      render(
        <SessionCreator
          onClose={() => {}}
          onCreate={async () => {}}
        />,
      );
    }).not.toThrow();
  });
});
