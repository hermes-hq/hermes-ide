import "../styles/components/SessionCommandsPopover.css";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { ListRow } from "./ui/ListRow";
import { Badge } from "./ui/Badge";
import { CheckGlyph } from "./ui/icons";
import { scrollIntoViewIfNeeded } from "./ui/usePopover";
import { builtinCommands, type SessionCommand } from "../sessionActions/catalog";
import { buildSections, type Section, type SectionId } from "../sessionActions/sections";
import { commandConsequence, commandDescription, commandLabel, confirmWords } from "../sessionActions/text";
import { setActionPinned, usePinnedActions } from "../sessionActions/pins";
import { useRecentCommands } from "../sessionActions/recent";
import { discoverCommands, knownDiscovered, rememberDiscovered, toSessionCommand } from "../sessionActions/discovery";
import { libraryInstalls } from "../library/api";
import { overlayOpened } from "../state/overlays";

export interface SessionCommandsPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  sessionId: string;
  agentId: string | null;
  agentName: string;
  cwd: string | null;
  surface: "terminal" | "agent";
  liveCommands?: readonly SessionCommand[];
  /** Whether a command may run now (the agent waits). */
  ready: boolean;
  waitHint: string;
  /** Open at the confirm step for this destructive command (the palette's pick). */
  initialConfirm?: string | null;
  onRun: (cmd: SessionCommand) => void;
  /** `returnFocus`: put the keyboard back on the trigger (Esc, a pick); not after a press elsewhere. */
  onClose: (returnFocus: boolean) => void;
}

/** The space kept between the list and the window's edges, and the anchor (px). */
const EDGE = 8;
const GAP = 4;
const MAX_WIDTH = 380;
const MAX_HEIGHT = 440;

/** Fixed position under (or over) the anchor, inside the window, again on resize. */
function useAnchoredPosition(anchorRef: RefObject<HTMLElement | null>, popRef: RefObject<HTMLElement | null>): CSSProperties {
  // Placed before the first paint (a layout effect); until then invisible
  // but focusable, so the filter can take the keyboard as the list opens.
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: 0, left: 0, opacity: 0 });
  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(0, Math.min(MAX_WIDTH, vw - 2 * EDGE));
    const left = Math.min(Math.max(EDGE, r.right - width), vw - width - EDGE);
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = below < Math.min(MAX_HEIGHT, popRef.current?.scrollHeight ?? MAX_HEIGHT) && above > below;
    const maxHeight = Math.max(120, Math.min(MAX_HEIGHT, up ? above : below));
    setStyle({
      position: "fixed",
      left,
      width,
      maxHeight,
      ...(up ? { bottom: vh - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, [anchorRef, popRef]);
  useLayoutEffect(() => {
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place]);
  return style;
}

const SECTION_KEY: Record<SectionId, string> = {
  pinned: "sessionActions.section.pinned",
  recent: "sessionActions.section.recent",
  yours: "sessionActions.section.yours",
  builtin: "sessionActions.section.builtin",
  session: "sessionActions.section.session",
};

/**
 * The Commands list of a session: Pinned, Recent, Your commands, Built-in
 * and (last, in the danger ink) Session. A filter field keeps the keyboard:
 * ↑ ↓ Home End move, Enter runs, Esc closes and gives the keyboard back to
 * the trigger. A destructive command asks first, inline. "Edit chips"
 * turns the list into the choice of pinned actions.
 */
export function SessionCommandsPopover({
  anchorRef,
  sessionId,
  agentId,
  agentName,
  cwd,
  surface,
  liveCommands,
  ready,
  waitHint,
  initialConfirm,
  onRun,
  onClose,
}: SessionCommandsPopoverProps) {
  const { t, currentLanguage } = useI18n();
  const id = useId();
  const pinned = usePinnedActions();
  const recent = useRecentCommands(agentId);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(false);
  const builtin = builtinCommands(agentId);
  const [confirm, setConfirm] = useState<SessionCommand | null>(() => (initialConfirm ? (builtin.find((c) => c.text === initialConfirm && c.destructive) ?? null) : null));
  const [yours, setYours] = useState<readonly SessionCommand[]>(() => knownDiscovered(agentId ?? "", cwd));
  const style = useAnchoredPosition(anchorRef, popRef);

  // The person's own commands, read fresh each time the list opens; the
  // ones Hermes installed from the Library are marked so.
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      const found = await discoverCommands(agentId, cwd);
      let libraryPaths: string[] = [];
      if (cwd && found.length > 0) {
        try {
          libraryPaths = (await libraryInstalls(cwd)).records.filter((r) => r.agentId === agentId).map((r) => r.path.replace(/\\/g, "/"));
        } catch {
          libraryPaths = [];
        }
      }
      const commands = found.map((d) => {
        const path = d.path.replace(/\\/g, "/");
        return toSessionCommand(d, libraryPaths.some((p) => path.endsWith(`/${p}`)));
      });
      rememberDiscovered(agentId, cwd, commands);
      if (!cancelled) setYours(commands);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, cwd]);

  // One overlay at a time (the palette, the inbox, the launcher close this).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => overlayOpened("session-commands", () => onCloseRef.current(false)), []);

  // A press outside the list and its trigger closes it (the keyboard stays where it went).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (popRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onCloseRef.current(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchorRef]);

  useEffect(() => {
    if (confirm) cancelRef.current?.focus();
    else inputRef.current?.focus();
  }, [confirm]);

  const words = useCallback(
    (cmd: SessionCommand) => `${commandLabel(cmd, t)} ${cmd.destructive ? commandConsequence(cmd, t) : commandDescription(cmd, t)}`,
    // currentLanguage: t is stable; the words change with the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, currentLanguage],
  );

  const sections: Section[] = useMemo(() => {
    if (editing) {
      const q = filter.trim().toLowerCase();
      const items = builtin.filter((c) => c.action && !c.destructive && (!q || `${c.text} ${words(c)}`.toLowerCase().includes(q)));
      return items.length ? [{ id: "pinned" as const, items }] : [];
    }
    return buildSections({ builtin, yours, live: liveCommands, pinned, recent, filter, words });
  }, [editing, builtin, yours, liveCommands, pinned, recent, filter, words]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => setActive(0), [filter, editing]);
  const activeIdx = Math.min(active, flat.length - 1);
  const optionId = (i: number) => `${id}-opt-${i}`;
  useEffect(() => {
    if (activeIdx >= 0) scrollIntoViewIfNeeded(document.getElementById(optionId(activeIdx)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx]);

  const choose = (cmd: SessionCommand | undefined) => {
    if (!cmd) return;
    if (editing) {
      if (cmd.action) void setActionPinned(cmd.action, !pinned.includes(cmd.action));
      return;
    }
    if (!ready) return;
    if (cmd.destructive) {
      setConfirm(cmd);
      return;
    }
    onRun(cmd);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (confirm) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setConfirm(null);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(Math.max(0, i) + 1, flat.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        if (e.target === inputRef.current && filter) break;
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        if (e.target === inputRef.current && filter) break;
        e.preventDefault();
        setActive(flat.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        choose(flat[activeIdx]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (editing) setEditing(false);
        else onClose(true);
        break;
    }
  };

  const listLabel = t("sessionActions.listLabel", { agent: agentName });
  let index = -1;

  return (
    <div
      ref={popRef}
      className="session-commands"
      style={style}
      role="dialog"
      aria-label={listLabel}
      data-session-commands-popover={sessionId}
      data-surface={surface}
      onKeyDown={onKeyDown}
      // The pane puts the keyboard in its terminal on a press anywhere in it;
      // a press in this list keeps it here.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {confirm ? (
        (() => {
          const { question, button } = confirmWords(confirm, agentName, t);
          return (
            <div className="session-commands-confirm" role="group" aria-labelledby={`${id}-q`} aria-describedby={`${id}-c`} data-confirm={confirm.text}>
              <div id={`${id}-q`} className="session-commands-confirm-question">
                {question}
              </div>
              <div id={`${id}-c`} className="session-commands-confirm-consequence">
                {commandConsequence(confirm, t)}
              </div>
              <div className="session-commands-confirm-actions">
                <Button ref={cancelRef} size="sm" onClick={() => setConfirm(null)}>
                  {t("sessionActions.confirm.cancel")}
                </Button>
                <Button size="sm" variant="danger-solid" data-confirm-run="" onClick={() => onRun(confirm)}>
                  {button}
                </Button>
              </div>
            </div>
          );
        })()
      ) : (
        <>
          <div className="session-commands-search">
            <Input
              ref={inputRef}
              size="sm"
              role="combobox"
              aria-label={t("sessionActions.filterLabel")}
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={activeIdx >= 0 ? optionId(activeIdx) : undefined}
              placeholder={editing ? t("sessionActions.filterPins") : t("sessionActions.filterPlaceholder")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
          {editing ? (
            <div className="session-commands-hint">{t("sessionActions.editHint")}</div>
          ) : (
            !ready && (
              <div className="session-commands-hint session-commands-hint-wait" role="note">
                {waitHint}
              </div>
            )
          )}
          <div
            id={`${id}-list`}
            className="session-commands-list"
            role="listbox"
            aria-label={listLabel}
            aria-multiselectable={editing || undefined}
          >
            {flat.length === 0 && <div className="session-commands-empty">{t("sessionActions.noMatches")}</div>}
            {sections.map((section) => (
              <div key={section.id} role="group" aria-labelledby={`${id}-${section.id}`} className={`session-commands-section session-commands-section-${section.id}`}>
                <div id={`${id}-${section.id}`} className="session-commands-section-title" role="presentation">
                  {editing ? t("sessionActions.section.actions") : t(SECTION_KEY[section.id])}
                </div>
                {section.items.map((cmd) => {
                  index += 1;
                  const i = index;
                  const isPinned = !!cmd.action && pinned.includes(cmd.action);
                  const disabled = !editing && !ready;
                  const label = commandLabel(cmd, t);
                  const detail = cmd.destructive ? commandConsequence(cmd, t) : commandDescription(cmd, t);
                  return (
                    <ListRow
                      key={`${section.id}:${cmd.text}`}
                      id={optionId(i)}
                      size="lg"
                      role="option"
                      aria-selected={editing ? isPinned : i === activeIdx}
                      aria-disabled={disabled || undefined}
                      highlighted={i === activeIdx}
                      className={["session-commands-item", cmd.destructive && "session-commands-item-danger", disabled && "session-commands-item-disabled"].filter(Boolean).join(" ")}
                      data-command={cmd.text}
                      data-source={cmd.source}
                      title={disabled ? waitHint : undefined}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(cmd)}
                    >
                      {editing && (
                        <span className={`session-commands-check${isPinned ? " session-commands-check-on" : ""}`} aria-hidden="true">
                          {isPinned && <CheckGlyph />}
                        </span>
                      )}
                      <span className="session-commands-text">
                        <span className="session-commands-line">
                          <span className="session-commands-label">{label}</span>
                          {label !== cmd.text && <code className="session-commands-cmd">{cmd.text}</code>}
                          {cmd.argumentHint && <span className="session-commands-hint-arg">{cmd.argumentHint}</span>}
                        </span>
                        {detail && <span className="session-commands-desc">{detail}</span>}
                      </span>
                      {cmd.source !== "builtin" && (
                        <Badge tone={cmd.source === "library" ? "info" : "neutral"} className="session-commands-badge">
                          {cmd.source === "library" ? t("sessionActions.badge.library") : cmd.scope === "project" ? t("sessionActions.badge.project") : t("sessionActions.badge.personal")}
                        </Badge>
                      )}
                      {!editing && isPinned && section.id !== "pinned" && <span className="session-commands-pin" aria-hidden="true" />}
                    </ListRow>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="session-commands-footer">
            <span className="session-commands-keys" aria-hidden="true">
              {t("sessionActions.keysHint")}
            </span>
            {builtin.some((c) => c.action && !c.destructive) && (
              <Button size="sm" variant="quiet" className="session-commands-edit" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                {editing ? t("sessionActions.editDone") : t("sessionActions.editChips")}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
