import { trackEvent } from "@aptabase/tauri";
import { getSetting, setSetting } from "../api/settings";

let enabled = false;

export async function initAnalytics(): Promise<void> {
  const stored = await getSetting("telemetry_enabled").catch(() => null);
  enabled = stored === "true";
}

export function setAnalyticsEnabled(value: boolean): void {
  enabled = value;
  setSetting("telemetry_enabled", value ? "true" : "false").catch(console.error);
}

function track(name: string, props?: Record<string, string | number>): void {
  if (!enabled) return;
  try {
    trackEvent(name, props);
  } catch {
    // silently ignore
  }
}

export function trackAppStarted(): void {
  track("app_started");
}

export function trackSessionCreated(props: {
  execution_mode: string;
  has_ai_provider: boolean;
}): void {
  track("session_created", {
    execution_mode: props.execution_mode,
    has_ai_provider: props.has_ai_provider ? 1 : 0,
  });
}

export function trackFeatureUsed(feature: string): void {
  track("feature_used", { feature });
}
