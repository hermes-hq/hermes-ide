import { useState, useCallback, useRef } from "react";

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

export function useToastStore(): ToastStore {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

	const dismissToast = useCallback((id: string) => {
		const timer = timersRef.current.get(id);
		if (timer) {
			clearTimeout(timer);
			timersRef.current.delete(id);
		}
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);

	const addToast = useCallback((toast: Omit<Toast, "id">): string => {
		const id = `toast-${++nextId}`;
		const full: Toast = { ...toast, id, dismissible: toast.dismissible ?? true };

		setToasts((prev) => {
			const next = [...prev, full];
			// Keep only the most recent toasts
			return next.length > MAX_TOASTS ? next.slice(-MAX_TOASTS) : next;
		});

		if (toast.duration !== null) {
			const timer = setTimeout(() => {
				timersRef.current.delete(id);
				setToasts((prev) => prev.filter((t) => t.id !== id));
			}, toast.duration || 3000);
			timersRef.current.set(id, timer);
		}

		return id;
	}, []);

	const clearAll = useCallback(() => {
		for (const timer of timersRef.current.values()) clearTimeout(timer);
		timersRef.current.clear();
		setToasts([]);
	}, []);

	return { toasts, addToast, dismissToast, clearAll };
}
