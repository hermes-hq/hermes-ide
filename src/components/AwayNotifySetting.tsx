// ─── Settings > General: away notifications (N16) ─────────────────────
//
// One optional address. Saved when the field loses focus (or Enter), and
// only when it is empty or an http(s) URL. Masked unless being edited. The backend reads it when an
// agent is blocked; empty means no network call at all.
//
// Under it: how the last message went ("Last message: sent 12:04 ✓" /
// "failed 12:04: …"), a "Send test message" button, when to send ("Send
// after": Immediately / After 2 min / After 10 min, for while Hermes is in
// front of you) and whether messages may name sessions.

import { useEffect, useRef, useState } from "react";
import { AWAY_NOTIFY_URL_KEY, sendAwayNotification } from "../api/attention";
import {
  AWAY_DELAY_CHOICES,
  AWAY_NOTIFY_DELAY_KEY,
  AWAY_NOTIFY_NAMES_KEY,
  applyAwayPref,
  loadAwayPrefs,
  useAwayPrefs,
  type AwayDelayChoice,
} from "../attention/awayPrefs";
import { awayTime, clearAwayFailureNotices, noteAwayResult, useAwayLast } from "../attention/awayStatus";
import { isAwayUrlAcceptable } from "../attention/awayUrl";
import { useI18n } from "../i18n/I18nProvider";
import { Button } from "./ui/Button";
import { Toggle } from "./ui/Choice";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";

// An example address, not a sentence: the same in every language.
const EXAMPLE_ADDRESS = "https://ntfy.sh/my-topic";

/** What "Send test message" sends: no agent, no task, no prompt. */
export const AWAY_TEST_PAYLOAD = Object.freeze({ agent: "Hermes", task: "test", state: "test", where: "" });

const DELAY_LABEL_KEYS: Record<AwayDelayChoice, string> = {
  "0": "settings.awayNotifyDelayNow",
  "120": "settings.awayNotifyDelay2",
  "600": "settings.awayNotifyDelay10",
};

interface AwayNotifySettingProps {
  value: string;
  /** Saves a setting; a returned promise settles once it is stored. */
  onSave: (key: string, value: string) => void | Promise<unknown>;
}

export function AwayNotifySetting({ value, onSave }: AwayNotifySettingProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const [testing, setTesting] = useState(false);
  const prefs = useAwayPrefs();
  const last = useAwayLast();
  // The address can hold a secret (a Telegram bot token, a private topic):
  // shown only while the field is being edited.
  const [editing, setEditing] = useState(false);
  // Follow the saved value (it can arrive after the dialog opened), but
  // never over what the person is typing or typed and has not saved yet.
  const focused = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    if (!focused.current && !dirty.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    void loadAwayPrefs();
  }, []);

  /** Save the typed address when it is acceptable: the address to use and when it is stored, or null. */
  const commit = (): { address: string; saved: Promise<unknown> } | null => {
    const next = draft.trim();
    if (!isAwayUrlAcceptable(next)) {
      setInvalid(true);
      return null;
    }
    setInvalid(false);
    dirty.current = false;
    return { address: next, saved: Promise.resolve(next !== value ? onSave(AWAY_NOTIFY_URL_KEY, next) : undefined) };
  };

  const savePref = (key: string, next: string) => {
    applyAwayPref(key, next);
    onSave(key, next);
  };

  const sendTest = async () => {
    const committed = commit();
    if (!committed) return;
    setTesting(true);
    try {
      // The backend reads the saved address: wait until the one shown is stored.
      await committed.saved;
      const result = await sendAwayNotification(AWAY_TEST_PAYLOAD);
      if (noteAwayResult(result)?.outcome === "sent") clearAwayFailureNotices();
    } catch (e) {
      noteAwayResult({ outcome: "error", error: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const lastLine = last
    ? last.outcome === "sent"
      ? t("settings.awayNotifyLastSent", { time: awayTime(last.at) })
      : t("settings.awayNotifyLastFailed", { time: awayTime(last.at), error: last.error })
    : null;

  return (
    <>
      <div className="settings-group" data-setting={AWAY_NOTIFY_URL_KEY}>
        <label className="settings-label" htmlFor="away-notify-url">
          {t("settings.awayNotify")}
        </label>
        <Input
          id="away-notify-url"
          code
          type={editing ? "url" : "password"}
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder={EXAMPLE_ADDRESS}
          aria-label={t("settings.awayNotifyUrl")}
          invalid={invalid}
          aria-describedby="away-notify-hint"
          value={draft}
          onChange={(e) => {
            dirty.current = true;
            setDraft(e.target.value);
            if (invalid) setInvalid(false);
          }}
          onFocus={() => {
            focused.current = true;
            setEditing(true);
          }}
          onBlur={() => {
            focused.current = false;
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
        {lastLine && (
          <span className={`settings-hint-inline away-notify-last${last?.outcome === "failed" ? " settings-hint-error" : ""}`} role="status" data-outcome={last?.outcome}>
            {lastLine}
          </span>
        )}
        <span id="away-notify-hint" className="settings-hint-inline">
          {t("settings.awayNotifyHint")}
        </span>
        <Button variant="secondary" size="sm" className="away-notify-test" disabled={testing || draft.trim() === ""} onClick={() => void sendTest()}>
          {t("settings.awayNotifyTest")}
        </Button>
      </div>
      <div className="settings-group" data-setting={AWAY_NOTIFY_DELAY_KEY}>
        <span className="settings-label" id="away-notify-delay-label">
          {t("settings.awayNotifyDelay")}
        </span>
        <Select<AwayDelayChoice>
          id="away-notify-delay"
          size="sm"
          aria-labelledby="away-notify-delay-label"
          aria-describedby="away-notify-delay-hint"
          options={AWAY_DELAY_CHOICES.map((v) => ({ value: v, label: t(DELAY_LABEL_KEYS[v]) }))}
          value={prefs.delay}
          onChange={(v) => savePref(AWAY_NOTIFY_DELAY_KEY, v)}
        />
        <span id="away-notify-delay-hint" className="settings-hint-inline">
          {t("settings.awayNotifyDelayHint")}
        </span>
      </div>
      <div className="settings-group" data-setting={AWAY_NOTIFY_NAMES_KEY}>
        <Toggle
          checked={prefs.includeNames}
          onChange={(on) => savePref(AWAY_NOTIFY_NAMES_KEY, on ? "on" : "off")}
          label={t("settings.awayNotifyNames")}
          description={t("settings.awayNotifyNamesHint")}
        />
      </div>
    </>
  );
}
