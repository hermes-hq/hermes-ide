// Small pieces shared by the Library's screens: the kind tag, the "works
// in" marks, badges, the card and the list row, and the words for a reason.

import type { KeyboardEvent, ReactNode } from "react";
import { Badge } from "../ui";
import { cx } from "../ui/Button";
import { useI18n } from "../../i18n/I18nProvider";
import { agentName, agentsForTarget, targetName } from "../../library/targets";
import type { EntryKind, LibraryHit, Reason } from "../../library/types";

type T = (key: string, values?: Record<string, string | number>) => string;

export function kindLabel(t: T, kind: EntryKind | "classic" | "mine"): string {
  return t(`library.kind.${kind}`);
}

export function KindTag({ kind }: { kind: EntryKind | "classic" | "mine" }) {
  const { t } = useI18n();
  return (
    <span className={cx("lib-kind", `lib-kind--${kind}`)} data-kind={kind}>
      {kindLabel(t, kind)}
    </span>
  );
}

export function reasonText(t: T, r: Reason): string {
  switch (r.code) {
    case "pinned":
      return t("library.reason.pinned");
    case "used":
      return t("library.reason.used", { count: r.label });
    case "stack":
      return t("library.reason.stack", { label: r.label });
    case "stage":
      return t("library.reason.stage", { label: r.label });
    case "affinity":
      return t("library.reason.affinity", { label: r.label });
    case "agent":
      return t("library.reason.agent", { agent: targetName(r.value) });
    default:
      return t("library.reason.picked", { label: r.label });
  }
}

/** The agents an entry works in, those installed here marked. */
export function WorksMarks({ works, installed }: { works: readonly string[]; installed: ReadonlySet<string> }) {
  const shown = works.filter((w) => agentsForTarget(w).length > 0).slice(0, 6);
  if (shown.length === 0) return null;
  return (
    <span className="lib-works" aria-label={shown.map(targetName).join(", ")}>
      {shown.map((w) => {
        const name = agentName(agentsForTarget(w)[0]);
        return (
          <span key={w} className={cx("lib-works-mark", installed.has(w) && "lib-works-mark--here")} title={name} data-target={w}>
            {name.charAt(0)}
          </span>
        );
      })}
    </span>
  );
}

export function HitBadges({ hit, installed, pinned }: { hit: LibraryHit; installed?: boolean; pinned?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="lib-badges">
      {pinned && <Badge tone="warning">{t("library.badge.pinned")}</Badge>}
      {hit.isNew && <Badge tone="info">{t("library.badge.new")}</Badge>}
      {installed && <Badge tone="success">{t("library.badge.installed")}</Badge>}
      {hit.status === "incubating" && <Badge>{t("library.badge.incubating")}</Badge>}
    </span>
  );
}

function activate(e: KeyboardEvent<HTMLElement>, fn: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
}

export function HitCard({
  hit,
  selected,
  installedAgents,
  pinned,
  onOpen,
}: {
  hit: LibraryHit;
  selected: boolean;
  installedAgents: ReadonlySet<string>;
  pinned: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const why = hit.reasons.map((r) => reasonText(t, r)).filter(Boolean);
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx("lib-card", selected && "lib-card--selected")}
      data-entry={hit.id}
      onClick={() => onOpen(hit.id)}
      onKeyDown={(e) => activate(e, () => onOpen(hit.id))}
    >
      <span className="lib-card-top">
        <KindTag kind={hit.kind} />
        <HitBadges hit={hit} pinned={pinned} />
      </span>
      <span className="lib-card-title">{hit.title}</span>
      <span className="lib-card-desc">{hit.description}</span>
      {why.length > 0 && (
        <span className="lib-card-why" data-reasons={hit.reasons.map((r) => r.code).join(" ")}>
          {why.join(" · ")}
        </span>
      )}
      <span className="lib-card-foot">
        <span className="lib-meta">
          {hit.categoryLabel} · v{hit.version}
        </span>
        <WorksMarks works={hit.works} installed={installedAgents} />
      </span>
    </div>
  );
}

/** One 56 px row of the results list. */
export function HitRow({
  id,
  kind,
  title,
  description,
  why,
  meta,
  selected,
  right,
  onOpen,
}: {
  id: string;
  kind: EntryKind | "classic" | "mine";
  title: string;
  description: string;
  why?: string;
  meta?: string;
  selected: boolean;
  right?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={cx("lib-row", selected && "lib-row--selected")}
      data-entry={id}
      onClick={onOpen}
      onKeyDown={(e) => activate(e, onOpen)}
    >
      <KindTag kind={kind} />
      <span className="lib-row-text">
        <span className="lib-row-title">{title}</span>
        <span className="lib-row-desc">
          {why && <span className="lib-row-why">{why} · </span>}
          {description}
        </span>
      </span>
      <span className="lib-row-right">
        {right}
        {meta && <span className="lib-meta">{meta}</span>}
      </span>
    </div>
  );
}
