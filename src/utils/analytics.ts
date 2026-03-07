import { init, trackEvent } from "@aptabase/web";
import { getSetting, setSetting } from "../api/settings";

const APP_ID = "A-EU-1922161061";

let enabled = false;

export async function initAnalytics(): Promise<void> {
  const stored = await getSetting("telemetry_enabled").catch(() => null);
  enabled = stored === "true";
  if (enabled) {
    init(APP_ID);
  }
}

export function setAnalyticsEnabled(value: boolean): void {
  enabled = value;
  setSetting("telemetry_enabled", value ? "true" : "false").catch(console.error);
  if (value) {
    init(APP_ID);
  }
}

function track(name: string, props?: Record<string, string | number | boolean>): void {
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
  track("session_created", props);
}

export function trackFeatureUsed(feature: string): void {
  track("feature_used", { feature });
}
