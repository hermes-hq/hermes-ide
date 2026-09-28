import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let permissionGranted = false;

export async function initNotifications(): Promise<void> {
  permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const permission = await requestPermission();
    permissionGranted = permission === "granted";
  }
}

export function notifyLongRunningDone(sessionLabel: string): void {
  if (!permissionGranted) return;
  sendNotification({
    title: "Task completed",
    body: `"${sessionLabel}" has returned to idle.`,
  });
}

/**
 * An attention notification (F12): something is blocked on you or done.
 * Returns whether it was handed to the OS (false without permission).
 */
export function notifyAttention(title: string, body: string): boolean {
  if (!permissionGranted) return false;
  sendNotification({ title, body });
  return true;
}
