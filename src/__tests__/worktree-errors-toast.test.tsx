// @vitest-environment jsdom
/**
 * #286 — when createSession fails to create worktrees it dispatches
 * `hermes:worktree-errors` (see SessionContext.createSession).  Before the
 * fix nothing listened, so a fatal failure just closed the SessionCreator
 * with no feedback.  These tests dispatch the real event shape and assert the
 * user sees a toast, using the same wiring as App (useToastStore +
 * useWorktreeErrorToasts + ToastContainer).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useToastStore } from "../hooks/useToastStore";
import { useWorktreeErrorToasts } from "../hooks/useWorktreeErrorToasts";
import { ToastContainer } from "../components/ToastContainer";

function Harness() {
	const toastStore = useToastStore();
	useWorktreeErrorToasts(toastStore.addToast);
	return <ToastContainer toasts={toastStore.toasts} onDismiss={toastStore.dismissToast} />;
}

function dispatchWorktreeErrors(detail: { errors: string[]; sessionLabel?: string; fatal?: boolean }) {
	act(() => {
		window.dispatchEvent(new CustomEvent("hermes:worktree-errors", { detail }));
	});
}

describe("#286 — hermes:worktree-errors is surfaced to the user", () => {
	afterEach(() => cleanup());

	it("shows an error toast when every worktree failed (fatal)", () => {
		const { container } = render(<Harness />);
		expect(container.querySelector(".toast")).toBeNull();

		dispatchWorktreeErrors({
			errors: ["hermes-ide: branch 'feat/x' is already checked out"],
			sessionLabel: "My session",
			fatal: true,
		});

		const msg = screen.getByText(/Session was not created/);
		expect(msg).toHaveTextContent("branch 'feat/x' is already checked out");
		expect(msg.closest(".toast")).toHaveClass("toast-error");
	});

	it("shows a warning toast listing each failure when some worktrees failed (non-fatal)", () => {
		render(<Harness />);

		dispatchWorktreeErrors({
			errors: ["api: disk full", "web: permission denied"],
			sessionLabel: "My session",
		});

		const msg = screen.getByText(/Some projects have no branch isolation/);
		expect(msg).toHaveTextContent("api: disk full; web: permission denied");
		expect(msg.closest(".toast")).toHaveClass("toast-warning");
		expect(screen.queryByText(/Session was not created/)).toBeNull();
	});
});
