import "../styles/components/UpdateDialog.css";
import { open } from "@tauri-apps/plugin-shell";
import type { UpdateState } from "../hooks/useAutoUpdater";

interface UpdateDialogProps {
  state: UpdateState;
  onDismiss: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onInstall: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateDialog({ state, onDismiss, onDownload, onCancel, onInstall }: UpdateDialogProps) {
  if (!state.available || state.dismissed) return null;

  const showByteProgress = state.downloading && state.totalBytes > 0;

  return (
    <div className="update-dialog-backdrop" onClick={state.downloading ? undefined : onDismiss}>
      <div className="update-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="update-dialog-header">
          <span className="update-dialog-title">
            {state.ready ? "Ready to Install" : "Update Available"}
          </span>
          <span className="update-dialog-tag">v{state.version}</span>
        </div>
        <div className="update-dialog-subtitle">
          You&rsquo;re currently on v{__APP_VERSION__}
        </div>

        {state.notes && (
          <div className="update-dialog-notes">{state.notes}</div>
        )}

        {state.downloading && (
          <div className="update-dialog-progress">
            <div className="update-dialog-progress-bar">
              <div
                className={`update-dialog-progress-fill${state.stalled ? " update-dialog-progress-stalled" : ""}`}
                style={{ width: `${state.progress}%` }}
              />
            </div>
            <div className="update-dialog-progress-label">
              {showByteProgress
                ? `${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}`
                : `Downloading... ${state.progress}%`}
              {state.stalled && (
                <span className="update-dialog-stall-warning"> · Slow connection</span>
              )}
            </div>
          </div>
        )}

        {state.ready && !state.error && (
          <div className="update-dialog-ready">
            Download complete. Click below to install and restart.
          </div>
        )}

        {state.error && !state.downloading && (
          <div className="update-dialog-error">
            {state.ready ? "Install failed. Try again." : "Download failed. Check your connection and try again."}
          </div>
        )}

        <div className="update-dialog-actions">
          <button
            className="update-dialog-btn"
            onClick={() => open("https://hermes-ide.com/changelog")}
          >
            Changelog
          </button>

          {state.downloading ? (
            <button className="update-dialog-btn update-dialog-btn-cancel" onClick={onCancel}>
              Cancel
            </button>
          ) : (
            <button className="update-dialog-btn" onClick={onDismiss}>
              Later
            </button>
          )}

          {state.ready ? (
            <button
              className="update-dialog-btn update-dialog-btn-primary"
              onClick={onInstall}
            >
              Install &amp; Relaunch
            </button>
          ) : (
            <button
              className="update-dialog-btn update-dialog-btn-primary"
              onClick={onDownload}
              disabled={state.downloading}
            >
              {state.downloading ? `Downloading ${state.progress}%` : state.error ? "Retry" : "Update Now"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
