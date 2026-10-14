// The Library's first screen: the Essentials (the front doors everyone
// starts from, narrowed by what kind of task and what it is about), what
// this person used last, a few shelves of what fits them (each saying
// why), then every domain and its categories to browse. Never the whole
// catalog.

import { useState } from "react";
import { Button, Chip } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { domainGroups, filterEssentials, usedWhen, type UsedWhen } from "../../library/everyday";
import { agentName } from "../../library/targets";
import type { ItemState, Shelf, Shelves, VocabLevel } from "../../library/types";
import { HitCard } from "./LibraryParts";
import { LibraryInterests } from "./LibraryInterests";

type T = (k: string, v?: Record<string, string | number>) => string;

function shelfWhy(t: T, shelf: Shelf, projectName: string | null): string {
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
    default:
      return t("library.shelf.newWhy");
  }
}

/** "Used yesterday", "Opened today", "Used 3 times", "Pinned". */
export function usedText(t: T, when: UsedWhen): string | undefined {
  if (!when) return undefined;
  if (when.kind === "pinned") return t("library.badge.pinned");
  const verb = when.uses > 0 ? "used" : "opened";
  if (when.uses > 2) return t("library.continue.times", { count: when.uses });
  if (when.kind === "today") return t(`library.continue.${verb}Today`);
  if (when.kind === "yesterday") return t(`library.continue.${verb}Yesterday`);
  return t(`library.continue.${verb}Days`, { count: when.days });
}

function labelOf(list: readonly VocabLevel[] | undefined, id: string | null): string {
  return (id && list?.find((x) => x.id === id)?.label) || id || "";
}

export function LibraryHome({
  shelves,
  loading,
  selectedId,
  installedAgentIds,
  pinned,
  itemStates,
  projectName,
  showInterests,
  onOpen,
  onSeeAll,
  onBrowseDomain,
  onBrowseCategory,
  onSearchIntent,
  onShowEverything,
  onInterestsDone,
  onEditInterests,
}: {
  shelves: Shelves | null;
  loading: boolean;
  selectedId: string | null;
  installedAgentIds: readonly string[];
  pinned: ReadonlySet<string>;
  itemStates: readonly ItemState[];
  projectName: string | null;
  showInterests: boolean;
  onOpen: (id: string) => void;
  onSeeAll: (shelf: Shelf) => void;
  onBrowseDomain: (domain: string) => void;
  onBrowseCategory: (domain: string, category: string) => void;
  onSearchIntent: (intent: string | null, topic: string | null) => void;
  onShowEverything: (on: boolean) => void;
  onInterestsDone: () => void;
  onEditInterests: () => void;
}) {
  const { t } = useI18n();
  const [intent, setIntent] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [openDomain, setOpenDomain] = useState<string | null>(null);
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
  const projectStack = !!projectName && shelves.stack.length > 0;
  const recent = shelves.shelves.some((s) => s.id === "continue");
  const anything = projectStack || roles > 0 || p.domains.length > 0 || recent;
  const essentials = shelves.essentials ?? [];
  const intents = shelves.intents ?? [];
  const topics = (shelves.topics ?? []).filter((x) => essentials.some((h) => h.topic === x.id));
  const shown = filterEssentials(essentials, intent, topic);
  const filtering = intent !== null || topic !== null;
  const filterLabel = [labelOf(intents, intent), labelOf(shelves.topics, topic)].filter(Boolean).join(" · ");
  const states = new Map(itemStates.map((s) => [s.itemId, s]));

  return (
    <div className="lib-center" data-testid="library-home">
      <div className="lib-context" data-personalised={shelves.personalised}>
        {shelves.personalised && anything ? (
          <>
            <span className="lib-muted">{t("library.home.personalisedFrom")}</span>
            {projectStack && (
              <span>
                <b>{projectName}</b> {shelves.stack.map((s) => s.label).join(", ")}
              </span>
            )}
            {projectStack && installedAgentIds.length > 0 && (
              <span>
                <b>{t("library.home.agents", { count: installedAgentIds.length })}</b> {installedAgentIds.map(agentName).join(", ")}
              </span>
            )}
            {roles > 0 && <span>{t("library.home.roles", { count: roles })}</span>}
            {recent && <span>{t("library.home.recentUse")}</span>}
          </>
        ) : !shelves.personalised ? (
          <span>{t("library.home.everything")}</span>
        ) : (
          <span>{t("library.home.privacy")}</span>
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

      {essentials.length > 0 && (
        <section className="lib-essentials" data-testid="library-essentials">
          {intents.length > 0 && (
            <div className="lib-intents">
              <div className="lib-chip-wrap" role="group" aria-label={t("library.intent.label")}>
                {intents.map((x) => (
                  <Chip
                    key={x.id}
                    selected={intent === x.id}
                    onToggle={(on) => setIntent(on ? x.id : null)}
                    buttonAttrs={{ className: "lib-intent", "data-intent": x.id }}
                  >
                    {x.label}
                    {x.hint ? <span className="lib-intent-hint"> {x.hint}</span> : null}
                  </Chip>
                ))}
              </div>
              {topics.length > 0 && (
                <div className="lib-chip-wrap" role="group" aria-label={t("library.topic.label")}>
                  {topics.map((x) => (
                    <Chip
                      key={x.id}
                      size="sm"
                      selected={topic === x.id}
                      onToggle={(on) => setTopic(on ? x.id : null)}
                      buttonAttrs={{ className: "lib-topic", "data-topic": x.id }}
                    >
                      {x.label}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="lib-shelf-head">
            <h3 className="lib-shelf-title">{filtering ? t("library.ess.startHere") : t("library.ess.title")}</h3>
            <span className="lib-shelf-why">{filtering ? t("library.ess.filtered", { count: shown.length, filter: filterLabel }) : t("library.ess.why")}</span>
            {filtering && (
              <span className="lib-ess-actions">
                <Button variant="quiet" size="sm" onClick={() => onSearchIntent(intent, topic)}>
                  {t("library.ess.searchAll", { filter: filterLabel })}
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    setIntent(null);
                    setTopic(null);
                  }}
                >
                  {t("library.ess.showAll")}
                </Button>
              </span>
            )}
          </div>
          {shown.length > 0 ? (
            <div className="lib-cards lib-ess-grid">
              {shown.map((h) => (
                <HitCard key={h.id} hit={h} selected={h.id === selectedId} pinned={pinned.has(h.id)} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <p className="lib-muted">{t("library.ess.none")}</p>
          )}
        </section>
      )}

      {/* After the Essentials: a new person starts from them, not from a form. */}
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
              <HitCard
                key={h.id}
                hit={h}
                selected={h.id === selectedId}
                pinned={pinned.has(h.id)}
                sub={shelf.id === "continue" ? usedText(t, usedWhen(states.get(h.id))) : undefined}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}

      <section className="lib-shelf" data-shelf="domains">
        <div className="lib-shelf-head">
          <h3 className="lib-shelf-title">{t("library.browse.title")}</h3>
          <span className="lib-shelf-why">{t("library.browse.why", { count: total.toLocaleString() })}</span>
        </div>
        <div className="lib-browse">
          {domainGroups(shelves.domains).map((g) => (
            <div key={g.id} className="lib-browse-group" data-group={g.id}>
              <h4 className="lib-browse-title">{t(`library.browse.${g.id}`)}</h4>
              {g.domains.map((d) => {
                const open = openDomain === d.id;
                return (
                  <div key={d.id} className="lib-browse-domain">
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      className={d.mine ? "lib-domain lib-domain--mine" : "lib-domain"}
                      data-domain={d.id}
                      onClick={() => setOpenDomain(open ? null : d.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenDomain(open ? null : d.id);
                        }
                      }}
                    >
                      <span>{d.label}</span>
                      <span className="lib-count">{d.count.toLocaleString()}</span>
                    </div>
                    {open && (
                      <div className="lib-categories" role="group" aria-label={t("library.browse.categories", { domain: d.label })}>
                        <div
                          role="button"
                          tabIndex={0}
                          className="lib-category lib-category--all"
                          data-domain-all={d.id}
                          onClick={() => onBrowseDomain(d.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onBrowseDomain(d.id);
                            }
                          }}
                        >
                          <span>{t("library.browse.allIn", { domain: d.label })}</span>
                        </div>
                        {(d.categories ?? []).map((c) => (
                          <div
                            key={c.id}
                            role="button"
                            tabIndex={0}
                            className="lib-category"
                            data-category={c.id}
                            onClick={() => onBrowseCategory(d.id, c.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onBrowseCategory(d.id, c.id);
                              }
                            }}
                          >
                            <span>{c.label}</span>
                            <span className="lib-count">{c.count.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
