// Settings > Limits (flag `fleetControls`): spend caps (F31) and the
// running-agents cap (N22). Every field is off when empty. A value is saved
// when the field loses focus or Enter is pressed, and applies at once.

import "../styles/components/Fleet.css";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { parseCapValue, setFleetCap, useFleetCaps, type FleetCapField } from "./fleetSettings";

interface FieldSpec {
  readonly field: FleetCapField;
  readonly label: string;
  readonly unit: string;
  readonly hint: string;
  readonly step: string;
}

function CapField({ spec, value }: { spec: FieldSpec; value: number | null }) {
  const { t } = useI18n();
  const [text, setText] = useState(value === null ? "" : String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);
  const save = () => {
    const trimmed = text.trim();
    const parsed = trimmed === "" ? null : parseCapValue(spec.field, trimmed);
    if (trimmed !== "" && parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed === value) return;
    setFleetCap(spec.field, parsed).catch((err) => console.warn("[fleet] could not save the cap:", err));
  };
  const id = `fleet-cap-${spec.field}`;
  return (
    <div className="settings-group">
      <label className="settings-label" htmlFor={id}>{spec.label}</label>
      <div className="fleet-cap-row">
        <input
          id={id}
          className="settings-input fleet-cap-input"
          data-fleet-cap={spec.field}
          inputMode="decimal"
          type="number"
          min="0"
          step={spec.step}
          placeholder={t("fleet.capOff")}
          value={text}
          aria-invalid={invalid || undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <span className="fleet-cap-unit">{spec.unit}</span>
      </div>
      <span className="settings-hint-inline">{invalid ? t("fleet.capInvalid") : spec.hint}</span>
    </div>
  );
}

export function FleetSettingsTab() {
  const { t } = useI18n();
  const caps = useFleetCaps();
  const specs: FieldSpec[] = [
    { field: "sessionUsd", label: t("fleet.capSession"), unit: "USD", hint: t("fleet.capSessionHint"), step: "0.01" },
    { field: "featureUsd", label: t("fleet.capFeature"), unit: "USD", hint: t("fleet.capFeatureHint"), step: "0.01" },
    { field: "maxRunning", label: t("fleet.capRunning"), unit: t("fleet.capAgentsUnit"), hint: t("fleet.capRunningHint"), step: "1" },
    { field: "maxMemoryMb", label: t("fleet.capMemory"), unit: "MB", hint: t("fleet.capMemoryHint"), step: "1" },
  ];
  return (
    <div className="settings-section fleet-settings">
      <p className="settings-hint-inline">{t("fleet.spendHonesty")}</p>
      {specs.map((spec) => (
        <CapField key={spec.field} spec={spec} value={caps[spec.field]} />
      ))}
    </div>
  );
}
