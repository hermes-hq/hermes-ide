// Settings > Library: updates, personalisation (pause, show everything,
// reset), what the Library knows about you, and what was installed into
// projects. Loaded with Settings only when this tab opens.

import { useCallback, useEffect, useState } from "react";
import { Button, Segmented } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { useLibraryMessages } from "../../library/messages";
import { libraryGetProfile, libraryInstalls, libraryResetPersonalisation, librarySetProfile, libraryStatus, libraryUninstall } from "../../library/api";
import { agentName } from "../../library/targets";
import type { InstallRecord, LibraryProfile, LibraryStatus } from "../../library/types";
import { LibraryInterests } from "./LibraryInterests";
import { LibraryUpdatePanel } from "./LibraryUpdate";

export function LibrarySettings() {
  const ready = useLibraryMessages();
  const { t } = useI18n();
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [profile, setProfile] = useState<LibraryProfile | null>(null);
  const [installs, setInstalls] = useState<InstallRecord[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [interestsKey, setInterestsKey] = useState(0);

  const refresh = useCallback(() => {
    libraryStatus().then(setStatus).catch(() => {});
    libraryGetProfile().then(setProfile).catch(() => {});
    libraryInstalls(null)
      .then((r) => setInstalls(r.records))
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  if (!ready) return null;
  const personalise = (profile?.personalise ?? "on") as "on" | "paused" | "off";
  return (
    <div className="lib-settings" data-testid="library-settings">
      <section className="settings-section">
        <h3 className="lib-settings-title">{t("library.settings.catalog")}</h3>
        <p className="lib-muted">{t("library.settings.catalogHint")}</p>
        {status ? <LibraryUpdatePanel status={status} onChanged={refresh} /> : <p className="lib-muted">{t("library.preparing")}</p>}
      </section>

      <section className="settings-section">
        <h3 className="lib-settings-title">{t("library.settings.personalisation")}</h3>
        <p className="lib-muted">{t("library.settings.personalisationHint")}</p>
        <Segmented
          size="sm"
          label={t("library.settings.personalisation")}
          value={personalise}
          onChange={(v) => {
            if (!profile) return;
            const next = { ...profile, personalise: v };
            setProfile(next);
            void librarySetProfile(next);
          }}
          options={[
            { value: "on", label: t("library.settings.on"), attrs: { "data-personalise": "on" } },
            { value: "paused", label: t("library.settings.paused"), attrs: { "data-personalise": "paused" } },
            { value: "off", label: t("library.settings.everything"), attrs: { "data-personalise": "off" } },
          ]}
        />
        <div className="lib-update-row">
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              void libraryResetPersonalisation().then(() => {
                setMessage(t("library.settings.resetDone"));
                setInterestsKey((k) => k + 1);
                refresh();
              });
            }}
          >
            {t("library.settings.reset")}
          </Button>
          {message && <span role="status">{message}</span>}
        </div>
        <LibraryInterests key={interestsKey} onSaved={(p) => setProfile((cur) => ({ ...(cur ?? p), ...p }))} />
      </section>

      <section className="settings-section">
        <h3 className="lib-settings-title">{t("library.settings.installs")}</h3>
        {installs.length === 0 ? (
          <p className="lib-muted">{t("library.settings.noInstalls")}</p>
        ) : (
          <div className="lib-files">
            {installs.map((r) => (
              <div key={`${r.projectPath}:${r.itemId}:${r.agentId}:${r.path}`} className="lib-file" data-item={r.itemId}>
                <span className="lib-file-path">
                  {r.itemId} · {agentName(r.agentId)} · {r.path}
                </span>
                <span className="lib-muted">{r.projectPath.split(/[\\/]/).filter(Boolean).pop()}</span>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    // The project's .hodios.lock says which target wrote this path.
                    void libraryInstalls(r.projectPath)
                      .then((p) => p.lock.entries.find((e) => e.id === r.itemId && e.path === r.path)?.target ?? "agents-md")
                      .then((target) => libraryUninstall(r.projectPath, r.itemId, target, r.agentId))
                      .then((kept) => {
                        setMessage(kept.length > 0 ? t("library.settings.keptEdited", { count: kept.length }) : t("library.settings.removed"));
                        refresh();
                      })
                      .catch((e) => setMessage(String(e)));
                  }}
                >
                  {t("library.settings.remove")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
