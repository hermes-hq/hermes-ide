// Test builds only (VITE_HERMES_E2E=1): loaded by DialogGalleryHost the
// first time a scenario asks for a dialog, never at startup. A real-app scenario (e2e/app/scenarios/
// UI-dialogs.mjs) opens a dialog whose real trigger needs state a test run
// cannot make cheaply — a working agent at quit, a branch held by another
// checkout, a plugin with an update — by name, through
// window.__HERMES_E2E__.showDialog(name). Each is the app's own component,
// inside the app's own providers and stylesheets, given synthetic data. The
// dialogs with a cheap real trigger (close a session, an update, a toast,
// the project picker, Settings > Plugins) are opened for real instead.

import type { CSSProperties, ReactNode } from "react";
import { useSession } from "../state/SessionContext";
import { QuitWithAgentsDialog } from "../components/QuitWithAgentsDialog";
import { PluginUpdateConfirmDialog } from "../components/PluginUpdateConfirmDialog";
import { WhatsNewDialog } from "../components/WhatsNewDialog";
import { HandoffDialog } from "../components/HandoffDialog";
import { BranchConflictDialog } from "../components/BranchConflictDialog";
import { DirtyWorktreeDialog } from "../components/DirtyWorktreeDialog";
import { PermissionRequestModal } from "../components/PermissionRequestModal";
import { WorkspacePanel } from "../components/WorkspacePanel";
import { ShortcutsPanel } from "../components/ShortcutsPanel";
import { CostDashboard } from "../components/CostDashboard";
import { AddMcpDialog } from "../components/AddMcpDialog";
import { StartupProblemScreen } from "../components/StartupProblemScreen";
import { BranchMismatchAlert } from "../components/BranchMismatchAlert";
import { ContainedErrorBoundary } from "../components/ContainedErrorBoundary";
import { KillConfirmDialog } from "../components/ProcessPanel";
import { ToastContainer } from "../components/ToastContainer";
import { Button } from "../components/ui";
import { WHATS_NEW_PREVIEW_STORAGE_KEY } from "../components/startupDialogSettings";
import { changelog } from "../data/changelog";
import { translate } from "../i18n/registry";

export const GALLERY_DIALOGS = [
	"quit-with-agents",
	"plugin-update",
	"whats-new",
	"handoff",
	"branch-conflict",
	"dirty-worktree",
	"permission-request",
	"workspace",
	"shortcuts",
	"cost",
	"add-mcp",
	"startup-problem",
	"branch-mismatch",
	"pane-crash",
	"process-kill",
	"toast-actions",
] as const;
export type GalleryDialog = (typeof GALLERY_DIALOGS)[number];

/** An inline surface (the permission card, a crashed pane) shown the way it sits in the app: over the workspace. */
const stage: CSSProperties = {
	position: "fixed",
	inset: 0,
	zIndex: 900,
	display: "grid",
	placeItems: "center",
	background: "var(--bg-0)",
};

function Stage({ width, height, children }: { width: string; height?: string; children: ReactNode }) {
	return (
		<div style={stage} data-testid="e2e-dialog-stage">
			<div style={{ width, height, display: "flex", flexDirection: "column" }}>{children}</div>
		</div>
	);
}

function Crash(): ReactNode {
	throw new Error("synthetic crash for the dialog check");
}

const noop = () => {};
const CRASHED_PANE = "demo";
const noopAsync = async () => {};

function render(name: GalleryDialog, close: () => void, firstSession: ReturnType<typeof useSession>["state"]["sessions"][string] | undefined) {
	switch (name) {
		case "quit-with-agents":
			return (
				<QuitWithAgentsDialog
					sessions={[
						{ id: "e2e-a", label: "Fix the login redirect" },
						{ id: "e2e-b", label: "Write the release notes" },
					]}
					onKeep={close}
					onStop={close}
					onCancel={close}
				/>
			);
		case "plugin-update":
			return (
				<PluginUpdateConfirmDialog
					plugins={[
						{
							id: "e2e.sample",
							name: "Sample plugin",
							currentVersion: "1.0.0",
							newVersion: "1.2.0",
							downloadUrl: "https://example.invalid/sample.tgz",
							changelog: [
								{ version: "1.2.0", date: "2026-09-01", changes: ["Faster start", "Fixes the empty state"] },
								{ version: "1.1.0", date: "2026-08-01", changes: ["Adds a setting"] },
							],
						},
						{ id: "e2e.other", name: "Other plugin", currentVersion: "2.0.0", newVersion: "2.0.1", downloadUrl: "https://example.invalid/other.tgz" },
					]}
					onConfirm={close}
					onCancel={close}
				/>
			);
		case "whats-new": {
			// The dialog's own preview path (a DevTools switch): shows the notes of that version.
			const version = Object.keys(changelog)[0];
			window.localStorage.setItem(WHATS_NEW_PREVIEW_STORAGE_KEY, version);
			return <WhatsNewDialog version={version} />;
		}
		case "handoff":
			return firstSession ? <HandoffDialog session={firstSession} initialKind="continue" onClose={close} /> : null;
		case "branch-conflict":
			return (
				<BranchConflictDialog
					branchName="hermes/search-index"
					heldBy='session "Search index"'
					path="/work/demo/.hermes/worktrees/search-index"
					onReuse={close}
					onCreateNewBranch={close}
					onCancel={close}
				/>
			);
		case "dirty-worktree":
			return (
				<DirtyWorktreeDialog
					sessionId="e2e-a"
					sessionLabel="Fix the login redirect"
					variant="commit"
					changes={[
						{
							projectId: "e2e-p",
							projectName: "demo",
							branchName: "hermes/login-redirect",
							files: [
								{ path: "src/login.ts", status: "modified" },
								{ path: "src/redirect.ts", status: "added" },
							],
						},
					]}
					onStashAndClose={noopAsync}
					onCommitAndClose={noopAsync}
					onArchiveAndClose={noopAsync}
					onCloseAnyway={close}
					onCancel={close}
				/>
			);
		case "permission-request":
			return (
				<Stage width="min(640px, 92vw)">
					<PermissionRequestModal
						request={{ type: "_hermes_perm_request", id: "e2e", toolName: "Bash", input: { command: "npm test", description: "Run the tests" } }}
						permissionMode="default"
						canPersist
						onDecision={close}
					/>
				</Stage>
			);
		case "workspace":
			return <WorkspacePanel onClose={close} />;
		case "shortcuts":
			return <ShortcutsPanel onClose={close} />;
		case "cost":
			return <CostDashboard onClose={close} />;
		case "add-mcp":
			return <AddMcpDialog existingNames={[]} onClose={close} />;
		case "startup-problem":
			return (
				<Stage width="100vw" height="100vh">
					<StartupProblemScreen
						problem={{
							kind: "newer-data",
							title: "This data was saved by a newer Hermes",
							message: "Update Hermes to open it.",
							dataPath: "/work/hermes-data/hermes.db",
							found: 99,
							supported: 42,
						}}
						onQuit={close}
					/>
				</Stage>
			);
		case "branch-mismatch":
			return <BranchMismatchAlert branch="hermes/search-index" sessionLabel="Search index" onDismiss={noop} />;
		case "process-kill":
			// Kill Process Tree with SIGKILL: the warning shows, the confirm is danger-solid.
			return (
				<KillConfirmDialog
					processName="node"
					pid={4242}
					signal="SIGKILL"
					isTree
					onConfirm={close}
					onCancel={close}
					skipConfirm={false}
					onToggleSkip={noop}
				/>
			);
		case "toast-actions":
			// Two actions given primary first: the toast still puts the primary right-most.
			return (
				<ToastContainer
					toasts={[
						{
							id: "e2e-toast",
							message: "2 plugin updates available",
							type: "info",
							duration: null,
							actions: [
								{ label: "Review & Update", primary: true, onClick: noop },
								{ label: "Later", onClick: noop },
							],
						},
					]}
					onDismiss={close}
				/>
			);
		case "pane-crash":
			return (
				<Stage width="min(720px, 92vw)" height="60vh">
					<ContainedErrorBoundary scope="pane" label={CRASHED_PANE} actions={<Button onClick={close}>{translate("crash.closePane")}</Button>}>
						<Crash />
					</ContainedErrorBoundary>
				</Stage>
			);
	}
}

export function DialogGallery({ name, onClose }: { name: GalleryDialog; onClose: () => void }) {
	const { state } = useSession();
	const first = Object.values(state.sessions)[0];
	return (
		<div data-testid="e2e-dialog-gallery" data-dialog={name}>
			{render(name, onClose, first)}
		</div>
	);
}
