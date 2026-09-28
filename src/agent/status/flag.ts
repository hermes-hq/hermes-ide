// ─── Which flag gates the 2.0 session status (F10, F19) ───────────────
//
// The flag registry holds at most five flags and all five are taken, so the
// status rides on `launchHelper`: the helper is what reports an agent's
// startup and (with F11) its hook signals, and this is how those reports
// become visible. Point this at a dedicated flag once one is free.

import { isFeatureFlagEnabled } from "../../featureFlags";

export function isAgentStatusEnabled(): boolean {
  return isFeatureFlagEnabled("launchHelper");
}
