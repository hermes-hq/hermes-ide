// The Library's first screen: a few shelves of what fits this person, each
// saying why, then every domain to browse. Never the whole catalog.

import { Button } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { agentName } from "../../library/targets";
import type { Shelf, Shelves } from "../../library/types";
import { HitCard } from "./LibraryParts";
import { LibraryInterests } from "./LibraryInterests";

function shelfWhy(t: (k: string, v?: Record<string, string | number>) => string, shelf: Shelf, projectName: string | null): string {
  const labels = shelf.because.map((b) => b.label).join(", ");
  switch (shelf.id) {
    case "project":
      return t("library.shelf.projectWhy", { project: projectName ?? "", stack: labels });
    case "role":
      return labels;
    case "now":
      return t("library.shelf.nowWhy", { stage: labels });
    case "continue":
      return t("library.shelf.continueWhy");
    case "new":
      return t("library.shelf.newWhy");
    default:
      return t("library.shelf.startWhy");
  }
}

export function LibraryHome({
  shelves,
  loading,
  selectedId,
  installedTargets,
  installedAgentIds,
  pinned,
  projectName,
  showInterests,
  onOpen,
  onSeeAll,
  onBrowseDomain,
  onShowEverything,
  onInterestsDone,
  onEditInterests,
}: {
  shelves: Shelves | null;
  loading: boolean;
  selectedId: string | null;
  installedTargets: ReadonlySet<string>;
  installedAgentIds: readonly string[];
  pinned: ReadonlySet<string>;
  projectName: string | null;
  showInterests: boolean;
  onOpen: (id: string) => void;
  onSeeAll: (shelf: Shelf) => void;
  onBrowseDomain: (domain: string) => void;
  onShowEverything: (on: boolean) => void;
  onInterestsDone: () => void;
  onEditInterests: () => void;
}) {
  const { t } = useI18n();
  if (!shelves) {
    return (
      <div className="lib-center" aria-busy={loading}>
        <p className="lib-muted">{t("library.preparing")}</p>
      </div>
    );
  }
  const p = shelves.profile;
  const roles = p.roles.length;
  const total = shelves.domains.reduce((n, d) => n + d.count, 0);
  return (
    <div className="lib-center" data-testid="library-home">
      <div className="lib-context" data-personalised={shelves.personalised}>
        {shelves.personalised ? (
          <>
            <span className="lib-muted">{t("library.home.personalisedFrom")}</span>
            {projectName && shelves.stack.length > 0 && (
              <span>
                <b>{projectName}</b> {shelves.stack.map((s) => s.label).join(", ")}
              </span>
            )}
            {installedAgentIds.length > 0 && (
              <span>
                <b>{t("library.home.agents", { count: installedAgentIds.length })}</b> {installedAgentIds.map(agentName).join(", ")}
              </span>
            )}
            {roles > 0 && <span>{t("library.home.roles", { count: roles })}</span>}
            <span>{t("library.home.recentUse")}</span>
          </>
        ) : (
          <span>{t("library.home.everything")}</span>
        )}
        <span className="lib-context-actions">
          <Button variant="link" size="sm" onClick={onEditInterests}>
            {t("library.home.edit")}
          </Button>
          <Button variant="link" size="sm" className="lib-show-everything" onClick={() => onShowEverything(shelves.personalised)}>
            {shelves.personalised ? t("library.home.showEverything") : t("library.home.personaliseAgain")}
          </Button>
        </span>
      </div>
      <p className="lib-privacy">{t("library.home.privacy")}</p>

      {showInterests && <LibraryInterests compact onSaved={onInterestsDone} onSkip={onInterestsDone} />}

      {shelves.shelves.map((shelf) => (
        <section key={shelf.id} className="lib-shelf" data-shelf={shelf.id}>
          <div className="lib-shelf-head">
            <h3 className="lib-shelf-title">{t(`library.shelf.${shelf.id}`)}</h3>
            <span className="lib-shelf-why">{shelfWhy(t, shelf, projectName)}</span>
            {(shelf.id === "project" || shelf.id === "role") && (
              <Button variant="quiet" size="sm" className="lib-see-all" onClick={() => onSeeAll(shelf)}>
                {t("library.home.seeAll")}
              </Button>
            )}
          </div>
          <div className="lib-cards">
            {shelf.hits.map((h) => (
              <HitCard key={h.id} hit={h} selected={h.id === selectedId} installedAgents={installedTargets} pinned={pinned.has(h.id)} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ))}

      <section className="lib-shelf" data-shelf="domains">
        <div className="lib-shelf-head">
          <h3 className="lib-shelf-title">{t("library.home.browse", { count: shelves.domains.length })}</h3>
          <span className="lib-shelf-why">{t("library.home.entries", { count: total })}</span>
        </div>
        <div className="lib-domains">
          {shelves.domains.map((d) => (
            <div
              key={d.id}
              role="button"
              tabIndex={0}
              className={d.mine ? "lib-domain lib-domain--mine" : "lib-domain"}
              data-domain={d.id}
              onClick={() => onBrowseDomain(d.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onBrowseDomain(d.id);
                }
              }}
            >
              <span>{d.label}</span>
              <span className="lib-count">{d.count}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
