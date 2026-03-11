import { useEffect, useRef } from "react";
import type { PluginUpdater } from "../hooks/usePluginUpdateChecker";
import type { ToastStore } from "../hooks/useToastStore";

interface PluginUpdateNotifierProps {
	updater: PluginUpdater;
	toastStore: ToastStore;
	onShowUpdateConfirm?: () => void;
}

/**
 * Effect-only component: watches plugin update state and pushes toasts
 * to the shared toast system. Renders nothing to the DOM.
 */
export function PluginUpdateBanner({ updater, toastStore, onShowUpdateConfirm }: PluginUpdateNotifierProps) {
	const { updatesAvailable, updateResults, autoUpdated, dismissed, updateAll, dismissAll, clearResults } = updater;

	// Track which state snapshots we've already shown toasts for,
	// so we don't re-show on every render cycle.
	const shownUpdatesRef = useRef(false);
	const shownResultsRef = useRef(false);
	const prevUpdatesCountRef = useRef(0);
	const prevResultsCountRef = useRef(0);

	// ─── Updates available → toast ─────────────────────────
	useEffect(() => {
		if (dismissed) return;
		if (updatesAvailable.length === 0) {
			shownUpdatesRef.current = false;
			prevUpdatesCountRef.current = 0;
			return;
		}
		// Only show if the count changed (avoids duplicate toasts on re-render)
		if (shownUpdatesRef.current && updatesAvailable.length === prevUpdatesCountRef.current) return;
		shownUpdatesRef.current = true;
		prevUpdatesCountRef.current = updatesAvailable.length;

		const count = updatesAvailable.length;
		const names = updatesAvailable.map((u) => u.name).join(", ");
		const message = count === 1
			? `Plugin update available: ${names}`
			: `${count} plugin updates available: ${names}`;

		toastStore.addToast({
			message,
			type: "info",
			duration: null, // persistent — user must act
			actions: [
				{
					label: "Review & Update",
					primary: true,
					onClick: () => {
						if (onShowUpdateConfirm) {
							onShowUpdateConfirm();
						} else {
							updateAll();
						}
					},
				},
				{ label: "Later", onClick: () => dismissAll() },
			],
		});
	}, [updatesAvailable, dismissed, toastStore, updateAll, dismissAll, onShowUpdateConfirm]);

	// ─── Post-update results → toast ───────────────────────
	useEffect(() => {
		if (updateResults.length === 0) {
			shownResultsRef.current = false;
			prevResultsCountRef.current = 0;
			return;
		}
		if (shownResultsRef.current && updateResults.length === prevResultsCountRef.current) return;
		shownResultsRef.current = true;
		prevResultsCountRef.current = updateResults.length;

		const successCount = updateResults.filter((r) => r.success).length;
		const failCount = updateResults.filter((r) => !r.success).length;

		let message: string;
		if (autoUpdated) {
			message = `${successCount} plugin${successCount !== 1 ? "s were" : " was"} automatically updated`;
		} else {
			message = `${successCount} plugin${successCount !== 1 ? "s" : ""} updated successfully`;
		}
		if (failCount > 0) {
			message += ` (${failCount} failed)`;
		}

		toastStore.addToast({
			message,
			type: failCount > 0 ? "warning" : "success",
			duration: 8000,
			actions: [
				{ label: "Dismiss", onClick: () => clearResults() },
			],
		});
	}, [updateResults, autoUpdated, toastStore, clearResults]);

	return null;
}
