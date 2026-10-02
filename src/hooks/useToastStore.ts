import { useSyncExternalStore } from "react";

export type ToastType = "info" | "success" | "warning" | "error";

export interface ToastAction {
	label: string;
	primary?: boolean;
	onClick: () => void;
}

export interface Toast {
	id: string;
	message: string;
	type: ToastType;
	duration: number | null; // null = persistent (must be dismissed manually)
	actions?: ToastAction[];
	dismissible?: boolean;
}

export interface ToastStore {
	toasts: Toast[];
	addToast: (toast: Omit<Toast, "id">) => string;
	dismissToast: (id: string) => void;
	clearAll: () => void;
}

const MAX_TOASTS = 5;
let nextId = 0;

// One list for the whole window: every component that calls useToastStore()
// adds to the list App renders (a private list per component would show
// nothing — the Track panel's toasts were lost that way).
let toasts: Toast[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function publish(next: Toast[]): void {
	toasts = next;
	for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

const snapshot = (): Toast[] => toasts;

function dismissToast(id: string): void {
	const timer = timers.get(id);
	if (timer) {
		clearTimeout(timer);
		timers.delete(id);
	}
	if (toasts.some((t) => t.id === id)) publish(toasts.filter((t) => t.id !== id));
}

function addToast(toast: Omit<Toast, "id">): string {
	const id = `toast-${++nextId}`;
	const full: Toast = { ...toast, id, dismissible: toast.dismissible ?? true };
	const next = [...toasts, full];
	// Keep only the most recent toasts.
	const kept = next.length > MAX_TOASTS ? next.slice(-MAX_TOASTS) : next;
	for (const gone of next.slice(0, next.length - kept.length)) {
		const timer = timers.get(gone.id);
		if (timer) clearTimeout(timer);
		timers.delete(gone.id);
	}
	publish(kept);
	if (toast.duration !== null) {
		timers.set(
			id,
			setTimeout(() => {
				timers.delete(id);
				dismissToast(id);
			}, toast.duration || 3000),
		);
	}
	return id;
}

function clearAll(): void {
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	publish([]);
}

/** Add a toast from outside React (it shows in the window's one list). */
export const toastApi = { addToast, dismissToast, clearAll } as const;

export function useToastStore(): ToastStore {
	const list = useSyncExternalStore(subscribe, snapshot, snapshot);
	return { toasts: list, addToast, dismissToast, clearAll };
}
