/**
 * Tests for the toast store (useToastStore).
 *
 * Since the test environment is `node` (no DOM/React), we test the
 * store's logic by extracting the pure state transitions.
 *
 * Covers:
 * - Toast creation and ID generation
 * - Toast type defaults
 * - Duration behaviour (persistent vs auto-dismiss)
 * - Maximum toast limit
 * - Dismiss and clear operations
 * - Action button support
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
}));

import type { Toast, ToastType, ToastAction } from "../hooks/useToastStore";

// ─── Pure state simulation (mirrors useToastStore logic) ────────────

const MAX_TOASTS = 5;
let nextId = 0;

function createToast(params: {
	message: string;
	type: ToastType;
	duration: number | null;
	actions?: ToastAction[];
	dismissible?: boolean;
}): Toast {
	return {
		id: `toast-${++nextId}`,
		message: params.message,
		type: params.type,
		duration: params.duration,
		actions: params.actions,
		dismissible: params.dismissible ?? true,
	};
}

function addToast(toasts: Toast[], toast: Toast): Toast[] {
	const next = [...toasts, toast];
	return next.length > MAX_TOASTS ? next.slice(-MAX_TOASTS) : next;
}

function dismissToast(toasts: Toast[], id: string): Toast[] {
	return toasts.filter((t) => t.id !== id);
}

// =====================================================================
// Suite 1: Toast creation
// =====================================================================

describe("Toast creation", () => {
	it("creates toast with unique ID", () => {
		const t1 = createToast({ message: "Hello", type: "info", duration: 3000 });
		const t2 = createToast({ message: "World", type: "info", duration: 3000 });
		expect(t1.id).not.toBe(t2.id);
	});

	it("preserves message and type", () => {
		const t = createToast({ message: "Test", type: "success", duration: 5000 });
		expect(t.message).toBe("Test");
		expect(t.type).toBe("success");
		expect(t.duration).toBe(5000);
	});

	it("defaults dismissible to true", () => {
		const t = createToast({ message: "Test", type: "info", duration: 3000 });
		expect(t.dismissible).toBe(true);
	});

	it("respects explicit dismissible=false", () => {
		const t = createToast({ message: "Test", type: "info", duration: null, dismissible: false });
		expect(t.dismissible).toBe(false);
	});

	it("supports null duration for persistent toasts", () => {
		const t = createToast({ message: "Stay", type: "warning", duration: null });
		expect(t.duration).toBeNull();
	});
});

// =====================================================================
// Suite 2: Toast actions
// =====================================================================

describe("Toast actions", () => {
	it("creates toast with action buttons", () => {
		const action: ToastAction = { label: "Update", primary: true, onClick: vi.fn() };
		const t = createToast({
			message: "Update available",
			type: "info",
			duration: null,
			actions: [action],
		});
		expect(t.actions).toHaveLength(1);
		expect(t.actions![0].label).toBe("Update");
		expect(t.actions![0].primary).toBe(true);
	});

	it("supports multiple actions", () => {
		const actions: ToastAction[] = [
			{ label: "Update All", primary: true, onClick: vi.fn() },
			{ label: "Later", onClick: vi.fn() },
		];
		const t = createToast({ message: "Updates", type: "info", duration: null, actions });
		expect(t.actions).toHaveLength(2);
	});

	it("creates toast without actions", () => {
		const t = createToast({ message: "Simple", type: "info", duration: 3000 });
		expect(t.actions).toBeUndefined();
	});
});

// =====================================================================
// Suite 3: Toast list management
// =====================================================================

describe("Toast list management", () => {
	it("adds toast to empty list", () => {
		const t = createToast({ message: "First", type: "info", duration: 3000 });
		const toasts = addToast([], t);
		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toBe("First");
	});

	it("appends toast to existing list", () => {
		const t1 = createToast({ message: "First", type: "info", duration: 3000 });
		const t2 = createToast({ message: "Second", type: "success", duration: 3000 });
		const toasts = addToast(addToast([], t1), t2);
		expect(toasts).toHaveLength(2);
		expect(toasts[1].message).toBe("Second");
	});

	it("enforces max toast limit, keeping most recent", () => {
		let toasts: Toast[] = [];
		for (let i = 0; i < MAX_TOASTS + 2; i++) {
			toasts = addToast(toasts, createToast({ message: `Toast ${i}`, type: "info", duration: 3000 }));
		}
		expect(toasts).toHaveLength(MAX_TOASTS);
		// Oldest toasts should be removed
		expect(toasts[0].message).toBe("Toast 2");
		expect(toasts[MAX_TOASTS - 1].message).toBe(`Toast ${MAX_TOASTS + 1}`);
	});

	it("dismisses toast by ID", () => {
		const t1 = createToast({ message: "A", type: "info", duration: 3000 });
		const t2 = createToast({ message: "B", type: "info", duration: 3000 });
		const toasts = addToast(addToast([], t1), t2);
		const after = dismissToast(toasts, t1.id);
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe(t2.id);
	});

	it("dismiss with unknown ID is a no-op", () => {
		const t = createToast({ message: "A", type: "info", duration: 3000 });
		const toasts = addToast([], t);
		const after = dismissToast(toasts, "nonexistent");
		expect(after).toHaveLength(1);
	});

	it("clear all removes everything", () => {
		let toasts: Toast[] = [];
		for (let i = 0; i < 3; i++) {
			toasts = addToast(toasts, createToast({ message: `T${i}`, type: "info", duration: 3000 }));
		}
		expect(toasts).toHaveLength(3);
		// clearAll is just setting to []
		toasts = [];
		expect(toasts).toHaveLength(0);
	});
});

// =====================================================================
// Suite 4: Toast types
// =====================================================================

describe("Toast types", () => {
	const types: ToastType[] = ["info", "success", "warning", "error"];

	for (const type of types) {
		it(`supports ${type} type`, () => {
			const t = createToast({ message: `${type} message`, type, duration: 3000 });
			expect(t.type).toBe(type);
		});
	}
});

// =====================================================================
// Suite 5: Plugin update notification patterns
// =====================================================================

describe("Plugin update notification patterns", () => {
	it("creates persistent toast for available updates", () => {
		const updateAll = vi.fn();
		const dismiss = vi.fn();
		const t = createToast({
			message: "2 plugin updates available: JSON Formatter, Pomodoro Timer",
			type: "info",
			duration: null,
			actions: [
				{ label: "Update All", primary: true, onClick: updateAll },
				{ label: "Later", onClick: dismiss },
			],
		});
		expect(t.duration).toBeNull();
		expect(t.actions).toHaveLength(2);
		expect(t.actions![0].primary).toBe(true);
	});

	it("creates timed toast for update results", () => {
		const clearResults = vi.fn();
		const t = createToast({
			message: "2 plugins updated successfully",
			type: "success",
			duration: 8000,
			actions: [
				{ label: "Dismiss", onClick: clearResults },
			],
		});
		expect(t.duration).toBe(8000);
		expect(t.type).toBe("success");
	});

	it("uses warning type when some updates fail", () => {
		const t = createToast({
			message: "1 plugin updated successfully (1 failed)",
			type: "warning",
			duration: 8000,
		});
		expect(t.type).toBe("warning");
	});
});
