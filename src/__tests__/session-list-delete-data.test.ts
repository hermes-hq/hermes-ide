/**
 * F04 (private by default) — "Delete Session Data" context menu action.
 *
 * Tests the confirm-gating helper pulled out of SessionList's context-menu
 * handler: it must only call the delete API after an explicit yes, and
 * never touch anything else on a no.
 */
import { describe, expect, it, vi } from "vitest";
import { confirmAndDeleteSessionData } from "../components/SessionList";

describe("confirmAndDeleteSessionData", () => {
  it("calls deleteSessionData for the given session when confirmed", () => {
    const confirm = vi.fn(() => true);
    const deleteSessionData = vi.fn(() => Promise.resolve());

    confirmAndDeleteSessionData("sess-1", "Delete it?", confirm, deleteSessionData);

    expect(confirm).toHaveBeenCalledWith("Delete it?");
    expect(deleteSessionData).toHaveBeenCalledTimes(1);
    expect(deleteSessionData).toHaveBeenCalledWith("sess-1");
  });

  it("does not call deleteSessionData when the user declines", () => {
    const confirm = vi.fn(() => false);
    const deleteSessionData = vi.fn(() => Promise.resolve());

    confirmAndDeleteSessionData("sess-1", "Delete it?", confirm, deleteSessionData);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteSessionData).not.toHaveBeenCalled();
  });

  it("logs but does not throw if the delete call rejects", async () => {
    const confirm = () => true;
    const error = new Error("backend unavailable");
    const deleteSessionData = vi.fn(() => Promise.reject(error));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => confirmAndDeleteSessionData("sess-1", "Delete it?", confirm, deleteSessionData)).not.toThrow();

    // Let the rejected promise's .catch() run.
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(error);
    consoleError.mockRestore();
  });
});
