// "What do you want to do?": the Library's one search box, over the home
// and the results alike. While typing it suggests the front doors that fit
// (the routed one first); ↓ moves into them, Return opens the highlighted
// one, Escape closes them. With nothing highlighted ↓ opens the first
// result, as before.

import { useMemo, useState, type RefObject } from "react";
import { Input } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import type { LibraryHit, RoutePage } from "../../library/types";
import { DoorTag } from "./LibraryParts";

const MAX_SUGGESTIONS = 4;

/**
 * Front doors whose words start with every word typed. The one the search
 * routed to is already the results' first card, so it is not repeated.
 */
export function suggestDoors(essentials: readonly LibraryHit[], route: RoutePage | null, query: string): LibraryHit[] {
  const q = query.trim().toLowerCase();
  if (!q || q.length > 30) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const out: LibraryHit[] = [];
  for (const h of essentials) {
    if (!h.door || h.id === route?.to.id || out.some((x) => x.id === h.id)) continue;
    const hay = `${h.title} ${h.description}`.toLowerCase().split(/[^a-z0-9]+/);
    if (words.every((w) => hay.some((x) => x.startsWith(w)))) out.push(h);
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

export function LibraryAsk({
  compact = false,
  hint = false,
  inputRef,
  query,
  rows,
  essentials,
  route,
  onQuery,
  onOpen,
  onFirst,
}: {
  /** Over results: the question is not repeated, the list gets the room. */
  compact?: boolean;
  /** The query-language hint under the box (developers only). */
  hint?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  rows: number;
  essentials: readonly LibraryHit[];
  route: RoutePage | null;
  onQuery: (q: string) => void;
  onOpen: (hit: LibraryHit) => void;
  /** ↓ with nothing highlighted: open the first result (false when there is none). */
  onFirst: () => boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(-1);
  const list = useMemo(() => (open ? suggestDoors(essentials, route, query) : []), [open, essentials, route, query]);

  const pick = (h: LibraryHit) => {
    setOpen(false);
    setHl(-1);
    onOpen(h);
  };

  return (
    <div className="lib-ask">
      {!compact && <h2 className="lib-ask-title">{t("library.ask.title")}</h2>}
      <div className="lib-ask-box">
        <Input
          ref={inputRef}
          type="search"
          className="lib-search-input"
          aria-label={t("library.search.label")}
          aria-autocomplete="list"
          aria-expanded={list.length > 0}
          aria-controls={list.length > 0 ? "lib-suggest" : undefined}
          placeholder={t("library.ask.placeholder", { count: rows.toLocaleString() })}
          value={query}
          autoComplete="off"
          onChange={(e) => {
            onQuery(e.target.value);
            setOpen(true);
            setHl(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && list.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setHl(-1);
            } else if (e.key === "ArrowDown") {
              if (list.length > 0 && hl < list.length - 1) {
                e.preventDefault();
                setHl(hl + 1);
              } else if (onFirst()) {
                e.preventDefault();
                setOpen(false);
              }
            } else if (e.key === "ArrowUp" && list.length > 0 && hl >= 0) {
              e.preventDefault();
              setHl(hl - 1);
            } else if (e.key === "Enter") {
              if (hl >= 0 && list[hl]) {
                e.preventDefault();
                pick(list[hl]);
              } else setOpen(false);
            }
          }}
          autoFocus
        />
        {hint && <span className="lib-search-hint">{t("library.search.hint")}</span>}
      </div>
      {list.length > 0 && (
        <div className="lib-suggest" id="lib-suggest" role="listbox" aria-label={t("library.suggest.label")} data-testid="library-suggest">
          <div className="lib-suggest-label">{t("library.ess.startHere")}</div>
          {list.map((h, i) => (
            <div
              key={h.id}
              role="option"
              aria-selected={i === hl}
              tabIndex={-1}
              className={i === hl ? "lib-suggest-row lib-suggest-row--on" : "lib-suggest-row"}
              data-entry={h.id}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
            >
              <DoorTag /> <span>{h.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
