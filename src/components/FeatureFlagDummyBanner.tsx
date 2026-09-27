// A harmless badge that only renders when the "dummyProofSurface" feature
// flag is on (see src/featureFlags/). It exists solely to prove — in the
// real app, not just in tests — that the flag mechanism actually gates a
// visible surface. Delete this component together with the flag once a
// real flagged feature exists.
import { isFeatureFlagEnabled } from "../featureFlags";
import { useI18n } from "../i18n/I18nProvider";

export function FeatureFlagDummyBanner() {
  const { t } = useI18n();
  if (!isFeatureFlagEnabled("dummyProofSurface")) return null;
  return (
    <span className="topbar-flag-badge" title={t("featureFlags.badgeTitle", { id: "dummyProofSurface" })}>
      FLAG
    </span>
  );
}
