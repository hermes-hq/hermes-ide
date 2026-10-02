// @vitest-environment jsdom
/**
 * The toast store is one list for the whole window (PLN-08): a toast added
 * through any component's useToastStore() is in the list App renders. Before,
 * each call kept a private list, and the Track panel's toasts were never seen.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toastApi, useToastStore, type ToastStore } from "../hooks/useToastStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const stores: Record<string, ToastStore> = {};

function Probe({ name }: { name: string }) {
  stores[name] = useToastStore();
  return <span data-name={name}>{stores[name].toasts.map((t) => t.message).join("|")}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<><Probe name="app" /><Probe name="track" /></>));
});

afterEach(() => {
  act(() => toastApi.clearAll());
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const shown = (name: string) => host.querySelector(`[data-name=${name}]`)?.textContent ?? "";

describe("useToastStore", () => {
  it("shares one list between every caller", () => {
    act(() => {
      stores.track.addToast({ message: "skipped research", type: "info", duration: 4000 });
    });
    expect(shown("app")).toBe("skipped research");
    expect(stores.app.toasts.map((t) => t.message)).toEqual(["skipped research"]);
    act(() => {
      stores.app.dismissToast(stores.app.toasts[0].id);
    });
    expect(shown("track")).toBe("");
  });

  it("times toasts out, keeps persistent ones, and keeps only the last five", () => {
    act(() => {
      stores.track.addToast({ message: "short", type: "success", duration: 1000 });
      stores.track.addToast({ message: "stays", type: "info", duration: null });
    });
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(shown("app")).toBe("stays");
    act(() => {
      for (let i = 0; i < 6; i++) toastApi.addToast({ message: `n${i}`, type: "info", duration: null });
    });
    expect(stores.app.toasts.map((t) => t.message)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(stores.app.toasts.every((t) => t.dismissible)).toBe(true);
  });
});
