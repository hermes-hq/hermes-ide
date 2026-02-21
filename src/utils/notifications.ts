import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let permissionGranted = false;

export async function initNotifications(): Promise<void> {
  permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const permission = await requestPermission();
    permissionGranted = permission === "granted";
  }
}

export function notifyStuck(sessionLabel: string): void {
  if (!permissionGranted) return;
  sendNotification({
    title: "Session may be stuck",
    body: `"${sessionLabel}" is showing repeated errors and may need intervention.`,
  });
}

export function notifyLongRunningDone(sessionLabel: string): void {
  if (!permissionGranted) return;
  sendNotification({
    title: "Task completed",
    body: `"${sessionLabel}" has returned to idle.`,
  });
}
