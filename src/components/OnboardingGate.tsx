import { Suspense, useEffect, useState } from "react";
import { lazyView } from "../utils/lazyView";
import { getSetting } from "../api/settings";
import { isFeatureFlagEnabled } from "../featureFlags";
import { ONBOARDING_COMPLETED_SETTING } from "./startupDialogSettings";
import type { SetupWizardProps } from "./SetupWizard";

const OnboardingWizard = lazyView("OnboardingWizard", () => import("./OnboardingWizard").then((m) => m.OnboardingWizard));
const SetupWizard = lazyView("SetupWizard", () => import("./SetupWizard").then((m) => m.SetupWizard));

/**
 * Loads the first-launch welcome only when it is going to be shown, so
 * returning users never download it. With the `taskLauncher` flag on it is
 * the three-step setup (agents, repo, first task); otherwise the classic
 * wizard.
 */
export function OnboardingGate(props: Partial<SetupWizardProps>) {
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
  const { onLaunch, onSignIn, onOpenShell } = props;
  if (isFeatureFlagEnabled("taskLauncher") && onLaunch && onSignIn && onOpenShell) {
    return (
      <Suspense fallback={null}>
        <SetupWizard
          onLaunch={onLaunch}
          onSignIn={onSignIn}
          onOpenShell={onOpenShell}
          onDone={props.onDone}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <OnboardingWizard />
    </Suspense>
  );
}
