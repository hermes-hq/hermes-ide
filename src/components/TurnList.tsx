import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import "../styles/ui/popover.css";
import { getCurrentLanguage, translate } from "../i18n/registry";
import { translatePlural } from "../i18n/plural";
import type { Turn } from "../agent/contract/turns";
import { ListRow } from "./ui/ListRow";
import { moveBy, PAGE_SIZE } from "./ui/listNav";
import { scrollIntoViewIfNeeded, usePopover } from "./ui/usePopover";

/**
 * F20 — every turn of the session, newest first, in a popover under the
 * turn bar's "+N earlier" chip (loaded on demand). ↑ ↓ Home End PgUp PgDn
 * move, Enter picks (the turn's diff, as a chip click does), Esc closes.
 */

interface TurnListProps {
  /** Oldest first, as the bar holds them; the list shows them newest first. */
  turns: readonly Turn[];
  anchorRef: RefObject<HTMLElement | null>;
  /** The full sentence of a turn (its chip's title). */
  titleOf: (turn: Turn) => string;
  /** "Changes in <project> only…" when the session has other folders. */
  scopeNote: string | null;
  onChoose: (turn: Turn) => void;
  /** Closes the list; `focusAnchor` puts the keyboard back on the chip. */
  onClose: (focusAnchor: boolean) => void;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
];

/** "5 min. ago", "yesterday", "now", in the app's language. */
function ago(at: number, now: number): string {
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(getCurrentLanguage(), { numeric: "auto", style: "short" });
  } catch {
    rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
  }
  const s = Math.max(0, (now - at) / 1000);
  for (const [unit, secs] of UNITS) if (s >= secs) return rtf.format(-Math.floor(s / secs), unit);
  return rtf.format(0, "second");
}

export default function TurnList({ turns, anchorRef, titleOf, scopeNote, onChoose, onClose }: TurnListProps) {
  const baseId = useId();
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = [...turns].reverse();
  const nav = rows.map((t) => ({ text: "", disabled: !!t.degraded }));
  const [active, setActive] = useState(() => Math.max(0, moveBy(nav, -1, 1)));
  const [now] = useState(() => Date.now());
  const dismiss = useCallback(() => onClose(false), [onClose]);
  const style = usePopover({ open: true, anchorRef, popoverRef: popRef, onDismiss: dismiss, matchWidth: false });
  const optId = (i: number) => `${baseId}-turn-${i}`;
  const label = translate("turnBar.allReplies", { count: turns.length });

  useEffect(() => {
    listRef.current?.focus();
  }, []);
  useEffect(() => {
    scrollIntoViewIfNeeded(document.getElementById(optId(active)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const choose = (i: number) => {
    const turn = rows[i];
    if (!turn || turn.degraded) return;
    onClose(false);
    onChoose(turn);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = (to: number) => {
      e.preventDefault();
      if (to >= 0) setActive(to);
    };
    switch (e.key) {
      case "ArrowDown":
        return move(moveBy(nav, active, 1));
      case "ArrowUp":
        return move(moveBy(nav, active, -1));
      case "PageDown":
        return move(moveBy(nav, active, PAGE_SIZE));
      case "PageUp":
        return move(moveBy(nav, active, -PAGE_SIZE));
      case "Home":
        return move(moveBy(nav, -1, 1));
      case "End":
        return move(moveBy(nav, -1, -1));
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
        return;
      case "Tab":
        onClose(true);
        return;
    }
  };

  return createPortal(
    <div ref={popRef} className="h-popover turn-list" style={style} data-turn-list="true">
      <div className="turn-list-header">
        <span className="turn-list-title">{label}</span>
        {scopeNote && <span className="turn-list-scope">{scopeNote}</span>}
      </div>
      <div
        ref={listRef}
        className="turn-list-rows"
        role="listbox"
        tabIndex={-1}
        aria-label={label}
        aria-description={scopeNote ?? undefined}
        aria-activedescendant={rows[active] ? optId(active) : undefined}
        onKeyDown={onKeyDown}
      >
        {rows.map((turn, i) => {
          const { files, insertions, deletions } = turn.diffstat;
          const at = turn.endedAt ?? turn.startedAt;
          return (
            <ListRow
              key={turn.n}
              id={optId(i)}
              size="sm"
              role="option"
              aria-selected={i === active}
              aria-disabled={turn.degraded || undefined}
              aria-label={titleOf(turn)}
              title={titleOf(turn)}
              highlighted={i === active}
              className="turn-list-row"
              data-turn-n={turn.n}
              onMouseMove={() => {
                if (i !== active && !turn.degraded) setActive(i);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              <span className="turn-list-name">{translate("turnBar.turnName", { n: turn.n })}</span>
              {at > 0 && <span className="turn-list-ago">{ago(at, now)}</span>}
              <span className="turn-list-files">{translatePlural("turnBar.files", files)}</span>
              <span className="turn-bar-turn-stat">
                <span className="turn-bar-add">+{insertions}</span>
                <span className="turn-bar-del">−{deletions}</span>
              </span>
              <span className={turn.checks ? `turn-bar-checks turn-bar-checks-${turn.checks.state}` : "turn-bar-checks"} aria-hidden="true">
                {turn.checks ? (turn.checks.state === "passed" ? "✓" : "✗") : ""}
              </span>
            </ListRow>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
