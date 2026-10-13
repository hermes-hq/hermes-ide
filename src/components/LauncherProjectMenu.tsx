import "../styles/components/LauncherProjectMenu.css";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { ProjectOrdered } from "../types/project";
import { fuzzyRank } from "../utils/fuzzy";
import { tildePath } from "../utils/paths";
import { fmt } from "../utils/platform";
import { Button, Checkbox, IconButton, ListRow } from "./ui";
import { cx } from "./ui/Button";
import { moveBy, PAGE_SIZE } from "./ui/listNav";
import { CloseGlyph, FolderGlyph, PlusGlyph, SearchGlyph } from "./ui/icons";

/** How many projects the Recent section holds. */
const RECENT_MAX = 5;
const DAY_MS = 86_400_000;
const ALL = Number.POSITIVE_INFINITY;
/** The key's own name on the keycap (not translated, like ↵ and ↑↓). */
const ESC_KEY = "esc";

/** When the project was last opened, in ms (SQLite's "YYYY-MM-DD HH:MM:SS" is UTC). */
function lastOpenedMs(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at.includes("T") ? at : `${at.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** How often and how lately a project was used: sessions / (1 + weeks since it was last opened). */
function frecency(p: ProjectOrdered, now: number): number {
  const at = lastOpenedMs(p.last_opened_at);
  if (at === null) return 0;
  const days = Math.max(0, now - at) / DAY_MS;
  return (p.session_count ?? 0) / (1 + days / 7);
}

/** "2h", "3d", "5w", "2mo": how long ago, as the key and the number to say it with. */
function agoParts(at: number, now: number): { key: string; n: number } {
  const d = Math.max(0, now - at) / DAY_MS;
  if (d < 1) return { key: "launcher.agoHours", n: Math.max(1, Math.round(d * 24)) };
  if (d < 7) return { key: "launcher.agoDays", n: Math.max(1, Math.round(d)) };
  if (d < 60) return { key: "launcher.agoWeeks", n: Math.max(1, Math.round(d / 7)) };
  return { key: "launcher.agoMonths", n: Math.max(2, Math.round(d / 30)) };
}

function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return "";
  return cut === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut);
}

const missing = (p: ProjectOrdered) => p.path_exists === false;
const byName = (a: ProjectOrdered, b: ProjectOrdered) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

type Item =
  | { kind: "use"; path: string }
  | { kind: "project"; project: ProjectOrdered; hits?: number[]; main?: boolean }
  | { kind: "open" }
  | { kind: "new" };

interface Group {
  label: string | null;
  items: Item[];
}

/** The task's extra folders, as the menu shows and changes them. */
export interface LauncherExtras {
  /** The extra folders, in the order they were added. */
  paths: string[];
  /** An extra folder's state ("⎇ dev ●3", "not git"); undefined while it is read. */
  detail: (path: string) => string | undefined;
  /** Why a project cannot be an extra folder now (its row's detail and title), or null. */
  blocked: (project: ProjectOrdered) => string | null;
  /** Checks or unchecks a folder as an extra one. */
  onToggle: (path: string) => void;
}

interface LauncherProjectMenuProps {
  /** Every registered project, missing folders too (they show last). */
  projects: ProjectOrdered[];
  /** The projects could not be read: said with a Retry. */
  loadFailed?: boolean;
  onRetry?: () => void;
  /** Whether a path is the launcher's project now (the brass rail). */
  isCurrent: (path: string) => boolean;
  /** The home folder, shown as "~" (null: paths as they are). */
  home: string | null;
  /** A project row or "Use this folder" was chosen: the path to launch in. */
  onPick: (path: string) => void;
  /** Open folder…: the system's folder dialog. */
  onOpenFolder: () => void;
  /** New project…: the form opens in place of the list. */
  onNewProject: () => void;
  /** The New project form while it is open (in place of the list). */
  newProject?: ReactNode;
  /** Removes a project from the list (never its files); rejects with the reason it could not. */
  onRemove: (project: ProjectOrdered) => Promise<void>;
  /** The typed-path field, under the actions. */
  typedPath?: ReactNode;
  /** The task's extra folders; null: the agent works in one folder (no checkboxes, said in the hints). */
  extras: LauncherExtras | null;
  /** Test seam: the time "last used" is measured from. */
  now?: number;
}

/** The marked characters of a name (the ones the search matched). */
function Marked({ text, hits }: { text: string; hits?: number[] }) {
  if (!hits || hits.length === 0) return <>{text}</>;
  const set = new Set(hits);
  const parts: ReactNode[] = [];
  let run = "";
  let runHit = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(runHit ? <strong key={key} className="launcher-pm-hit">{run}</strong> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== runHit) {
      flush(i);
      runHit = hit;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

/**
 * The launcher's project menu: a search field on top, Recent (by how often
 * and how lately each was used) and All projects (A–Z) below it, Open
 * folder… and New project… pinned under the list. Arrows move the
 * highlight, Enter picks, the first Esc clears the search. A project can be
 * removed from the list (its files stay) after a confirm in its own row.
 * Each row's checkbox (or ⇧↵) adds it to the task as an extra folder; the
 * main project and the extra ones sit on top, under "In this task".
 */
export function LauncherProjectMenu({
  projects,
  loadFailed = false,
  onRetry,
  isCurrent,
  home,
  onPick,
  onOpenFolder,
  onNewProject,
  newProject,
  onRemove,
  typedPath,
  extras,
  now: nowProp,
}: LauncherProjectMenuProps) {
  const { t } = useI18n();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optId = (i: number) => `${baseId}-opt-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // null: the default highlight (the current project with no search, else the first row).
  const [hl, setHl] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [now] = useState(() => nowProp ?? Date.now());
  const q = query.trim();
  const pathQuery = /^[~/]/.test(q);

  const shownPath = (path: string) => tildePath(path, home);
  const extraPaths = useMemo(() => extras?.paths ?? [], [extras]);
  const isExtra = (path: string) => extraPaths.includes(path);

  const groups = useMemo((): Group[] => {
    if (pathQuery) {
      const want = q.toLowerCase();
      const under = projects.filter((p) => p.path.toLowerCase().startsWith(want) || tildePath(p.path, home).toLowerCase().startsWith(want));
      return [{ label: null, items: [{ kind: "use", path: q }, ...under.map((project): Item => ({ kind: "project", project }))] }];
    }
    const scored = projects.map((p, i) => ({ p, i, s: frecency(p, now) }));
    if (q) {
      // Most used first among equal matches; missing folders after the rest.
      const pool = [...scored].sort((a, b) => Number(missing(a.p)) - Number(missing(b.p)) || b.s - a.s || a.i - b.i).map((x) => x.p);
      const named = fuzzyRank(pool, q, (p) => p.name, ALL);
      const seen = new Set(named.map((m) => m.item));
      const byPath = fuzzyRank(
        pool.filter((p) => !seen.has(p)),
        q,
        (p) => tildePath(p.path, home),
        ALL,
      );
      const ranked: Item[] = [
        ...named.map((m): Item => ({ kind: "project", project: m.item, hits: m.matches })),
        ...byPath.map((m): Item => ({ kind: "project", project: m.item })),
      ];
      const live = ranked.filter((it) => it.kind === "project" && !missing(it.project));
      const gone = ranked.filter((it) => it.kind === "project" && missing(it.project));
      return [{ label: null, items: [...live, ...gone] }];
    }
    // In this task: the main project, then the extra folders (not repeated below).
    const main = projects.find((p) => !missing(p) && isCurrent(p.path));
    const extraRows = extraPaths.map((path) => projects.find((p) => p.path === path)).filter((p): p is ProjectOrdered => !!p && p !== main);
    const inTask = new Set<ProjectOrdered>(main ? [main, ...extraRows] : extraRows);
    const taskGroup: Group[] =
      inTask.size > 0
        ? [{ label: t("launcher.projectsInTask"), items: [...(main ? [{ kind: "project", project: main, main: true } as Item] : []), ...extraRows.map((project): Item => ({ kind: "project", project }))] }]
        : [];
    const recent = scored
      .filter((x) => !inTask.has(x.p))
      .filter((x) => !missing(x.p) && x.s > 0)
      .sort((a, b) => b.s - a.s || (b.p.session_count ?? 0) - (a.p.session_count ?? 0) || a.i - b.i)
      .slice(0, RECENT_MAX)
      .map((x) => x.p);
    const inRecent = new Set(recent);
    const shown = (p: ProjectOrdered) => !inRecent.has(p) && !inTask.has(p);
    const rest = [...projects.filter((p) => !missing(p) && shown(p)).sort(byName), ...projects.filter((p) => missing(p) && shown(p)).sort(byName)];
    const asItems = (list: ProjectOrdered[]) => list.map((project): Item => ({ kind: "project", project }));
    if (recent.length === 0) {
      if (taskGroup.length === 0) return [{ label: null, items: asItems(rest) }];
      return rest.length ? [...taskGroup, { label: t("launcher.projectsAll"), items: asItems(rest) }] : taskGroup;
    }
    const out: Group[] = [...taskGroup, { label: t("launcher.projectsRecent"), items: asItems(recent) }];
    if (rest.length) out.push({ label: t("launcher.projectsAll"), items: asItems(rest) });
    return out;
  }, [projects, q, pathQuery, home, now, t, isCurrent, extraPaths]);

  const listItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const items = useMemo((): Item[] => [...listItems, { kind: "open" }, { kind: "new" }], [listItems]);
  const nav = useMemo(() => items.map(() => ({ text: "" })), [items]);

  const defaultHl = useMemo(() => {
    if (!q) {
      const i = items.findIndex((it) => it.kind === "project" && !missing(it.project) && isCurrent(it.project.path));
      if (i >= 0) return i;
    }
    return 0;
  }, [items, q, isCurrent]);
  const active = Math.min(hl ?? defaultHl, items.length - 1);

  useEffect(() => {
    document.getElementById(optId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Back from the New project form: the search has the keyboard again.
  const formOpen = !!newProject;
  const wasForm = useRef(formOpen);
  useEffect(() => {
    if (wasForm.current && !formOpen) inputRef.current?.focus();
    wasForm.current = formOpen;
  }, [formOpen]);

  const startRemove = (p: ProjectOrdered) => {
    setConfirmId(p.id);
    setRemoveError(null);
  };
  const cancelRemove = () => {
    setConfirmId(null);
    setRemoveError(null);
    inputRef.current?.focus();
  };
  const confirmRemove = async (p: ProjectOrdered) => {
    setRemoving(true);
    try {
      await onRemove(p);
      setConfirmId(null);
      setRemoveError(null);
      inputRef.current?.focus();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  };

  const choose = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === "use") onPick(it.path);
    else if (it.kind === "project") {
      // A folder that is gone cannot be launched in: offer to remove it instead.
      if (missing(it.project)) startRemove(it.project);
      else onPick(it.project.path);
    } else if (it.kind === "open") onOpenFolder();
    else onNewProject();
  };

  /** Checks or unchecks a row as an extra folder: the menu stays open and the search clears. */
  const toggleExtra = (p: ProjectOrdered) => {
    if (!extras || isCurrent(p.path)) return;
    if (!isExtra(p.path) && extras.blocked(p)) return;
    extras.onToggle(p.path);
    setQuery("");
    setHl(null);
    setConfirmId(null);
    inputRef.current?.focus();
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const move = (to: number) => {
      e.preventDefault();
      if (to >= 0) setHl(to);
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
        return move(0);
      case "End":
        return move(items.length - 1);
      case "Enter": {
        // ⇧↵: the highlighted project is added to (or taken out of) the task's extra folders.
        const it = items[active];
        if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && extras && it?.kind === "project") {
          e.preventDefault();
          e.stopPropagation();
          toggleExtra(it.project);
          return;
        }
        // ⌘↵ / Ctrl+↵ goes on to the sheet: it launches.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        // The confirm is open while the search has the keyboard: ↵ never removes (Tab to Remove does).
        if (confirmId) {
          cancelRemove();
          return;
        }
        choose(it);
        return;
      }
      case "Delete":
      case "Backspace": {
        const it = items[active];
        // ⌘⌫ / Ctrl+⌫: the highlighted extra folder leaves the task.
        if (e.metaKey || e.ctrlKey) {
          if (it?.kind !== "project" || !isExtra(it.project.path)) return;
          e.preventDefault();
          toggleExtra(it.project);
          return;
        }
        // A held key (clearing the search) never asks to remove.
        if (e.repeat || query !== "" || it?.kind !== "project") return;
        e.preventDefault();
        startRemove(it.project);
        return;
      }
    }
  };

  /** Esc: the confirm first, then the search; with neither, the menu closes (the sheet's own Esc). */
  const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    if (confirmId) {
      e.preventDefault();
      e.stopPropagation();
      cancelRemove();
    } else if (query && e.target === inputRef.current) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
      setHl(null);
    }
  };

  const rowProps = (i: number) => ({
    id: optId(i),
    role: "option",
    "aria-selected": i === active,
    highlighted: i === active,
    onMouseMove: () => {
      if (i !== active) setHl(i);
    },
    // The search keeps the keyboard while the pointer picks.
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
    onClick: () => choose(items[i]),
  });

  const projectRow = (it: Extract<Item, { kind: "project" }>, i: number) => {
    const p = it.project;
    const gone = missing(p);
    const parent = shownPath(parentPath(p.path));
    if (confirmId === p.id) {
      return (
        <ListRow
          key={p.id}
          size="sm"
          id={optId(i)}
          role="option"
          aria-selected={i === active}
          highlighted={i === active}
          className="launcher-pm-row launcher-pm-confirm"
          data-project-path={p.path}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="launcher-pm-confirm-text">{t("launcher.projectRemoveAsk", { name: p.name })}</span>
          <Button size="sm" variant="danger" className="launcher-pm-confirm-remove" loading={removing} onClick={() => void confirmRemove(p)}>
            {t("launcher.projectRemoveConfirm")}
          </Button>
          <Button size="sm" variant="quiet" className="launcher-pm-confirm-cancel" onClick={cancelRemove}>
            {t("common.cancel")}
          </Button>
          {removeError !== null && (
            <span className="launcher-pm-confirm-error" role="alert">
              {t("launcher.projectRemoveFailed", { error: removeError })}
            </span>
          )}
        </ListRow>
      );
    }
    const at = lastOpenedMs(p.last_opened_at);
    const ago = at === null ? null : agoParts(at, now);
    const main = !gone && isCurrent(p.path);
    const extra = isExtra(p.path);
    const blocked = extras && !main && !extra ? extras.blocked(p) : null;
    const extraDetail = extra ? extras?.detail(p.path) : undefined;
    const detail = blocked ?? extraDetail ?? (gone ? t("launcher.projectMissing") : ago ? t(ago.key, { n: ago.n }) : "");
    return (
      <ListRow
        key={p.id}
        size="sm"
        {...rowProps(i)}
        current={main}
        className={cx("launcher-pm-row", gone && "launcher-pm-missing", blocked && "launcher-pm-blocked")}
        data-project-path={p.path}
        data-extra={extra || undefined}
        title={blocked ?? p.path}
        aria-label={parent ? `${p.name}, ${parent}` : p.name}
      >
        {extras && (
          // The checkbox is its own target: a click on it never picks the row, and the search keeps the keyboard.
          <span className="launcher-pm-gutter" onMouseDown={(e) => e.preventDefault()} onClick={(e) => e.stopPropagation()}>
            {!main && (
              <Checkbox
                inputClassName="launcher-pm-check"
                tabIndex={-1}
                checked={extra}
                disabled={!!blocked}
                title={blocked ?? undefined}
                onChange={() => toggleExtra(p)}
                label={<span className="h-visually-hidden">{t("launcher.extraToggle", { name: p.name })}</span>}
              />
            )}
          </span>
        )}
        <span className="launcher-pm-name">
          <Marked text={p.name} hits={it.hits} />
        </span>
        {it.main && <span className="launcher-pm-main">{t("launcher.projectMain")}</span>}
        <span className="launcher-pm-path">
          <bdi>{parent}</bdi>
        </span>
        <span className={cx("launcher-pm-ago", (blocked || extraDetail) && "launcher-pm-detail")}>{detail}</span>
        <IconButton
          size="sm"
          tabIndex={-1}
          className="launcher-pm-remove"
          label={t("launcher.projectRemove")}
          icon={<CloseGlyph />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            startRemove(p);
          }}
        />
      </ListRow>
    );
  };

  const renderItem = (it: Item, i: number) => {
    if (it.kind === "project") return projectRow(it, i);
    if (it.kind === "use") {
      return (
        <ListRow key="use" size="sm" {...rowProps(i)} className="launcher-pm-row launcher-pm-use">
          <span className="launcher-pm-icon">
            <FolderGlyph />
          </span>
          <span className="launcher-pm-name">{t("launcher.projectUseFolder")}</span>
          <span className="launcher-pm-path">
            <bdi>{it.path}</bdi>
          </span>
        </ListRow>
      );
    }
    return null;
  };

  let index = 0;
  const empty = loadFailed ? (
    <div className="launcher-pm-empty" role="alert">
      <span>{t("launcher.projectsLoadFailed")}</span>
      {onRetry && (
        <Button size="sm" className="launcher-pm-retry" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  ) : listItems.length === 0 ? (
    <div className="launcher-pm-empty" role="status">
      {q ? t("launcher.projectNoMatch", { query: q }) : t("launcher.projectsEmpty")}
    </div>
  ) : null;
  const actionsAt = listItems.length;
  const activeId = items[active] ? optId(active) : undefined;

  return (
    <div className="launcher-pm" onKeyDown={onRootKey} data-extras={extraPaths.length > 0 || undefined}>
      {newProject ? (
        newProject
      ) : (
        <>
          <div className="launcher-pm-search" data-own-enter="true">
            <span className="launcher-pm-search-icon">
              <SearchGlyph />
            </span>
            <input
              ref={inputRef}
              data-autofocus="true"
              className="launcher-pm-input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              aria-label={t("launcher.projectSearch")}
              placeholder={t("launcher.projectSearch")}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHl(null);
                setConfirmId(null);
              }}
              onKeyDown={onInputKey}
            />
          </div>
          <div id={listId} role="listbox" aria-label={t("launcher.menu.project")} className="launcher-pm-options">
            <div className="launcher-pm-list">
              {empty}
              {!loadFailed &&
                groups.map((g, gi) => {
                  const labelId = `${baseId}-group-${gi}`;
                  const rows = g.items.map((it) => renderItem(it, index++));
                  if (rows.length === 0) return null;
                  return g.label ? (
                    <div key={gi} role="group" aria-labelledby={labelId} className="launcher-pm-group">
                      <div id={labelId} className="launcher-pm-section" role="presentation">
                        {g.label}
                      </div>
                      {rows}
                    </div>
                  ) : (
                    <div key={gi} role="group" className="launcher-pm-group">
                      {rows}
                    </div>
                  );
                })}
            </div>
            <div className="h-menu-separator" role="separator" />
            <div role="group" className="launcher-pm-actions">
              <ListRow size="sm" {...rowProps(actionsAt)} className="launcher-pm-row launcher-pm-open-folder">
                <span className="launcher-pm-icon">
                  <FolderGlyph />
                </span>
                <span className="launcher-pm-action-label">{t("launcher.projectOpenFolder")}</span>
              </ListRow>
              <ListRow size="sm" {...rowProps(actionsAt + 1)} className="launcher-pm-row task-launcher-new-folder">
                <span className="launcher-pm-icon">
                  <PlusGlyph />
                </span>
                <span className="launcher-pm-action-label">{t("launcher.projectNew")}</span>
              </ListRow>
            </div>
          </div>
          {typedPath}
          <div className="h-menu-footer launcher-pm-hints">
            <span>
              <kbd>↵</kbd> {extras ? t("launcher.projectHintMain") : t("launcher.projectHintChoose")}
            </span>
            {extras && (
              <span>
                <kbd>⇧↵</kbd> {t("launcher.projectHintAddFolder")}
              </span>
            )}
            <span>
              <kbd>{fmt("{mod}↵")}</kbd> {t("launcher.projectHintLaunch")}
            </span>
            <span>
              <kbd>{ESC_KEY}</kbd> {query ? t("launcher.projectHintClear") : t("launcher.projectHintClose")}
            </span>
            {!extras && <span className="launcher-pm-one-folder">{t("launcher.projectOneFolder")}</span>}
          </div>
        </>
      )}
    </div>
  );
}
