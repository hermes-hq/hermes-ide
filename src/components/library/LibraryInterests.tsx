// "What do you work on?": roles and interests that order the Library for
// this person. Kept in this computer's Hermes database only.

import { useEffect, useState } from "react";
import { Button, Chip } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { libraryGetProfile, librarySetProfile, libraryVocab } from "../../library/api";
import type { Labeled, LibraryProfile } from "../../library/types";

const EMPTY: LibraryProfile = { roles: [], domains: [], categories: [], subjects: [], stack: [] };
/** The roles offered first (Hermes is a coding tool); the rest behind "More roles". */
const FIRST_ROLES = 12;
const COMMON_ROLES = [
  "software-engineer",
  "frontend-engineer",
  "backend-engineer",
  "fullstack-engineer",
  "mobile-engineer",
  "devops-engineer",
  "data-engineer",
  "ml-engineer",
  "qa-engineer",
  "security-engineer",
  "tech-lead",
  "product-manager",
];

function commonFirst(list: Labeled[]): Labeled[] {
  const rank = (v: string) => {
    const i = COMMON_ROLES.indexOf(v);
    return i < 0 ? COMMON_ROLES.length : i;
  };
  return [...list].sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
}

export function LibraryInterests({
  compact = false,
  onSaved,
  onSkip,
}: {
  /** The card on the Library's first screen (fewer words, a Skip). */
  compact?: boolean;
  onSaved?: (profile: LibraryProfile) => void;
  onSkip?: () => void;
}) {
  const { t } = useI18n();
  const [profile, setProfile] = useState<LibraryProfile>(EMPTY);
  const [roles, setRoles] = useState<Labeled[]>([]);
  const [domains, setDomains] = useState<Labeled[]>([]);
  const [allRoles, setAllRoles] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([libraryGetProfile(), libraryVocab(["role", "domain"])])
      .then(([p, v]) => {
        if (!live) return;
        setProfile({ ...EMPTY, ...p });
        setRoles(commonFirst(v.facets.role ?? []));
        setDomains((v.facets.domain ?? []).filter((d) => d.value !== "other"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const toggle = (key: "roles" | "domains", value: string) => {
    setSaved(false);
    setProfile((p) => ({ ...p, [key]: p[key].includes(value) ? p[key].filter((v) => v !== value) : [...p[key], value] }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await librarySetProfile(profile);
      setSaved(true);
      onSaved?.(profile);
    } finally {
      setSaving(false);
    }
  };

  const shownRoles = allRoles ? roles : roles.slice(0, FIRST_ROLES);
  return (
    <section className={compact ? "lib-interests lib-interests--card" : "lib-interests"} aria-label={t("library.interests.title")}>
      <div className="lib-interests-head">
        <h3 className="lib-interests-title">{t("library.interests.title")}</h3>
        <p className="lib-interests-hint">{t("library.interests.hint")}</p>
      </div>
      <div className="lib-interests-group">
        <span className="lib-interests-label">{t("library.interests.roles")}</span>
        <div className="lib-chip-wrap" role="group" aria-label={t("library.interests.roles")}>
          {shownRoles.map((r) => (
            <Chip
              key={r.value}
              size="sm"
              selected={profile.roles.includes(r.value)}
              onToggle={() => toggle("roles", r.value)}
              buttonAttrs={{ className: "lib-role-chip", "data-value": r.value }}
            >
              {r.label}
            </Chip>
          ))}
          {!allRoles && roles.length > FIRST_ROLES && (
            <Button variant="link" size="sm" onClick={() => setAllRoles(true)}>
              {t("library.interests.moreRoles", { count: roles.length - FIRST_ROLES })}
            </Button>
          )}
        </div>
      </div>
      <div className="lib-interests-group">
        <span className="lib-interests-label">{t("library.interests.domains")}</span>
        <div className="lib-chip-wrap" role="group" aria-label={t("library.interests.domains")}>
          {domains.map((d) => (
            <Chip
              key={d.value}
              size="sm"
              selected={profile.domains.includes(d.value)}
              onToggle={() => toggle("domains", d.value)}
              buttonAttrs={{ className: "lib-domain-chip", "data-value": d.value }}
            >
              {d.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="lib-interests-actions">
        {saved && <span className="lib-interests-saved" role="status">{t("library.interests.saved")}</span>}
        {onSkip && (
          <Button variant="quiet" size="sm" onClick={onSkip}>
            {t("library.interests.skip")}
          </Button>
        )}
        <Button variant="primary" size="sm" className="lib-interests-save" loading={saving} onClick={() => void save()}>
          {t("library.interests.save")}
        </Button>
      </div>
    </section>
  );
}
