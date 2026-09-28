// @vitest-environment jsdom
/**
 * F31 — with the fleetControls flag on, Hermes shows no estimated costs, so
 * View > Cost Dashboard (and its shortcut) is greyed out in the native menu
 * instead of doing nothing. Driven through the real hook with the menu
 * command faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({ updateMenuState: vi.fn(async () => {}) }));
vi.mock("../api/menu", () => ({ updateMenuState: h.updateMenuState }));

import { useMenuStateSync } from "../hooks/useMenuStateSync";

const BASE = {
	sidebarVisible: true,
	processPanelOpen: false,
	gitPanelOpen: false,
	contextPanelOpen: false,
	searchPanelOpen: false,
	flowMode: false,
};

function costDashboardItem(): { id: string; enabled?: boolean } | undefined {
	const calls = h.updateMenuState.mock.calls as unknown as [{ id: string; enabled?: boolean }[]][];
	const last = calls.at(-1)?.[0] ?? [];
	return last.find((u) => u.id === "view.cost-dashboard");
}

describe("F31: the Cost Dashboard menu item follows the flag", () => {
	beforeEach(() => {
		h.updateMenuState.mockClear();
	});

	it("stays enabled when nothing says otherwise (stable)", () => {
		renderHook(() => useMenuStateSync(BASE));
		expect(costDashboardItem()).toEqual({ id: "view.cost-dashboard", enabled: true });
	});

	it("is greyed out when the dashboard is not available, and comes back when it is", () => {
		const hook = renderHook((props: { available: boolean }) => useMenuStateSync({ ...BASE, costDashboardAvailable: props.available }), {
			initialProps: { available: false },
		});
		expect(costDashboardItem()).toEqual({ id: "view.cost-dashboard", enabled: false });
		hook.rerender({ available: true });
		expect(costDashboardItem()).toEqual({ id: "view.cost-dashboard", enabled: true });
	});
});
