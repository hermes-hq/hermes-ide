// Search results: a plain need's front door first ("Start here", with the
// words it took from the search), the specialists to narrow to, then one
// list (a listbox, 56 px rows, about 30 in the DOM at a time): the
// Library's matches in depth sections in the catalog's order (Start here,
// Specific, Advanced: each with its count, each can be folded), then
// Hermes classics, then My templates. The next page is asked for before
// the end is reached.

import { useEffect } from "react";
import { Button, Chip } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import type { LegacyItem } from "../../library/legacy";
import type { LibraryHit, RoutePage } from "../../library/types";
import { CareTag, DoorTag, HitBadges, HitRow, reasonText } from "./LibraryParts";
import { useVirtualRows } from "./useVirtualRows";

export const ROW_HEIGHT = 56;

export type ResultItem =
  | { type: "header"; key: string; label: string; count: string; section?: string; open?: boolean }
  | { type: "hit"; key: string; hit: LibraryHit }
  | { type: "legacy"; key: string; item: LegacyItem };

export function LibraryResults({
  items,
  total,
  totalCapped,
  query,
  filtered,
  loading,
  selectedKey,
  pinned,
  personal,
  route,
  filledFromSearch,
  partial,
  onOpen,
  onOpenId,
  onToggleSection,
  onMore,
  onClear,
}: {
  items: ResultItem[];
  total: number;
  totalCapped: boolean;
  query: string;
  filtered: boolean;
  loading: boolean;
  selectedKey: string | null;
  pinned: ReadonlySet<string>;
  personal: boolean;
  /** The front door a plain need routes to, and its specialists. */
  route?: RoutePage | null;
  /** The front door's answers taken from the search ("Lisbon · 5 days"). */
  filledFromSearch?: string | null;
  /** No entry has every word: the list has those with most of them. */
  partial?: boolean;
  onOpen: (item: ResultItem) => void;
  onOpenId: (hit: LibraryHit) => void;
  onToggleSection: (section: string) => void;
  onMore: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const v = useVirtualRows(items.length, ROW_HEIGHT, { onNearEnd: onMore });
  const selectedIndex = items.findIndex((i) => i.key === selectedKey);

  useEffect(() => {
    if (selectedIndex >= 0) v.reveal(selectedIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  const move = (delta: number) => {
    let i = selectedIndex;
    for (let n = 0; n < items.length; n++) {
      i = Math.min(items.length - 1, Math.max(0, i + delta));
      if (items[i].type !== "header") break;
    }
    if (items[i] && items[i].type !== "header") onOpen(items[i]);
  };

  const libraryCount = items.filter((i) => i.type === "hit").length;
  const door = route?.to ?? null;
  return (
    <div className="lib-center lib-center--results" data-testid="library-results">
      {[route?.exact ?? null, door].map(
        (front) =>
          front && (
            <div
              key={front.id}
              className={selectedKey === `hit:${front.id}` ? "lib-front lib-front--selected" : "lib-front"}
              data-testid={front === door ? "library-front" : "library-exact"}
              data-entry={front.id}
            >
              <div className="lib-front-text">
                <span className="lib-front-title">
                  {front.door && <DoorTag />} <b>{front.title}</b>
                </span>
                <span className="lib-front-desc">{front.description}</span>
                {filledFromSearch && front.id === (route?.exact ?? door)?.id && (
                  <span className="lib-front-filled" data-testid="library-filled">
                    {t("library.results.filled", { words: filledFromSearch })}
                  </span>
                )}
                <CareTag adv={front.adv} />
              </div>
              <Button variant={front === door && !route?.exact ? "primary" : "secondary"} size="sm" className="lib-front-open" onClick={() => onOpenId(front)}>
                {t("library.results.open")}
              </Button>
            </div>
          ),
      )}
      {route && route.refine.length > 0 && (
        <div className="lib-refine" role="group" aria-label={t("library.results.narrow")} data-testid="library-refine">
          <span className="lib-muted">{t("library.results.narrow")}</span>
          {route.refine.map((h) => (
            <Chip key={h.id} size="sm" onClick={() => onOpenId(h)} data-entry={h.id}>
              {h.title}
            </Chip>
          ))}
        </div>
      )}
      <div className="lib-results-head">
        <span>
          <b data-testid="library-total">{totalCapped ? t("library.results.totalCapped", { count: total }) : t("library.results.total", { count: total })}</b>
          {filtered && <span className="lib-muted"> · {t("library.results.narrowed")}</span>}
          {partial && <span className="lib-muted"> · {t("library.results.partial")}</span>}
        </span>
        <span className="lib-muted">{loading ? t("library.results.searching") : t("library.results.paged")}</span>
      </div>
      {items.length === 0 && !loading ? (
        <div className="lib-empty">
          {filtered ? t("library.results.noneFiltered", { query }) : t("library.results.none", { query })}{" "}
          <Button variant="link" size="sm" onClick={onClear}>
            {t("library.results.clear")}
          </Button>
        </div>
      ) : (
        <div
          ref={v.containerRef}
          className="lib-rows"
          role="listbox"
          aria-label={t("library.results.label")}
          tabIndex={-1}
          onScroll={v.onScroll}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            }
          }}
          data-rendered={v.end - v.start}
          data-count={items.length}
          data-library-count={libraryCount}
        >
          <div style={{ height: v.padTop }} aria-hidden="true" />
          {items.slice(v.start, v.end).map((item) => {
            if (item.type === "header") {
              if (item.section) {
                const section = item.section;
                return (
                  <div
                    key={item.key}
                    className="lib-group lib-group--section"
                    role="button"
                    tabIndex={0}
                    aria-expanded={item.open !== false}
                    aria-label={t("library.results.toggleSection", { label: item.label })}
                    data-section={section}
                    onClick={() => onToggleSection(section)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onToggleSection(section);
                      }
                    }}
                  >
                    <span>
                      <span className="lib-group-caret" aria-hidden="true">
                        {item.open === false ? "▸" : "▾"}
                      </span>{" "}
                      {item.label}
                    </span>
                    <span>{item.count}</span>
                  </div>
                );
              }
              return (
                <div key={item.key} className="lib-group" role="presentation">
                  <span>{item.label}</span>
                  <span>{item.count}</span>
                </div>
              );
            }
            if (item.type === "hit") {
              const h = item.hit;
              return (
                <HitRow
                  key={item.key}
                  id={h.id}
                  kind={h.kind}
                  title={h.title}
                  description={h.description}
                  why={personal && h.reasons[0] ? reasonText(t, h.reasons[0]) : undefined}
                  meta={h.categoryLabel}
                  selected={item.key === selectedKey}
                  right={
                    <>
                      <CareTag adv={h.adv} />
                      <HitBadges hit={h} pinned={pinned.has(h.id)} />
                    </>
                  }
                  onOpen={() => onOpen(item)}
                />
              );
            }
            const l = item.item;
            return (
              <HitRow
                key={item.key}
                id={l.key}
                kind={l.group === "mine" ? "mine" : "classic"}
                title={l.title}
                description={l.description || l.text.slice(0, 140)}
                meta={l.category}
                selected={item.key === selectedKey}
                onOpen={() => onOpen(item)}
              />
            );
          })}
          <div style={{ height: v.padBottom }} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
