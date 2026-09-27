import { Suspense, useEffect, useState } from "react";
import { lazyView } from "../utils/lazyView";
import { getSetting } from "../api/settings";

const OnboardingWizard = lazyView("OnboardingWizard", () => import("./OnboardingWizard").then((m) => m.OnboardingWizard));

/** Same key the wizard writes when the user finishes it. */
export const ONBOARDING_COMPLETED_SETTING = "onboarding_completed";

/**
 * Loads the first-launch welcome wizard only when it is going to be shown,
 * so returning users never download it.
 */
export function OnboardingGate() {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSetting(ONBOARDING_COMPLETED_SETTING)
      .then((value) => {
        if (!cancelled && value !== "true") setNeeded(true);
      })
      .catch(() => {
        // Setting missing (first launch) — show the wizard.
        if (!cancelled) setNeeded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!needed) return null;
  return (
    <Suspense fallback={null}>
      <OnboardingWizard />
    </Suspense>
  );
}
