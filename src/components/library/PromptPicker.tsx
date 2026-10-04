// ─── Prompts (⌘J): find a prompt, fill it in, put it to work ──────────
//
// One palette for every place a prompt is used: a session's Prompts
// button and ⌘J (insert into the session), the task launcher (use as the
// task) and the command palette. The list is on the left (Pinned, Recent and
// For you; with a query, Mine then the Library), the chosen prompt on the
// right as something to read and fill in, never as source. Loaded on
// demand; plan: docs in the PR, rules in src/library/promptPicker.ts.

import "../../styles/components/PromptPicker.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Button, Chip, Input, Menu, Select, Textarea, type SelectOption } from "../ui";
import { useI18n } from "../../i18n/I18nProvider";
import { useLibraryMessages } from "../../library/messages";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { libraryGet, libraryHits, libraryInstalls, libraryItemStates, libraryRecordUse, librarySearch, librarySetItem, libraryStatus } from "../../library/api";
import { argsOf, defaultValues, loadCore, renderWith } from "../../library/render";
import { listParts, type PartItem } from "../../library/parts";
import { agentName, agentsForTarget, invocation } from "../../library/targets";
import {
  deleteMyPrompt,
  loadMyPrompts,
  onMyPromptsChange,
  recordMyUse,
  saveMyPrompt,
  setMyPinned,
  takeMigrationNotice,
  type MyPrompt,
} from "../../library/myPrompts";
import {
  buildItems,
  composeText,
  editableText,
  filtersFor,
  humanize,
  kindGroup,
  kindsFor,
  layoutItems,
  markedValues,
  moveSelection,
  pickables,
  prefillTarget,
  readableSections,
  savedArgs,
  unmark,
  visibleRange,
  type Block,
  type Inline,
  type Pickable,
  type PickerContext,
  type PickerFilter,
  type PickerItem,
  type RecentEntry,
} from "../../library/promptPicker";
import type { EntryArg, EntryBody, EntryDetail, ItemState, LibraryContext, LibraryHit } from "../../library/types";
import { KindIcon } from "./PromptPickerParts";

export const PICKER_ROW_HEIGHT = 52;
export const PICKER_GROUP_HEIGHT = 28;
const SEARCH_DEBOUNCE_MS = 80;
const PAGE = 50;

/** What the launcher takes from a pick. */
export interface PromptPick {
  kind: "prompt" | "workflow" | "persona" | "style";
  /** A library id, or a Mine id (then `mine` is true). */
  id: string;
  version: string;
  title: string;
  /** The text with everything filled in (a persona: as a role). */
  text: string;
  mine: boolean;
  /** "Act as" chosen with a task. */
  persona?: { id: string; version: string; title: string; text: string } | null;
}

/** How the session context delivers; the component stays free of session plumbing. */
export interface PickerDelivery {
  /** The session the text goes to, for the button's words ("Insert into …"). */
  label: string;
  /** Puts the text in the session; `send` presses Enter after it. Resolves to what happened. */
  place(text: string, opts: { title: string; send: boolean }): Promise<"pasted" | "sent" | "draft" | "copied" | "empty">;
  /** Whether "Insert and send" makes sense (a terminal session). */
  canSend: boolean;
}

export interface PromptPickerProps {
  context: PickerContext;
  delivery?: PickerDelivery;
  /** The launcher: called with the pick ("Use as task"). */
  onUse?: (pick: PromptPick) => void;
  /** Library context for ranking and filtering (project, agents). */
  libraryContext?: LibraryContext;
  /** The launch's agents (hodios targets): rows must work in one of them. */
  works?: string[];
  /** Text that goes into the first blank (terminal selection, the launcher's task). */
  prefill?: string;
  /** The project, for "Use without Hermes". */
  projectPath?: string | null;
  onClose: () => void;
  /** Opens the Library view at an entry (`install`: with the install step open). */
  onOpenLibrary?: (entryId: string | null, install?: boolean) => void;
  /** Import and export of Mine as files. */
  onImport?: () => void;
  onExport?: () => void;
  /** Inside another dialog's overlay (the launcher): no scrim of its own. */
  embedded?: boolean;
  toast?: (message: string, type?: "info" | "success" | "warning" | "error") => void;
}

interface Draft {
  values: Record<string, string>;
  persona: string;
  style: string;
  level: number;
  editing: boolean;
  editText: string;
}

/** Fills, persona, style and edits per prompt, kept for the app's life until that prompt is used. */
const drafts = new Map<string, Draft>();
function draftOf(key: string): Draft {
  let d = drafts.get(key);
  if (!d) {
    d = { values: {}, persona: "", style: "", level: 3, editing: false, editText: "" };
    drafts.set(key, d);
  }
  return d;
}
/** Test hook. */
export function resetPickerDrafts(): void {
  drafts.clear();
}

/** A Mine item as an entry body, so the same renderer fills its blanks. */
function mineBody(m: MyPrompt): EntryBody {
  return { schema: 1, fm: { id: m.id, kind: m.kind, title: m.title, version: "0", args: m.args ?? [] }, body: m.text, steps: [] };
}

type Core = Awaited<ReturnType<typeof loadCore>>;

export function PromptPicker(props: PromptPickerProps) {
  const ready = useLibraryMessages();
  if (!ready) return null;
  return <PickerDialog {...props} />;
}

function PickerDialog({
  context,
  delivery,
  onUse,
  libraryContext,
  works,
  prefill,
  projectPath,
  onClose,
  onOpenLibrary,
  onImport,
  onExport,
  embedded = false,
  toast,
}: PromptPickerProps) {
  const { t } = useI18n();
  const baseId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PickerFilter>("all");
  const [selKey, setSelKey] = useState<string | null>(null);
  const [mine, setMine] = useState<MyPrompt[]>([]);
  const [states, setStates] = useState<ItemState[]>([]);
  const [pinnedHits, setPinnedHits] = useState<LibraryHit[]>([]);
  const [recentHits, setRecentHits] = useState<LibraryHit[]>([]);
  const [hits, setHits] = useState<LibraryHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [personal, setPersonal] = useState(true);
  const [loading, setLoading] = useState(true);
  const [libState, setLibState] = useState<"loading" | "ready" | "failed">("loading");
  const [details, setDetails] = useState<Record<string, EntryDetail>>({});
  const [core, setCore] = useState<Core | null>(null);
  const [personas, setPersonas] = useState<PartItem[] | null>(null);
  const [styles, setStyles] = useState<PartItem[] | null>(null);
  const [partText, setPartText] = useState<Record<string, EntryDetail>>({});
  const [installs, setInstalls] = useState<{ id: string; target: string }[]>([]);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState<null | { name: string }>(null);
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [firstRun, setFirstRun] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<null | { send: boolean }>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 480 });
  const searchSeq = useRef(0);
  const prefillUsed = useRef(new Set<string>());

  useFocusTrap(dialogRef, { onEscape: () => escape(), initialFocus: ".pp-input" });

  // ── Data ──────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    loadMyPrompts()
      .then((list) => {
        if (!live) return;
        setMine(list);
        const n = takeMigrationNotice();
        if (n && n.prompts + n.personas + n.styles > 0) setNotice(t("library.prompts.migrated", { count: n.prompts + n.personas + n.styles }));
      })
      .catch(() => {});
    const off = onMyPromptsChange((list) => live && setMine(list));
    libraryStatus()
      .then((s) => live && setLibState(s.ready ? "ready" : "failed"))
      .catch(() => live && setLibState("failed"));
    loadCore()
      .then((c) => live && setCore(c))
      .catch(() => {});
    try {
      setFirstRun(localStorage.getItem("hermes.prompts.seen") !== "1");
    } catch {
      /* storage blocked: no first-run note */
    }
    return () => {
      live = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ctx: LibraryContext = useMemo(() => ({ ...(libraryContext ?? {}), ...(works && works.length ? { works } : {}) }), [libraryContext, works]);

  const refreshStates = useCallback(() => {
    if (libState !== "ready") return;
    libraryItemStates()
      .then(setStates)
      .catch(() => setStates([]));
  }, [libState]);
  useEffect(refreshStates, [refreshStates]);

  const pinnedIds = useMemo(() => states.filter((s) => s.pinned).map((s) => s.itemId), [states]);
  const recentStates = useMemo(
    () =>
      states
        .filter((s) => s.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, 8),
    [states],
  );
  useEffect(() => {
    if (libState !== "ready") return;
    let live = true;
    const ids = [...new Set([...pinnedIds, ...recentStates.map((s) => s.itemId)])];
    if (ids.length === 0) {
      setPinnedHits([]);
      setRecentHits([]);
      return;
    }
    libraryHits(ids, ctx)
      .then((list) => {
        if (!live) return;
        const by = new Map(list.map((h) => [h.id, h]));
        setPinnedHits(pinnedIds.map((id) => by.get(id)).filter((h): h is LibraryHit => !!h));
        setRecentHits(recentStates.map((s) => by.get(s.itemId)).filter((h): h is LibraryHit => !!h));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [libState, pinnedIds, recentStates, ctx]);

  // The search: For you with no query, by relevance with one. Mine, Pinned and Recent need none.
  const searching = filter === "all" || filter === "task" || filter === "persona" || filter === "style";
  useEffect(() => {
    if (libState === "failed") setLoading(false);
    if (libState !== "ready") return;
    if (!searching) {
      setHits([]);
      setCursor(null);
      setLoading(false);
      return;
    }
    const n = ++searchSeq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      // With nothing typed, All opens on tasks: personas and answer styles go with a task, under their own chips.
      const kind = !query.trim() && filter === "all" ? kindsFor("task", context) : kindsFor(filter, context);
      librarySearch({ query, filters: { kind, ...(works && works.length ? { works } : {}) }, limit: PAGE, sort: query.trim() ? "best" : "you", personalise: true }, ctx)
        .then((page) => {
          if (n !== searchSeq.current) return;
          setHits(page.hits);
          setCursor(page.nextCursor);
          setPersonal(!query.trim());
        })
        .catch(() => n === searchSeq.current && setHits([]))
        .finally(() => n === searchSeq.current && setLoading(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [libState, query, filter, context, works, ctx, searching]);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    const n = searchSeq.current;
    setLoading(true);
    librarySearch({ query, filters: { kind: !query.trim() && filter === "all" ? kindsFor("task", context) : kindsFor(filter, context), ...(works && works.length ? { works } : {}) }, limit: PAGE, cursor, sort: query.trim() ? "best" : "you", personalise: true }, ctx)
      .then((page) => {
        if (n !== searchSeq.current) return;
        setHits((prev) => [...prev, ...page.hits.filter((h) => !prev.some((p) => p.id === h.id))]);
        setCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => n === searchSeq.current && setLoading(false));
  }, [cursor, loading, query, filter, context, works, ctx]);

  useEffect(() => {
    if (!projectPath || libState !== "ready") return;
    let live = true;
    libraryInstalls(projectPath)
      .then((inst) => live && setInstalls(inst.lock.entries.map((e) => ({ id: e.id, target: e.target }))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, libState]);

  // ── The list ──────────────────────────────────────────────────────
  const recent: RecentEntry[] = useMemo(
    () => [
      ...recentHits.map((hit) => ({ hit, at: states.find((s) => s.itemId === hit.id)?.lastUsedAt ?? 0 })),
      ...mine.filter((m) => m.lastUsedAt).map((m) => ({ mine: m, at: m.lastUsedAt ?? 0 })),
    ],
    [recentHits, mine, states],
  );
  const items = useMemo(
    () => buildItems({ query, filter, context, mine, pinnedHits, recent, hits, personal }),
    [query, filter, context, mine, pinnedHits, recent, hits, personal],
  );
  const rows = useMemo(() => pickables(items), [items]);
  const rowPosition = useMemo(() => new Map(rows.map((r, i) => [r.key, i + 1])), [rows]);
  const selected: Pickable | null = rows.find((r) => r.key === selKey) ?? rows[0] ?? null;
  const key = selected?.key ?? null;

  const layout = useMemo(() => layoutItems(items, PICKER_ROW_HEIGHT, PICKER_GROUP_HEIGHT), [items]);
  const range = visibleRange(layout, scroll.top, scroll.height);
  useEffect(() => {
    if (range.end >= items.length - 8 && cursor && !loading) loadMore();
  }, [range.end, items.length, cursor, loading, loadMore]);
  const onListScroll = () => {
    const el = listRef.current;
    if (el) setScroll({ top: el.scrollTop, height: el.clientHeight || 480 });
  };
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setScroll({ top: el.scrollTop, height: el.clientHeight || 480 });
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, height: el.clientHeight || 480 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Keep the chosen row in view.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !key) return;
    const i = items.findIndex((it) => it.key === key);
    if (i < 0) return;
    const top = layout.offsets[i];
    const bottom = top + layout.heights[i];
    // The group header above the first row of a group comes into view with it.
    const head = i > 0 && items[i - 1].type === "group" ? layout.offsets[i - 1] : top;
    if (head < el.scrollTop) el.scrollTop = head;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [key, items, layout]);

  // ── The chosen prompt ─────────────────────────────────────────────
  const hitId = selected?.type === "hit" ? selected.hit.id : null;
  useEffect(() => {
    if (!hitId || details[hitId]) return;
    let live = true;
    libraryGet(hitId)
      .then((d) => {
        if (!live) return;
        setDetails((prev) => ({ ...prev, [hitId]: d }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hitId, details]);
  const detail = hitId ? (details[hitId] ?? null) : null;
  const body: EntryBody | null = selected?.type === "mine" ? mineBody(selected.item) : (detail?.body ?? null);
  const kind = selected ? (selected.type === "mine" ? selected.item.kind : selected.hit.kind) : null;
  const title = selected ? (selected.type === "mine" ? selected.item.title : selected.hit.title) : "";
  const args: EntryArg[] = useMemo(() => argsOf(body), [body]);
  const draft = key ? draftOf(key) : null;
  const isTask = kind === "prompt" || kind === "workflow";

  // The first time a prompt is shown, its defaults go in, and the selection or the launcher's text goes into its first blank.
  if (draft && key && body && !prefillUsed.current.has(key)) {
    prefillUsed.current.add(key);
    draft.values = { ...defaultValues(body), ...draft.values };
    const target = prefill?.trim() ? prefillTarget(args, draft.values) : null;
    if (target) draft.values[target] = prefill!.trim();
  }

  useEffect(() => {
    if (!isTask || personas) return;
    listParts("persona")
      .then(setPersonas)
      .catch(() => setPersonas([]));
    listParts("style")
      .then(setStyles)
      .catch(() => setStyles([]));
  }, [isTask, personas]);
  // The texts of the persona and style picked for this prompt.
  const wantParts = draft ? [draft.persona, draft.style].filter((id) => id && !id.startsWith("mine:")) : [];
  useEffect(() => {
    for (const id of wantParts) {
      if (partText[id]) continue;
      libraryGet(id)
        .then((d) => setPartText((prev) => ({ ...prev, [id]: d })))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantParts.join(",")]);

  const missing = useMemo(() => {
    if (!draft || draft.editing) return [] as string[];
    return args.filter((a) => a.required && a.default === undefined && !(draft.values[a.name] ?? "").trim()).map((a) => a.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, draft, draft?.values, draft?.editing, bumpKey(draft)]);

  const partOf = useCallback(
    (id: string, level: number): string => {
      if (!id || !core) return "";
      if (id.startsWith("mine:")) {
        const m = mine.find((x) => `mine:${x.id}` === id);
        if (!m) return "";
        if (m.kind === "style") {
          const l = m.levels && m.levels.length ? m.levels : [m.text];
          return `${t("library.prompts.styleLine", { title: m.title, level: Math.min(level, 5) })} ${l[Math.min(level, l.length) - 1] ?? ""}`.trim();
        }
        return m.text;
      }
      const d = partText[id];
      if (!d?.body) return "";
      try {
        return renderWith(core, d.body, {}, d.row.kind === "style" ? level : undefined);
      } catch {
        return d.body.body;
      }
    },
    [core, mine, partText, t],
  );

  /** The text: `marked` keeps your words and the blanks visible for the preview. */
  const textFor = useCallback(
    (marked: boolean): string => {
      if (!draft || !body || !core || !kind) return "";
      if (draft.editing) return draft.editText;
      let main = "";
      try {
        const values = marked ? markedValues(draft.values, missing) : draft.values;
        main = renderWith(core, body, values, kind === "style" ? draft.level : undefined);
      } catch {
        main = body.body;
      }
      if (selected?.type === "mine" && selected.item.kind === "style") main = partOf(`mine:${selected.item.id}`, draft.level);
      return composeText({
        persona: isTask && draft.persona ? partOf(draft.persona, 3) : null,
        body: main,
        style: isTask && draft.style ? partOf(draft.style, draft.level) : null,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, body, core, kind, missing, isTask, partOf, selected, bumpKey(draft)],
  );
  const finalText = unmark(textFor(false));

  // ── Actions ───────────────────────────────────────────────────────
  const markSeen = () => {
    try {
      localStorage.setItem("hermes.prompts.seen", "1");
    } catch {
      /* ignore */
    }
  };

  const focusField = (name: string) => {
    const field = [...(dialogRef.current?.querySelectorAll<HTMLElement>("[data-arg]") ?? [])].find((el) => el.dataset.arg === name);
    field?.querySelector<HTMLElement>("input, textarea, [role='combobox']")?.focus();
  };

  const recordUse = () => {
    if (!selected) return;
    if (selected.type === "mine") void recordMyUse(selected.item.id);
    else void libraryRecordUse(selected.hit.id).then(refreshStates, () => {});
  };

  const primary = async (send = false) => {
    if (!selected || !draft || busy) return;
    // Return pressed before the prompt's text has arrived: it runs as soon as it does.
    if (!core || !body) {
      setPending({ send });
      return;
    }
    if (missing.length > 0) {
      setTried(true);
      focusField(missing[0]);
      return;
    }
    const text = finalText;
    if (!text.trim()) return;
    if (context === "launcher") {
      const personaId = isTask && draft.persona ? draft.persona : "";
      const persona = personaId
        ? {
            id: personaId.replace(/^mine:/, ""),
            version: personaId.startsWith("mine:") ? "" : (partText[personaId]?.row.v ?? ""),
            title: personaId.startsWith("mine:") ? (mine.find((m) => `mine:${m.id}` === personaId)?.title ?? "") : (partText[personaId]?.row.title ?? ""),
            text: partOf(personaId, 3),
          }
        : null;
      const taskText = isTask && persona ? unmark(textFor(false).replace(/^<role>[\s\S]*?<\/role>\s*/, "")) : text;
      recordUse();
      drafts.delete(selected.key);
      markSeen();
      onUse?.({
        kind: (kind ?? "prompt") as PromptPick["kind"],
        id: selected.type === "mine" ? selected.item.id : selected.hit.id,
        version: selected.type === "mine" ? "" : selected.hit.version,
        title,
        text: taskText,
        mine: selected.type === "mine",
        persona,
      });
      return;
    }
    if (!delivery) {
      await copy(text);
      return;
    }
    setBusy(true);
    try {
      const result = await delivery.place(text, { title, send });
      recordUse();
      drafts.delete(selected.key);
      markSeen();
      if (result === "copied") toast?.(t("library.prompts.toastCopiedFallback"), "warning");
      else if (result === "draft") toast?.(t("library.prompts.toastDraft", { session: delivery.label }), "success");
      else if (result === "sent") toast?.(t("library.prompts.toastSent", { session: delivery.label }), "success");
      else toast?.(t("library.prompts.toastInserted", { session: delivery.label }), "success");
      onClose();
    } catch (e) {
      toast?.(t("library.prompts.toastFailed", { error: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text = finalText) => {
    try {
      await navigator.clipboard.writeText(text);
      toast?.(t("library.prompts.toastCopied"), "success");
    } catch {
      toast?.(t("library.prompts.toastCopyFailed"), "error");
    }
  };

  const togglePin = async () => {
    if (!selected) return;
    if (selected.type === "mine") {
      await setMyPinned(selected.item.id, !selected.item.pinned);
      toast?.(selected.item.pinned ? t("library.prompts.toastUnpinned", { title }) : t("library.prompts.toastPinned", { title }), "info");
      return;
    }
    const now = pinnedIds.includes(selected.hit.id);
    await librarySetItem(selected.hit.id, { pinned: !now }).catch(() => {});
    refreshStates();
    toast?.(now ? t("library.prompts.toastUnpinned", { title }) : t("library.prompts.toastPinned", { title }), "info");
  };

  const tagLabel = useCallback((tag: string) => sectionLabel(t, tag), [t]);
  const startEdit = () => {
    if (!draft || !body || !core) return;
    // Your fills stay; empty blanks stay as {{name}} and are asked for each time the copy is used.
    const keep: Record<string, string> = {};
    for (const a of args) keep[a.name] = (draft.values[a.name] ?? "").trim() || `{{${a.name}}}`;
    let main = body.body;
    try {
      main = renderWith(core, body, keep, kind === "style" ? draft.level : undefined);
    } catch {
      /* the raw body */
    }
    const text = composeText({ persona: isTask && draft.persona ? partOf(draft.persona, 3) : null, body: main, style: isTask && draft.style ? partOf(draft.style, draft.level) : null });
    draft.editing = true;
    draft.editText = selected?.type === "mine" ? selected.item.text : editableText(text, tagLabel);
    rerender();
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLTextAreaElement>(".pp-editor textarea, textarea.pp-editor")?.focus());
  };

  const startSave = () => {
    if (!selected || !draft) return;
    if (!draft.editing && selected.type !== "mine") startEdit();
    setSaving({ name: selected.type === "mine" ? selected.item.title : t("library.prompts.copyName", { title }) });
  };

  const doSave = async (asCopy: boolean) => {
    if (!selected || !draft || !saving) return;
    const name = saving.name.trim() || title;
    const text = draft.editing ? draft.editText : selected.type === "mine" ? selected.item.text : unmark(textFor(false));
    const source = selected.type === "mine" ? (selected.item.args ?? []) : args;
    const keepArgs = savedArgs(text, source);
    try {
      if (selected.type === "mine" && !asCopy) {
        await saveMyPrompt({ ...selected.item, title: name, text, args: keepArgs });
        toast?.(t("library.prompts.toastSavedChanges", { title: name }), "success");
        draft.editing = false;
      } else {
        const saved = await saveMyPrompt({
          kind: kindGroup(kind ?? "prompt") === "task" ? "prompt" : (kindGroup(kind ?? "prompt") as "persona" | "style"),
          title: name,
          description: selected.type === "hit" ? t("library.prompts.copyOf", { title }) : selected.item.description,
          text,
          args: keepArgs,
          from: selected.type === "hit" ? { id: selected.hit.id, version: selected.hit.version } : (selected.item.from ?? null),
        });
        draft.editing = false;
        setFilter("mine");
        setQuery("");
        setSelKey(`mine:${saved.id}`);
        toast?.(keepArgs.length ? t("library.prompts.toastSavedBlanks", { title: name, count: keepArgs.length }) : t("library.prompts.toastSaved", { title: name }), "success");
      }
      setSaving(null);
    } catch (e) {
      toast?.(t("library.prompts.toastFailed", { error: String(e) }), "error");
    }
  };

  const doDelete = async () => {
    if (selected?.type !== "mine") return;
    await deleteMyPrompt(selected.item.id);
    setConfirmDelete(false);
    inputRef.current?.focus();
    toast?.(t("library.prompts.toastDeleted", { title }), "info");
  };

  const newPrompt = (text: string) => {
    void saveMyPrompt({ kind: "prompt", title: text.split("\n")[0].slice(0, 60) || t("library.prompts.newTitle"), description: t("library.prompts.writtenByYou"), text, args: savedArgs(text, []) }).then((saved) => {
      setFilter("mine");
      setQuery("");
      setSelKey(`mine:${saved.id}`);
      const d = draftOf(`mine:${saved.id}`);
      d.editing = true;
      d.editText = text;
      setSaving({ name: saved.title });
    });
  };

  const focusMore = () => requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(".pp-more")?.focus());

  function escape() {
    if (saving) {
      setSaving(null);
      focusMore();
      return;
    }
    if (confirmDelete) {
      setConfirmDelete(false);
      focusMore();
      return;
    }
    const at = document.activeElement as HTMLElement | null;
    if (at && at !== inputRef.current && dialogRef.current?.contains(at) && at.matches("input, textarea, [role='combobox']")) {
      inputRef.current?.focus();
      return;
    }
    onClose();
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement;
    const inSearch = target === inputRef.current;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      escape();
      return;
    }
    if (mod && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (saving) void doSave(false);
      else void primary(e.shiftKey && !!delivery?.canSend);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (saving) void doSave(false);
      else startSave();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o" && selected?.type === "hit" && onOpenLibrary) {
      e.preventDefault();
      onOpenLibrary(selected.hit.id);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      onClose();
      return;
    }
    if (inSearch) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelKey(moveSelection(items, key, e.key === "ArrowDown" ? 1 : -1));
        resetPane();
        return;
      }
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        setSelKey(moveSelection(items, key, e.key === "PageDown" ? 10 : -10));
        resetPane();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        void primary(false);
        return;
      }
      if (e.key === "Tab" && e.shiftKey) {
        // Shift+Tab from the search goes to the filters (the one that is on).
        const chip = dialogRef.current?.querySelector<HTMLElement>('.pp-chips [aria-pressed="true"]') ?? dialogRef.current?.querySelector<HTMLElement>(".pp-chips button");
        if (chip) {
          e.preventDefault();
          chip.focus();
        }
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        const first = dialogRef.current?.querySelector<HTMLElement>(".pp-pane [data-arg] input, .pp-pane [data-arg] textarea, .pp-pane [data-arg] [role='combobox'], .pp-pane textarea");
        if (first) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
    }
    // Enter in a one-line field inserts (a multi-line field takes Enter as a new line; ⌘↵ inserts from there).
    if (e.key === "Enter" && !e.shiftKey && target.tagName === "INPUT" && target.closest("[data-arg]")) {
      e.preventDefault();
      void primary(false);
    }
  };

  const resetPane = () => {
    setPending(null);
    setTried(false);
    setSaving(null);
    setShowAll(false);
    setConfirmDelete(false);
    if (paneRef.current) paneRef.current.scrollTop = 0;
  };

  const choose = (k: string) => {
    if (k !== key) resetPane();
    setSelKey(k);
  };

  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  useEffect(() => {
    if (!pending || !core || !body) return;
    setPending(null);
    void primaryRef.current(pending.send);
  }, [pending, core, body]);

  // ── Render ────────────────────────────────────────────────────────
  const listId = `${baseId}-list`;
  const optionId = (k: string) => `${baseId}-opt-${k.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const counts: Partial<Record<PickerFilter, number>> = { mine: mine.filter((m) => context !== "launcher" || m.kind !== "style").length, pinned: pinnedIds.length + mine.filter((m) => m.pinned).length };
  const primaryLabel = context === "launcher" ? t("library.prompts.useAsTask") : delivery ? t("library.prompts.insert") : t("library.prompts.copy");
  const installed = hitId ? installs.filter((i) => i.id === hitId) : [];
  const uses = hitId ? (states.find((s) => s.itemId === hitId)?.useCount ?? 0) : 0;

  const menuEntries = [
    ...(selected ? [{ id: "pin", label: isPinned(selected, pinnedIds) ? t("library.prompts.unpin") : t("library.prompts.pin"), onSelect: () => void togglePin() }] : []),
    ...(selected ? [{ id: "save", label: selected.type === "mine" ? t("library.prompts.saveChanges") : t("library.prompts.saveToMine"), shortcut: "⌘S", onSelect: startSave }] : []),
    ...(selected && draft && !draft.editing ? [{ id: "edit", label: t("library.prompts.editText"), onSelect: startEdit }] : []),
    ...(selected ? [{ id: "copy", label: t("library.prompts.copyText"), onSelect: () => void copy() }] : []),
    ...(selected?.type === "hit" && onOpenLibrary ? [{ id: "lib", label: t("library.prompts.openInLibrary"), shortcut: "⌘O", onSelect: () => onOpenLibrary(selected.hit.id) }] : []),
    ...(selected?.type === "mine" ? [{ id: "del", label: t("library.prompts.delete"), danger: true, onSelect: () => setConfirmDelete(true) }] : []),
    { id: "sep", separator: true as const },
    { id: "new", label: t("library.prompts.newPrompt"), onSelect: () => newPrompt(query.trim()) },
    ...(onImport ? [{ id: "imp", label: t("library.prompts.import"), onSelect: onImport }] : []),
    ...(onExport ? [{ id: "exp", label: t("library.prompts.export"), onSelect: onExport, disabled: mine.length === 0 }] : []),
  ];

  const dialog = (
    <div
      ref={dialogRef}
      className={embedded ? "pp pp--embedded" : "pp"}
      role="dialog"
      aria-modal="true"
      aria-label={t("library.prompts.title")}
      data-testid="prompt-picker"
      data-context={context}
      onKeyDown={onKeyDown}
    >
      <div className="pp-search">
        {context === "launcher" ? (
          <span className="pp-crumb">
            {t("library.prompts.crumbLauncher")} <span aria-hidden="true">›</span> <b>{t("library.prompts.title")}</b>
          </span>
        ) : (
          <SearchGlyph />
        )}
        <input
          ref={inputRef}
          className="pp-input"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={key ? optionId(key) : undefined}
          aria-label={t("library.prompts.searchLabel")}
          placeholder={context === "launcher" ? t("library.prompts.placeholderLauncher") : t("library.prompts.placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelKey(null);
            resetPane();
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <kbd className="pp-esc">{t("library.prompts.kbdEsc")}</kbd>
      </div>
      <div className="pp-chips" role="group" aria-label={t("library.prompts.filtersLabel")}>
        {filtersFor(context).map((f, i) =>
          f === null ? (
            <span key={`sep-${i}`} className="pp-chip-sep" aria-hidden="true" />
          ) : (
            <Chip
              key={f}
              size="sm"
              selected={filter === f}
              onToggle={() => {
                setFilter(f === filter && f !== "all" ? "all" : f);
                setSelKey(null);
                resetPane();
              }}
              buttonAttrs={{ "data-filter": f }}
            >
              {t(`library.prompts.filter.${f}`)}
              {counts[f] !== undefined && <span className="pp-chip-count">{counts[f]}</span>}
            </Chip>
          ),
        )}
      </div>
      <div className="pp-body">
        <div
          ref={listRef}
          className="pp-list"
          data-busy={loading || undefined}
          onScroll={onListScroll}
          data-count={rows.length}
          data-rendered={range.end - range.start}
        >
          {(firstRun || notice || libState === "failed") && (
            <div className="pp-notes">
              {firstRun && (
                <div className="pp-note" role="note">
                  <span>
                    <b>{t("library.prompts.firstRunTitle")}</b> {t("library.prompts.firstRunBody")}
                  </span>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      setFirstRun(false);
                      markSeen();
                    }}
                  >
                    {t("library.prompts.gotIt")}
                  </Button>
                </div>
              )}
              {notice && (
                <div className="pp-note" role="status">
                  <span>{notice}</span>
                  <Button size="sm" variant="quiet" onClick={() => setNotice(null)}>
                    {t("library.prompts.gotIt")}
                  </Button>
                </div>
              )}
              {libState === "failed" && (
                <div className="pp-note" role="alert">
                  <span>
                    <b>{t("library.prompts.errorTitle")}</b> {t("library.prompts.errorBody")}
                  </span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setLibState("loading");
                      libraryStatus()
                        .then((s) => setLibState(s.ready ? "ready" : "failed"))
                        .catch(() => setLibState("failed"));
                    }}
                  >
                    {t("library.prompts.retry")}
                  </Button>
                </div>
              )}
            </div>
          )}
          {rows.length === 0 ? (
            loading || libState === "loading" ? (
              <Skeleton label={t("library.prompts.loading")} />
            ) : (
              <EmptyList
                filter={filter}
                query={query}
                onClear={() => setFilter("all")}
                onNew={() => newPrompt(query.trim())}
              />
            )
          ) : (
            <div id={listId} className="pp-rows" role="listbox" aria-label={t("library.prompts.resultsLabel")} style={{ height: layout.total }}>
              {windowIndexes(range, items, key).map((i) => {
                const it = items[i];
                return (
                  <ListItem
                    key={it.key}
                    item={it}
                    top={layout.offsets[i]}
                    selected={it.key === key}
                    optionId={optionId(it.key)}
                    pinned={it.type !== "group" && isPinned(it, pinnedIds)}
                    position={it.type === "group" ? 0 : rowPosition.get(it.key) ?? 0}
                    total={rows.length}
                    groupLabel={it.type !== "group" && i > 0 && items[i - 1].type === "group" ? t(`library.prompts.group.${(items[i - 1] as { group: string }).group}`) : null}
                    onChoose={choose}
                    onActivate={() => void primary(false)}
                  />
                );
              })}
            </div>
          )}
        </div>
        <div className="pp-sr" role="status">
          {loading || libState === "loading" ? "" : rows.length ? t("library.prompts.resultsCount", { count: rows.length }) : query.trim() ? t("library.prompts.noneTitle", { query: query.trim() }) : ""}
        </div>
        <div ref={paneRef} className="pp-pane" role="region" aria-label={title || t("library.prompts.paneEmptyTitle")}>
          {selected && draft ? (
            <Pane
              selected={selected}
              detail={detail}
              kind={kind}
              title={title}
              args={args}
              draft={draft}
              missing={missing}
              tried={tried}
              text={textFor(true)}
              plainText={finalText}
              showAll={showAll}
              onShowAll={() => setShowAll((x) => !x)}
              personas={personas}
              styles={styles}
              mine={mine}
              isTask={isTask}
              installed={installed}
              uses={uses}
              projectPath={projectPath ?? null}
              context={context}
              leadTitle={delivery ? title : null}
              onChange={rerender}
              onEdit={startEdit}
              onStopEdit={() => {
                draft.editing = false;
                rerender();
              }}
              onSave={startSave}
              onOpenLibrary={onOpenLibrary}
              tagLabel={tagLabel}
              focusField={focusField}
              saving={saving}
              onSavingName={(name) => setSaving({ name })}
              onSaveConfirm={(c) => void doSave(c)}
              onSaveCancel={() => {
                setSaving(null);
                focusMore();
              }}
              confirmDelete={confirmDelete}
              onDeleteConfirm={() => void doDelete()}
              onDeleteCancel={() => {
                setConfirmDelete(false);
                focusMore();
              }}
              paneRef={paneRef}
            />
          ) : (
            <div className="pp-pane-empty">
              <b>{t("library.prompts.paneEmptyTitle")}</b>
              <span>{t("library.prompts.paneEmptyBody")}</span>
            </div>
          )}
        </div>
      </div>
      <div className="pp-foot">
        <div className="pp-keys" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("library.prompts.keyMove")}
          </span>
          <span>
            <kbd>{t("library.prompts.kbdTab")}</kbd> {t("library.prompts.keyFill")}
          </span>
          {delivery?.canSend && (
            <span>
              <kbd>⌘⇧↵</kbd> {t("library.prompts.insertAndSend")}
            </span>
          )}
        </div>
        <div className="pp-acts">
          <Menu label={t("library.prompts.more")} entries={menuEntries} renderTrigger={(p) => <Button {...p} variant="quiet" className="pp-more" aria-label={t("library.prompts.more")}>⋯</Button>} />
          {delivery?.canSend && (
            <Button className="pp-send" disabled={!selected || busy} onClick={() => void primary(true)}>
              {t("library.prompts.insertAndSend")}
            </Button>
          )}
          {missing.length > 0 && <span className="pp-left">{t("library.prompts.leftToFill", { count: missing.length })}</span>}
          <Button variant="primary" className="pp-primary" disabled={!selected || busy} onClick={() => void primary(false)} iconEnd={<kbd className="pp-kbd">↵</kbd>}>
            {primaryLabel}
          </Button>
        </div>
      </div>
    </div>
  );

  if (embedded) return dialog;
  return (
    <div
      className="pp-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {dialog}
    </div>
  );
}

/** The rows to put in the DOM: the visible window, plus the chosen row wherever it is (aria-activedescendant points at it). */
function windowIndexes(range: { start: number; end: number }, items: readonly PickerItem[], key: string | null): number[] {
  const out: number[] = [];
  for (let i = range.start; i < range.end; i++) out.push(i);
  const sel = key ? items.findIndex((it) => it.key === key) : -1;
  if (sel >= 0 && (sel < range.start || sel >= range.end)) out.push(sel);
  return out;
}

/** Changes inside a draft (mutated in place) re-run the memos keyed on it. */
function bumpKey(d: Draft | null): string {
  return d ? `${JSON.stringify(d.values)}|${d.persona}|${d.style}|${d.level}|${d.editing}|${d.editText.length}` : "";
}

function isPinned(it: Pickable, pinnedIds: readonly string[]): boolean {
  return it.type === "mine" ? !!it.item.pinned : pinnedIds.includes(it.hit.id);
}

type T = (key: string, values?: Record<string, string | number>) => string;

const KNOWN_TAGS = new Set(["context", "task", "output_format", "constraints", "examples", "input", "instructions", "role", "answer_style", "rules", "steps"]);
function sectionLabel(t: T, tag: string): string {
  return KNOWN_TAGS.has(tag) ? t(`library.prompts.section.${tag}`) : humanize(tag);
}

function SearchGlyph() {
  return (
    <svg className="pp-search-glyph" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" strokeLinecap="round" />
    </svg>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="pp-skeleton" role="status" aria-label={label}>
      <div className="pp-group">{label}</div>
      {[62, 80, 55, 74, 68, 59].map((w) => (
        <div key={w} className="pp-skel-row" aria-hidden="true">
          <i className="pp-skel-icon" />
          <span>
            <i style={{ width: `${w}%` }} />
            <i style={{ width: `${Math.min(95, w + 15)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyList({ filter, query, onClear, onNew }: { filter: PickerFilter; query: string; onClear: () => void; onNew: () => void }) {
  const { t } = useI18n();
  if (filter === "mine" && !query.trim()) {
    return (
      <div className="pp-empty" data-empty="mine">
        <b>{t("library.prompts.emptyMineTitle")}</b>
        <span>{t("library.prompts.emptyMineBody")}</span>
        <Button size="sm" onClick={onNew}>
          {t("library.prompts.newPrompt")}
        </Button>
      </div>
    );
  }
  if (query.trim()) {
    return (
      <div className="pp-empty" data-empty="none">
        <b>{t("library.prompts.noneTitle", { query: query.trim() })}</b>
        {filter !== "all" ? (
          <Button size="sm" variant="link" onClick={onClear}>
            {t("library.prompts.clearFilter")}
          </Button>
        ) : (
          <span>{t("library.prompts.noneBody")}</span>
        )}
        <Button size="sm" onClick={onNew}>
          {t("library.prompts.useAsNew", { query: query.trim().slice(0, 40) })}
        </Button>
      </div>
    );
  }
  return (
    <div className="pp-empty" data-empty="nothing">
      <b>{t(`library.prompts.emptyFilter.${filter}`)}</b>
    </div>
  );
}

function ListItem({
  item,
  top,
  selected,
  optionId,
  pinned,
  position,
  total,
  groupLabel,
  onChoose,
  onActivate,
}: {
  item: PickerItem;
  top: number;
  selected: boolean;
  optionId: string;
  pinned: boolean;
  position: number;
  total: number;
  groupLabel: string | null;
  onChoose: (key: string) => void;
  onActivate: () => void;
}) {
  const { t } = useI18n();
  if (item.type === "group") {
    return (
      <div className="pp-group" aria-hidden="true" style={{ top }}>
        <span>{t(`library.prompts.group.${item.group}`)}</span>
        {item.count !== undefined && <span>{item.count}</span>}
      </div>
    );
  }
  const k = item.type === "mine" ? item.item.kind : item.hit.kind;
  const titleText = item.type === "mine" ? item.item.title : item.hit.title;
  const desc = item.type === "mine" ? item.item.description || item.item.text.slice(0, 160) : item.hit.description;
  const why = item.type === "hit" && item.personal && item.hit.reasons[0] ? reasonShort(t, item.hit.reasons[0]) : null;
  return (
    <div
      id={optionId}
      role="option"
      aria-selected={selected}
      aria-posinset={position}
      aria-setsize={total}
      aria-labelledby={`${optionId}-t ${optionId}-k`}
      aria-describedby={`${optionId}-d`}
      className="pp-row"
      data-selected={selected || undefined}
      data-key={item.key}
      data-entry={item.type === "hit" ? item.hit.id : item.item.id}
      data-kind={k}
      style={{ top }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChoose(item.key)}
      onDoubleClick={onActivate}
    >
      <KindIcon kind={k} />
      <span className="pp-row-text">
        <span className="pp-row-title" id={`${optionId}-t`}>
          {titleText}
        </span>
        <span className="pp-sr" id={`${optionId}-k`}>
          {groupLabel ? `, ${t(`library.prompts.kind.${kindGroup(k)}`)}, ${groupLabel}` : `, ${t(`library.prompts.kind.${kindGroup(k)}`)}`}
        </span>
        <span className="pp-row-desc" id={`${optionId}-d`}>
          {why && <span className="pp-row-why">{why} · </span>}
          {desc}
        </span>
      </span>
      <span className="pp-row-end">
        {item.type === "mine" && <Badge>{t("library.prompts.mine")}</Badge>}
        {pinned && <PinGlyph label={t("library.prompts.pinned")} />}
      </span>
    </div>
  );
}

function reasonShort(t: T, r: LibraryHit["reasons"][number]): string {
  switch (r.code) {
    case "used":
      return t("library.prompts.why.used", { count: r.label });
    case "stack":
      return t("library.prompts.why.stack", { label: r.label });
    case "agent":
      return t("library.prompts.why.agent", { agent: r.label });
    case "stage":
      return t("library.prompts.why.stage", { label: r.label });
    default:
      return t("library.prompts.why.fits", { label: r.label });
  }
}

function PinGlyph({ label }: { label: string }) {
  return (
    <svg className="pp-pin" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" role="img" aria-label={label}>
      <path d="M9.8 1.5 14.5 6.2l-1.4.4-2.9 2.9-.3 3.3-1.1 1.1-2.4-2.4-3.2 3.2-.7-.7 3.2-3.2-2.4-2.4 1.1-1.1 3.3-.3 2.9-2.9z" />
    </svg>
  );
}

// ── The right-hand pane ─────────────────────────────────────────────

function Pane(p: {
  selected: Pickable;
  detail: EntryDetail | null;
  kind: string | null;
  title: string;
  args: EntryArg[];
  draft: Draft;
  missing: string[];
  tried: boolean;
  text: string;
  plainText: string;
  showAll: boolean;
  onShowAll: () => void;
  personas: PartItem[] | null;
  styles: PartItem[] | null;
  mine: MyPrompt[];
  isTask: boolean;
  installed: { id: string; target: string }[];
  uses: number;
  projectPath: string | null;
  context: PickerContext;
  leadTitle: string | null;
  onChange: () => void;
  onEdit: () => void;
  onStopEdit: () => void;
  onSave: () => void;
  onOpenLibrary?: (id: string | null, install?: boolean) => void;
  tagLabel: (tag: string) => string;
  focusField: (name: string) => void;
  saving: { name: string } | null;
  onSavingName: (name: string) => void;
  onSaveConfirm: (asCopy: boolean) => void;
  onSaveCancel: () => void;
  confirmDelete: boolean;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  paneRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const { selected, draft, args, missing } = p;
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = p.paneRef.current;
    if (!el) return;
    const on = () => setStuck(el.scrollTop > 4);
    on();
    el.addEventListener("scroll", on);
    return () => el.removeEventListener("scroll", on);
  }, [p.paneRef]);
  const fillId = useId();
  const isMine = selected.type === "mine";
  const hit = selected.type === "hit" ? selected.hit : null;
  const k = p.kind ?? "prompt";
  const gives = outputSections(p.detail);
  const loadingBody = !isMine && !p.detail;
  const steps = p.detail?.body?.steps ?? [];

  return (
    <div className="pp-pane-inner" data-entry={selected.type === "hit" ? selected.hit.id : selected.item.id} data-kind={k}>
      <header className="pp-head" data-stuck={stuck || undefined}>
        <div className="pp-meta">
          {isMine ? (
            <>
              <Badge>{t("library.prompts.mine")}</Badge>
              {selected.item.folder && <span>{selected.item.folder}</span>}
            </>
          ) : (
            <>
              <span className="pp-kind-name" data-kind={kindGroup(k as never)}>
                {t(`library.prompts.kind.${kindGroup(k as never)}`)}
                {k === "workflow" ? ` · ${t("library.prompts.inSteps")}` : ""}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {hit?.domainLabel} · {hit?.categoryLabel}
              </span>
            </>
          )}
        </div>
        <h3 className="pp-title">{p.title}</h3>
        <p className="pp-desc">{isMine ? selected.item.description : hit?.description}</p>
        {gives.length > 0 && <p className="pp-gives">{t("library.prompts.gives", { list: gives.join(", ") })}</p>}
      </header>
      <div className="pp-pane-body">
        {loadingBody && <p className="pp-muted">{t("library.prompts.loadingEntry")}</p>}
        {args.length > 0 && !draft.editing && (
          <section className="pp-sec" aria-labelledby={fillId}>
            <h4 id={fillId}>
              {t("library.prompts.fillIn")}
              <span className="pp-hint">
                {args.some((a) => a.required && a.default === undefined)
                  ? missing.length
                    ? t("library.prompts.requiredLeft", { count: missing.length })
                    : t("library.prompts.allSet")
                  : t("library.prompts.allOptional")}
              </span>
            </h4>
            {args.map((a) => (
              <ArgField key={a.name} arg={a} draft={draft} invalid={p.tried && missing.includes(a.name)} onChange={p.onChange} />
            ))}
          </section>
        )}
        {k === "workflow" && steps.length > 0 && !draft.editing && (
          <section className="pp-sec">
            <h4>{t("library.prompts.steps")}</h4>
            <ol className="pp-steps">
              {steps.map((s) => (
                <li key={s.id}>{humanize(s.id)}</li>
              ))}
            </ol>
          </section>
        )}
        {p.isTask && !draft.editing && (
          <Modifiers draft={draft} detail={p.detail} personas={p.personas} styles={p.styles} mine={p.mine} onChange={p.onChange} launcher={p.context === "launcher"} />
        )}
        {k === "style" && !draft.editing && <LevelField draft={draft} onChange={p.onChange} />}
        {draft.editing ? (
          <section className="pp-sec">
            <h4>
              {t("library.prompts.yourCopy")}
              <span className="pp-hint">{t("library.prompts.yourCopyHint")}</span>
            </h4>
            <Textarea
              className="pp-editor"
              aria-label={t("library.prompts.yourCopy")}
              value={draft.editText}
              onChange={(e) => {
                draft.editText = e.target.value;
                p.onChange();
              }}
              rows={12}
            />
            <div className="pp-row-actions">
              <Button size="sm" onClick={p.onSave}>
                {isMine ? t("library.prompts.saveChanges") : t("library.prompts.saveToMine")}
              </Button>
              {!isMine && (
                <Button size="sm" variant="quiet" onClick={p.onStopEdit}>
                  {t("library.prompts.backToOriginal")}
                </Button>
              )}
              {isMine && (
                <Button size="sm" variant="quiet" onClick={p.onStopEdit}>
                  {t("library.prompts.doneEditing")}
                </Button>
              )}
            </div>
          </section>
        ) : (
          <Receives text={p.text} plain={p.plainText} showAll={p.showAll} onShowAll={p.onShowAll} onEdit={p.onEdit} tagLabel={p.tagLabel} focusField={p.focusField} leadTitle={p.leadTitle} blanks={missing.length} />
        )}
        {hit && p.projectPath && (
          <UseWithoutHermes hit={hit} installed={p.installed} uses={p.uses} onAdd={() => p.onOpenLibrary?.(hit.id, true)} canAdd={!!p.onOpenLibrary} />
        )}
        {p.saving && (
          <div className="pp-savebar" role="group" aria-label={t("library.prompts.saveToMine")}>
            <Input
              aria-label={t("library.prompts.name")}
              value={p.saving.name}
              autoFocus
              onChange={(e) => p.onSavingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  p.onSaveConfirm(false);
                }
              }}
            />
            <Button variant="primary" size="sm" onClick={() => p.onSaveConfirm(false)}>
              {isMine ? t("library.prompts.save") : t("library.prompts.saveToMine")}
            </Button>
            {isMine && (
              <Button size="sm" onClick={() => p.onSaveConfirm(true)}>
                {t("library.prompts.saveCopy")}
              </Button>
            )}
            <Button size="sm" variant="quiet" onClick={p.onSaveCancel}>
              {t("library.cancel")}
            </Button>
          </div>
        )}
        {p.confirmDelete && (
          <div className="pp-savebar" role="alertdialog" aria-label={t("library.prompts.delete")}>
            <span>{t("library.prompts.deleteConfirm", { title: p.title })}</span>
            <Button variant="danger" size="sm" onClick={p.onDeleteConfirm} autoFocus>
              {t("library.prompts.deleteYes")}
            </Button>
            <Button size="sm" variant="quiet" onClick={p.onDeleteCancel}>
              {t("library.cancel")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function outputSections(detail: EntryDetail | null): string[] {
  const oc = detail?.body?.fm.output_contract as { sections?: unknown } | undefined;
  return Array.isArray(oc?.sections) ? oc.sections.map(String).map((s, i) => (i === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1))) : [];
}

function ArgField({ arg, draft, invalid, onChange }: { arg: EntryArg; draft: Draft; invalid: boolean; onChange: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const req = !!arg.required && arg.default === undefined;
  const value = draft.values[arg.name] ?? "";
  const set = (v: string) => {
    draft.values = { ...draft.values, [arg.name]: v };
    onChange();
  };
  const describedBy = [invalid && `${id}-need`, arg.description && `${id}-help`].filter(Boolean).join(" ") || undefined;
  const labelId = `${id}-label`;
  let control: ReactNode;
  if (arg.type === "enum" && Array.isArray(arg.enum)) {
    const options: SelectOption[] = arg.enum.map((o) => ({ value: String(o), label: String(o) }));
    control = <Select id={id} options={options} value={value || null} onChange={set} placeholder={t("library.prompts.choose")} invalid={invalid} aria-labelledby={labelId} aria-describedby={describedBy} />;
  } else if (arg.type === "boolean") {
    const options: SelectOption[] = [
      { value: "true", label: t("library.prompts.yes") },
      { value: "false", label: t("library.prompts.no") },
    ];
    control = <Select id={id} options={options} value={value || null} onChange={set} placeholder={t("library.prompts.choose")} invalid={invalid} aria-labelledby={labelId} aria-describedby={describedBy} />;
  } else if (arg.type === "text") {
    control = <Textarea id={id} rows={2} value={value} onChange={(e) => set(e.target.value)} invalid={invalid} aria-describedby={describedBy} aria-required={req} />;
  } else {
    control = <Input id={id} value={value} onChange={(e) => set(e.target.value)} invalid={invalid} aria-describedby={describedBy} aria-required={req} inputMode={arg.type === "number" ? "numeric" : undefined} />;
  }
  return (
    <div className="pp-field" data-arg={arg.name} data-invalid={invalid || undefined}>
      <label id={labelId} htmlFor={id}>
        {humanize(arg.name)} <small>{req ? t("library.prompts.required") : t("library.prompts.optional")}</small>
      </label>
      {control}
      {invalid && (
        <span className="pp-need" id={`${id}-need`}>
          {t("library.prompts.needed")}
        </span>
      )}
      {arg.description && (
        <span className="pp-help" id={`${id}-help`}>
          {arg.description}
        </span>
      )}
    </div>
  );
}

function Modifiers({
  draft,
  detail,
  personas,
  styles,
  mine,
  onChange,
  launcher,
}: {
  draft: Draft;
  detail: EntryDetail | null;
  personas: PartItem[] | null;
  styles: PartItem[] | null;
  mine: MyPrompt[];
  onChange: () => void;
  launcher: boolean;
}) {
  const { t } = useI18n();
  const pid = useId();
  const sid = useId();
  const lid = useId();
  const pairs = (detail?.body?.fm.pairs_with as { personas?: unknown } | undefined)?.personas;
  const suggested = Array.isArray(pairs) ? pairs.map(String) : [];
  const personaOptions: SelectOption[] = useMemo(() => {
    const all = personas ?? [];
    const sug = suggested.map((id) => all.find((x) => x.id === id)).filter((x): x is PartItem => !!x);
    return [
      { value: "", label: t("library.prompts.none") },
      ...sug.map((x) => ({ value: x.id, label: x.title, detail: t("library.prompts.suggested") })),
      ...mine.filter((m) => m.kind === "persona").map((m) => ({ value: `mine:${m.id}`, label: m.title, detail: t("library.prompts.mine") })),
      ...all.filter((x) => !suggested.includes(x.id)).map((x) => ({ value: x.id, label: x.title })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personas, mine, suggested.join(","), t]);
  const styleOptions: SelectOption[] = useMemo(
    () => [
      { value: "", label: t("library.prompts.defaultStyle") },
      ...mine.filter((m) => m.kind === "style").map((m) => ({ value: `mine:${m.id}`, label: m.title, detail: t("library.prompts.mine") })),
      ...(styles ?? []).map((x) => ({ value: x.id, label: x.title })),
    ],
    [styles, mine, t],
  );
  return (
    <section className="pp-sec">
      <h4>
        {launcher ? t("library.prompts.personaOnly") : t("library.prompts.modifiers")}
        <span className="pp-hint">{t("library.prompts.optionalHint")}</span>
      </h4>
      <div className="pp-mods">
        <div className="pp-field">
          <label id={`${pid}-label`} htmlFor={pid}>
            {t("library.prompts.actAs")}
          </label>
          <Select
            id={pid}
            aria-labelledby={`${pid}-label`}
            options={personaOptions}
            value={draft.persona}
            onChange={(v) => {
              draft.persona = v;
              onChange();
            }}
            aria-describedby={`${pid}-help`}
          />
          <span className="pp-help" id={`${pid}-help`}>
            {suggested.length ? t("library.prompts.actAsHintSuggested") : t("library.prompts.actAsHint")}
          </span>
        </div>
        {!launcher && (
          <div className="pp-field">
            <label id={`${sid}-label`} htmlFor={sid}>
              {t("library.prompts.answerStyle")}
            </label>
            <Select
              id={sid}
              aria-labelledby={`${sid}-label`}
              options={styleOptions}
              value={draft.style}
              onChange={(v) => {
                draft.style = v;
                onChange();
              }}
              aria-describedby={`${sid}-help`}
            />
            <span className="pp-help" id={`${sid}-help`}>
              {t("library.prompts.answerStyleHint")}
            </span>
          </div>
        )}
        {!launcher && draft.style && (
          <div className="pp-field">
            <label id={`${lid}-label`} htmlFor={lid}>
              {t("library.prompts.strength")}
            </label>
            <Select id={lid} aria-labelledby={`${lid}-label`} options={levelOptions(t)} value={String(draft.level)} onChange={(v) => { draft.level = Number(v); onChange(); }} />
          </div>
        )}
      </div>
    </section>
  );
}

function levelOptions(t: T): SelectOption[] {
  return [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: t("library.prompts.level", { n }), detail: n === 1 ? t("library.prompts.lightest") : n === 5 ? t("library.prompts.strongest") : undefined }));
}

function LevelField({ draft, onChange }: { draft: Draft; onChange: () => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <section className="pp-sec">
      <div className="pp-field pp-field--narrow">
        <label id={`${id}-label`} htmlFor={id}>
          {t("library.prompts.strength")}
        </label>
        <Select id={id} aria-labelledby={`${id}-label`} options={levelOptions(t)} value={String(draft.level)} onChange={(v) => { draft.level = Number(v); onChange(); }} />
      </div>
    </section>
  );
}

function Receives({
  text,
  plain,
  showAll,
  onShowAll,
  onEdit,
  tagLabel,
  focusField,
  leadTitle,
  blanks,
}: {
  text: string;
  plain: string;
  showAll: boolean;
  onShowAll: () => void;
  onEdit: () => void;
  tagLabel: (tag: string) => string;
  focusField: (name: string) => void;
  leadTitle: string | null;
  blanks: number;
}) {
  const { t } = useI18n();
  const recvId = useId();
  const sections = useMemo(() => readableSections(text), [text]);
  const folds = plain.length > 800 || plain.split("\n").length > 3;
  return (
    <section className="pp-sec" aria-labelledby={recvId}>
      <h4 id={recvId}>
        {t("library.prompts.receives")}
        <span className="pp-hint">{blanks ? t("library.prompts.receivesBlanks") : t("library.prompts.receivesYours")}</span>
      </h4>
      <div className="pp-recv" data-open={showAll || undefined}>
        <div className="pp-recv-body" data-testid="prompt-receives">
          {leadTitle && folds && <p className="pp-lead" data-lead>{t("library.prompts.leadNote", { line: t("library.prompts.leadLine", { title: leadTitle }) })}</p>}
          {sections.map((s, i) => (
            <div key={i} className="pp-rs" data-plain={s.tag ? undefined : true}>
              {s.tag && <b>{tagLabel(s.tag)}</b>}
              <div>
                {s.blocks.map((b, j) => (
                  <BlockView key={j} block={b} focusField={focusField} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="pp-recv-foot">
          <Button size="sm" variant="link" onClick={onShowAll} aria-expanded={showAll}>
            {showAll ? t("library.prompts.showLess") : t("library.prompts.showAll")}
          </Button>
          <Button size="sm" variant="link" onClick={onEdit}>
            {t("library.prompts.editText")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function BlockView({ block, focusField }: { block: Block; focusField: (name: string) => void }) {
  if (!("items" in block)) return block.kind === "h" ? <h5>{renderInline(block.parts, focusField)}</h5> : <p>{renderInline(block.parts, focusField)}</p>;
  const items = block.items.map((it, i) => <li key={i}>{renderInline(it, focusField)}</li>);
  return block.kind === "ol" ? <ol>{items}</ol> : <ul>{items}</ul>;
}

function renderInline(parts: Inline[], focusField: (name: string) => void): ReactNode[] {
  return parts.map((p, i) => {
    switch (p.t) {
      case "code":
        return <code key={i}>{p.v}</code>;
      case "bold":
        return <b key={i}>{p.v}</b>;
      case "filled":
        return (
          <mark key={i} className="pp-filled">
            {p.v}
          </mark>
        );
      case "blank":
        // The field itself is the keyboard way in (Tab); a click on the slot is a shortcut to it.
        return (
          <mark key={i} className="pp-blank" data-slot={p.v} onClick={() => focusField(p.v)}>
            {humanize(p.v)}
          </mark>
        );
      default:
        return <span key={i}>{p.v}</span>;
    }
  });
}

function UseWithoutHermes({ hit, installed, uses, onAdd, canAdd }: { hit: LibraryHit; installed: { id: string; target: string }[]; uses: number; onAdd: () => void; canAdd: boolean }) {
  const { t } = useI18n();
  const here = installed.map((i) => {
    const agent = agentsForTarget(i.target)[0];
    return { name: agent ? agentName(agent) : i.target, call: agent ? invocation(agent, hit.id, hit.kind) : null };
  });
  return (
    <section className="pp-sec" data-testid="prompt-use-without">
      <h4>{t("library.prompts.useWithout")}</h4>
      {uses >= 3 && here.length === 0 ? (
        <div className="pp-nudge">
          <span>{t("library.prompts.nudge", { count: uses })}</span>
          {canAdd && (
            <Button size="sm" onClick={onAdd}>
              {t("library.prompts.addCommand")}
            </Button>
          )}
        </div>
      ) : (
        <div className="pp-proj">
          {here.length > 0 ? (
            here.map((h) => (
              <span key={h.name} className="pp-proj-item">
                <span className="pp-ok" aria-hidden="true">
                  ✓
                </span>{" "}
                {h.name} {h.call && <code>{h.call}</code>}
              </span>
            ))
          ) : (
            <span>{t("library.prompts.notCommand")}</span>
          )}
          {canAdd && (
            <Button size="sm" variant="link" onClick={onAdd}>
              {t("library.prompts.addCommand")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
