import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "../api/settings";

// Private by default: nothing is tracked until the user opts in, and the
// backend only creates its analytics client once the opt-in is stored. The
// backend has the final say — it refuses in test runs (HERMES_E2E) — so
// `enabled` is only ever true when it confirmed analytics is active.
let enabled = false;
// Bumped on every change of mind, so a slow "on" cannot land after a later "off".
let generation = 0;

/** Asks the backend to turn analytics on for the running app. Resolves to
 *  whether it is active; never rejects. */
function activateAnalytics(): Promise<boolean> {
  return invoke<boolean>("enable_analytics").then((active) => active === true, () => false);
}

export async function initAnalytics(): Promise<void> {
  const gen = generation;
  const stored = await getSetting("telemetry_enabled").catch(() => null);
  const active = stored === "true" && (await activateAnalytics());
  if (gen === generation) enabled = active;
}

/** Persists the choice, then applies it right away (no restart needed). */
export async function setAnalyticsEnabled(value: boolean): Promise<void> {
  const gen = ++generation;
  enabled = false;
  await setSetting("telemetry_enabled", value ? "true" : "false").catch(console.error);
  if (!value) return;
  const active = await activateAnalytics();
  if (gen === generation) enabled = active;
}

// Sent straight to the analytics plugin's command. The @aptabase/tauri
// package speaks the Tauri 1 IPC, which this app does not have, so events
// sent through it never arrived.
function track(name: string, props?: Record<string, string | number>): void {
  if (!enabled) return;
  invoke("plugin:aptabase|track_event", { name, props: props ?? null }).catch(() => {
    // Analytics must never disturb the app.
  });
}

export function trackAppStarted(): void {
  track("app_started");
}

export function trackSessionCreated(props: {
  has_ai_provider: boolean;
}): void {
  track("session_created", {
    has_ai_provider: props.has_ai_provider ? 1 : 0,
  });
}

export function trackFeatureUsed(feature: string): void {
  track("feature_used", { feature });
}
