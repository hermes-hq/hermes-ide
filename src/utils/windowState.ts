import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { setSetting } from "../api/settings";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Windows parks minimized windows at (-32000, -32000) physical, which is saved as
 * -32000 / scale in logical pixels (e.g. -21333 at 150%). Treat anything this far
 * off-screen as that sentinel, whatever the display scale.
 */
const MINIMIZED_THRESHOLD = -10000;

/** True when the top strip of a window at (x, y) (logical) is visible on some monitor. */
async function isPositionVisible(x: number, y: number, w: number): Promise<boolean> {
  if (x <= MINIMIZED_THRESHOLD || y <= MINIMIZED_THRESHOLD) return false;
  let monitors;
  try {
    monitors = await availableMonitors();
  } catch {
    // Can't verify: let the OS place the window rather than risk restoring it off-screen.
    return false;
  }
  if (!monitors.length) return false;
  return monitors.some((m) => {
    const f = m.scaleFactor || 1;
    const mx = m.position.x / f;
    const my = m.position.y / f;
    const mw = m.size.width / f;
    const mh = m.size.height / f;
    // Require at least 100px of the title bar region to be on this monitor.
    return x + w - 100 >= mx && x + 100 <= mx + mw && y >= my - 10 && y + 30 <= my + mh;
  });
}

/** Restore saved window size/position from settings, then start tracking changes. */
export async function restoreWindowState(settings: Record<string, string>): Promise<void> {
  const win = getCurrentWindow();

  const rawW = parseInt(settings.window_width || "", 10);
  const rawH = parseInt(settings.window_height || "", 10);
  const x = parseInt(settings.window_x || "", 10);
  const y = parseInt(settings.window_y || "", 10);

  let w = 1200;
  if (rawW > 0 && rawH > 0) {
    w = Math.max(rawW, 600);
    const h = Math.max(rawH, 400);
    await win.setSize(new LogicalSize(w, h));
  }
  if (!isNaN(x) && !isNaN(y) && (await isPositionVisible(x, y, w))) {
    await win.setPosition(new LogicalPosition(x, y));
  }

  startTracking();
}

function startTracking(): void {
  const win = getCurrentWindow();

  const save = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        // Minimizing on Windows fires move/resize with (-32000, -32000) and a 0x0 size.
        if (await win.isMinimized()) return;
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const factor = await win.scaleFactor();
        // Convert physical to logical
        const lw = Math.round(size.width / factor);
        const lh = Math.round(size.height / factor);
        const lx = Math.round(pos.x / factor);
        const ly = Math.round(pos.y / factor);

        setSetting("window_width", String(lw)).catch(() => {});
        setSetting("window_height", String(lh)).catch(() => {});
        setSetting("window_x", String(lx)).catch(() => {});
        setSetting("window_y", String(ly)).catch(() => {});
      } catch {
        /* window may be closing */
      }
    }, 500);
  };

  win.onResized(save);
  win.onMoved(save);
}
