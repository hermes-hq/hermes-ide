import { trackEvent } from "@aptabase/tauri";
import { getSetting, setSetting } from "../api/settings";

// e2e/CI builds (`VITE_HERMES_E2E=1`, set by e2e/app/build.mjs — see
// src/main.tsx for the same flag gating the test-only automation hooks)
// never send analytics, no matter what a fixture profile's settings say.
const isE2eBuild = import.meta.env.VITE_HERMES_E2E === "1";

let enabled = false;

export async function initAnalytics(): Promise<void> {
  if (isE2eBuild) {
    enabled = false;
    return;
  }
  const stored = await getSetting("telemetry_enabled").catch(() => null);
  enabled = stored === "true";
}

export function setAnalyticsEnabled(value: boolean): void {
  enabled = isE2eBuild ? false : value;
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
