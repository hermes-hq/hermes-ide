import "../styles/components/UpdateDialog.css";
import { open } from "@tauri-apps/plugin-shell";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UpdateState } from "../hooks/useAutoUpdater";

interface UpdateDialogProps {
  state: UpdateState;
  onDismiss: () => void;
  onDownload: () => void;
}

export function UpdateDialog({ state, onDismiss, onDownload }: UpdateDialogProps) {
  if (!state.available || state.dismissed) return null;

  return (
    <div className="update-dialog-backdrop" onClick={onDismiss}>
      <div className="update-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="update-dialog-header">
          <span className="update-dialog-title">Update Available</span>
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
                className="update-dialog-progress-fill"
                style={{ width: `${state.progress}%` }}
              />
            </div>
            <div className="update-dialog-progress-label">
              Downloading... {state.progress}%
            </div>
          </div>
        )}

        <div className="update-dialog-actions">
          <button
            className="update-dialog-btn"
            onClick={() => open("https://hermes-ide.com/changelog")}
          >
            Changelog
          </button>

          {!state.readyToInstall && (
            <button className="update-dialog-btn" onClick={onDismiss}>
              Later
            </button>
          )}

          {state.readyToInstall ? (
            <button
              className="update-dialog-btn update-dialog-btn-primary"
              onClick={() => getCurrentWindow().close()}
            >
              Quit &amp; Update
            </button>
          ) : (
            <button
              className="update-dialog-btn update-dialog-btn-primary"
              onClick={onDownload}
              disabled={state.downloading}
            >
              {state.downloading ? "Downloading..." : "Update"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
