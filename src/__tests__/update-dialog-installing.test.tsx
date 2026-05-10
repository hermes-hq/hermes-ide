// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => cleanup());
import { UpdateDialog } from "../components/UpdateDialog";
import type { UpdateState } from "../hooks/useAutoUpdater";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const baseReady: UpdateState = {
  available: true, version: "1.2.3", notes: "Cool stuff",
  downloading: false, progress: 100, downloadedBytes: 0, totalBytes: 0,
  ready: true, dismissed: false, dismissedVersion: "",
  error: false, stalled: false, installing: false,
};

describe("UpdateDialog — install busy feedback", () => {
  it("primary button is enabled and labelled 'Install & Relaunch' when not installing", () => {
    render(
      <UpdateDialog state={baseReady} onDismiss={vi.fn()}
        onDownload={vi.fn()} onCancel={vi.fn()} onInstall={vi.fn()} />
    );
    const btn = screen.getByRole("button", { name: /install & relaunch/i });
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute("aria-busy");
  });

  it("primary button is disabled and shows 'Installing…' when state.installing is true", () => {
    render(
      <UpdateDialog state={{ ...baseReady, installing: true }}
        onDismiss={vi.fn()} onDownload={vi.fn()} onCancel={vi.fn()} onInstall={vi.fn()} />
    );
    const btn = screen.getByRole("button", { name: /installing/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });

  it("'Later' button is hidden during install", () => {
    render(
      <UpdateDialog state={{ ...baseReady, installing: true }}
        onDismiss={vi.fn()} onDownload={vi.fn()} onCancel={vi.fn()} onInstall={vi.fn()} />
    );
    expect(screen.queryByRole("button", { name: /^later$/i })).toBeNull();
  });

  it("backdrop click does NOT dismiss while installing", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <UpdateDialog state={{ ...baseReady, installing: true }}
        onDismiss={onDismiss} onDownload={vi.fn()} onCancel={vi.fn()} onInstall={vi.fn()} />
    );
    const backdrop = container.querySelector(".update-dialog-backdrop")!;
    (backdrop as HTMLElement).click();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
