// @vitest-environment jsdom
/**
 * N10 — the <UpdateDialog> half: while a session is busy, the ordinary
 * "Install & Relaunch" button is replaced by a waiting message and a
 * "Relaunch now" override; once idle, it reverts to normal.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => cleanup());
import { UpdateDialog } from "../components/UpdateDialog";
import type { UpdateState } from "../hooks/useAutoUpdater";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const baseReady: UpdateState = {
  available: true, version: "1.2.3", notes: "Cool stuff",
  downloading: false, progress: 100, downloadedBytes: 0, totalBytes: 0,
  ready: true, dismissed: false, dismissedVersion: "",
  error: false, stalled: false, installing: false, busySessionCount: 0,
};

function renderDialog(state: UpdateState, overrides: Partial<Record<string, () => void>> = {}) {
  const onInstall = overrides.onInstall ?? vi.fn();
  const onRelaunchNow = overrides.onRelaunchNow ?? vi.fn();
  render(
    <UpdateDialog
      state={state}
      onDismiss={vi.fn()}
      onDownload={vi.fn()}
      onCancel={vi.fn()}
      onInstall={onInstall}
      onRelaunchNow={onRelaunchNow}
    />,
  );
  return { onInstall, onRelaunchNow };
}

describe("UpdateDialog — waits for idle (N10)", () => {
  it("idle (busySessionCount 0): shows the ordinary 'Install & Relaunch' button", () => {
    renderDialog(baseReady);
    expect(screen.getByRole("button", { name: /install & relaunch/i })).toBeEnabled();
    expect(screen.queryByText(/waiting for/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /relaunch now/i })).toBeNull();
  });

  it("busy (busySessionCount 1): shows the waiting message and the override button, no 'Install & Relaunch'", () => {
    renderDialog({ ...baseReady, busySessionCount: 1 });
    expect(screen.getByText(/update ready, waiting for 1 working agent$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /relaunch now/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^install & relaunch$/i })).toBeNull();
  });

  it("busy with several sessions: pluralises the message", () => {
    renderDialog({ ...baseReady, busySessionCount: 3 });
    expect(screen.getByText(/update ready, waiting for 3 working agents$/i)).toBeInTheDocument();
  });

  it("clicking 'Relaunch now' while busy calls the override handler, not onInstall", () => {
    const { onInstall, onRelaunchNow } = renderDialog({ ...baseReady, busySessionCount: 2 });
    fireEvent.click(screen.getByRole("button", { name: /relaunch now/i }));
    expect(onRelaunchNow).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("clicking 'Install & Relaunch' while idle calls onInstall", () => {
    const { onInstall } = renderDialog(baseReady);
    fireEvent.click(screen.getByRole("button", { name: /install & relaunch/i }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("busy but already installing: no waiting message (installing state wins)", () => {
    renderDialog({ ...baseReady, busySessionCount: 1, installing: true });
    expect(screen.queryByText(/waiting for/i)).toBeNull();
    expect(screen.getByRole("button", { name: /installing/i })).toBeInTheDocument();
  });

  it("not yet ready (still downloading target): busy count is irrelevant to the button", () => {
    renderDialog({ ...baseReady, ready: false, downloading: false, busySessionCount: 5 });
    expect(screen.getByRole("button", { name: /update now/i })).toBeInTheDocument();
    expect(screen.queryByText(/waiting for/i)).toBeNull();
  });
});
