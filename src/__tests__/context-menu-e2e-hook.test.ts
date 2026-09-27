// @vitest-environment jsdom
/**
 * showContextMenu hands the menu to the real-app test rig's hook only in
 * test builds (VITE_HERMES_E2E=1); every other build opens the native popup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { menuItem, showContextMenu } from "../api/menu";

type HookWindow = { __HERMES_E2E_MENU__?: (items: unknown[]) => Promise<void> };
const win = window as unknown as HookWindow;
const items = [menuItem("session.delete-data", "Delete Session Data...")];

afterEach(() => {
	vi.unstubAllEnvs();
	delete win.__HERMES_E2E_MENU__;
	invoke.mockClear();
});

describe("showContextMenu", () => {
	it("opens the native popup in a normal build even when a hook is present", async () => {
		const hook = vi.fn(() => Promise.resolve());
		win.__HERMES_E2E_MENU__ = hook;
		await showContextMenu(items);
		expect(invoke).toHaveBeenCalledWith("show_context_menu", { items });
		expect(hook).not.toHaveBeenCalled();
	});

	it("hands the menu to the rig's hook in a test build", async () => {
		vi.stubEnv("VITE_HERMES_E2E", "1");
		const hook = vi.fn(() => Promise.resolve());
		win.__HERMES_E2E_MENU__ = hook;
		await showContextMenu(items);
		expect(hook).toHaveBeenCalledWith(items);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("opens the native popup in a test build when no hook is installed", async () => {
		vi.stubEnv("VITE_HERMES_E2E", "1");
		await showContextMenu(items);
		expect(invoke).toHaveBeenCalledWith("show_context_menu", { items });
	});
});
