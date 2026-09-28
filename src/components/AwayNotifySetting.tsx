// ─── Settings > General: away notifications (N16) ─────────────────────
//
// One optional address. Saved when the field loses focus (or Enter), and
// only when it is empty or an http(s) URL. Masked unless being edited. The backend reads it when an
// agent is blocked; empty means no network call at all.

import { useEffect, useState } from "react";
import { AWAY_NOTIFY_URL_KEY } from "../api/attention";
import { isAwayUrlAcceptable } from "../attention/awayUrl";
import { useI18n } from "../i18n/I18nProvider";

interface AwayNotifySettingProps {
  value: string;
  onSave: (key: string, value: string) => void;
}

export function AwayNotifySetting({ value, onSave }: AwayNotifySettingProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  // The address can hold a secret (a Telegram bot token, a private topic):
  // shown only while the field is being edited.
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (!isAwayUrlAcceptable(next)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next !== value) onSave(AWAY_NOTIFY_URL_KEY, next);
  };

  return (
    <div className="settings-group" data-setting={AWAY_NOTIFY_URL_KEY}>
      <label className="settings-label" htmlFor="away-notify-url">
        {t("settings.awayNotify")}
      </label>
      <input
        id="away-notify-url"
        className="settings-input"
        type={editing ? "url" : "password"}
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        placeholder="https://ntfy.sh/my-topic"
        aria-label={t("settings.awayNotifyUrl")}
        aria-invalid={invalid}
        aria-describedby="away-notify-hint"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (invalid) setInvalid(false);
        }}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {invalid && (
        <span className="settings-hint-inline settings-hint-error" role="alert">
          {t("settings.awayNotifyInvalid")}
        </span>
      )}
      <span id="away-notify-hint" className="settings-hint-inline">
        {t("settings.awayNotifyHint")}
      </span>
    </div>
  );
}
