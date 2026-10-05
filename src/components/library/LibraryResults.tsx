// Search results: one list (a listbox, 56 px rows, about 30 in the DOM at
// a time) grouped Library, then Hermes classics, then My templates. The
// next page is asked for before the end is reached.

import { useEffect } from "react";
import { Button } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import type { LegacyItem } from "../../library/legacy";
import type { LibraryHit } from "../../library/types";
import { HitBadges, HitRow, WorksMarks, reasonText } from "./LibraryParts";
import { useVirtualRows } from "./useVirtualRows";

export const ROW_HEIGHT = 56;

export type ResultItem =
  | { type: "header"; key: string; label: string; count: string }
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
  installedTargets,
  pinned,
  personal,
  onOpen,
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
  installedTargets: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  personal: boolean;
  onOpen: (item: ResultItem) => void;
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
  return (
    <div className="lib-center lib-center--results" data-testid="library-results">
      <div className="lib-results-head">
        <span>
          <b data-testid="library-total">{totalCapped ? t("library.results.totalCapped", { count: total }) : t("library.results.total", { count: total })}</b>
          {filtered && <span className="lib-muted"> · {t("library.results.narrowed")}</span>}
        </span>
        <span className="lib-muted">{loading ? t("library.results.searching") : t("library.results.paged")}</span>
      </div>
      {items.length === 0 && !loading ? (
        <div className="lib-empty">
          {t("library.results.none", { query })}{" "}
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
                      <HitBadges hit={h} pinned={pinned.has(h.id)} />
                      <WorksMarks works={h.works} installed={installedTargets} />
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
