// ─── The Library (Hodios inside Hermes) ───────────────────────────────
//
// Loaded on demand: nothing of it is startup code. The first open imports
// the catalog bundled with the app (offline). The first screen asks "What
// do you want to do?" over the Essentials (the front doors), what was used
// last and a few shelves of what fits this person and why; search covers
// every entry, a plain need ("trip") leads with its front door and the
// words it did not use ("Lisbon") become that front door's answers; an
// open entry can be used in any session, started as a task with any
// agent, or installed into the project for an agent.

import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button, Chip, CloseButton, Segmented } from "../ui";
import { HEALTH_ADVICE, depthSections, fillFromLeftover, isDeveloperRole, pairsWith, recentIds, usesFacets } from "../../library/everyday";
import { argsOf } from "../../library/render";
import { useI18n } from "../../i18n/I18nProvider";
import { useLibraryMessages } from "../../library/messages";
import { useSession, useSessionList } from "../../state/SessionContext";
import { ensureDoctor, useAgentDoctor } from "../../launcher/doctorStore";
import { getSetting, setSetting } from "../../api/settings";
import { focusTerminal } from "../../terminal/TerminalPool";
import { useToastStore } from "../../hooks/useToastStore";
import { getTrackState } from "../../track/store";
import {
  LIBRARY_UPDATED_EVENT,
  libraryGet,
  libraryHits,
  libraryInstalls,
  libraryItemStates,
  libraryRecordOpen,
  libraryRecordUse,
  libraryResolve,
  librarySearch,
  librarySetItem,
  libraryShelves,
  libraryStatus,
} from "../../library/api";
import { filterLegacy, loadClassics, loadMine, visibleClassics, warnMissingAlias, type LegacyItem } from "../../library/legacy";
import { placeInSession, sessionDeps } from "../../library/placeInSession";
import { setLauncherSeed } from "../../library/launcherSeed";
import { OPEN_LIBRARY_EVENT, takeLibraryFocus } from "../../library/libraryFocus";
import { agentName, worksTarget } from "../../library/targets";
import type { EntryDetail, ItemState, LibraryContext, LibraryHit, LibraryStatus, SearchPage, Shelf, Shelves } from "../../library/types";
import { LibraryAsk } from "./LibraryAsk";
import { LibraryDetail, type SessionChoice } from "./LibraryDetail";
import { LibraryHome } from "./LibraryHome";
import { LibraryInstall } from "./LibraryInstall";
import { LibraryInterests } from "./LibraryInterests";
import { LibraryResults, type ResultItem } from "./LibraryResults";
import { LibraryUpdateBadge, LibraryUpdatePanel } from "./LibraryUpdate";

const KINDS = ["prompt", "persona", "workflow", "rule", "style"] as const;
const SEARCH_DEBOUNCE_MS = 80;

/** Feature Track phase -> hodios stage. */
const PHASE_STAGE: Record<string, string> = {
  questions: "discover",
  research: "discover",
  design: "design",
  structure: "design",
  plan: "plan",
  implement: "build",
};

type Nav = "home" | "recent" | "pinned" | "installed" | "mine" | "classics" | "hidden" | `domain:${string}`;

type Selection = { type: "hit"; id: string; reasons: LibraryHit["reasons"] } | { type: "legacy"; item: LegacyItem } | null;

export function LibraryView({ onClose, onStartTask }: { onClose: () => void; onStartTask: () => void }) {
  const ready = useLibraryMessages();
  const { t } = useI18n();
  const { state, dispatch, setActive } = useSession();
  const sessions = useSessionList();
  const doctor = useAgentDoctor();
  const toasts = useToastStore();
  const active = state.activeSessionId ? state.sessions[state.activeSessionId] : null;

  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [shelves, setShelves] = useState<Shelves | null>(null);
  const [showEverything, setShowEverything] = useState(false);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [domain, setDomain] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [intent, setIntent] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [depths, setDepths] = useState<Set<string>>(new Set());
  const [health, setHealth] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [worksAuto, setWorksAuto] = useState(true);
  const [stackAuto, setStackAuto] = useState(false);
  const [sort, setSort] = useState<"you" | "best" | "new">("you");
  const [nav, setNav] = useState<Nav>("home");
  const [page, setPage] = useState<SearchPage | null>(null);
  const [hits, setHits] = useState<LibraryHit[]>([]);
  const [listHits, setListHits] = useState<LibraryHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  // The query the shown results answer (a late answer to an older one is dropped).
  const [answered, setAnswered] = useState<string | null>(null);
  const [classics, setClassics] = useState<LegacyItem[]>([]);
  const [mine, setMine] = useState<LegacyItem[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [itemStates, setItemStates] = useState<ItemState[]>([]);
  const [installing, setInstalling] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [interestsOpen, setInterestsOpen] = useState(false);
  const [interestsOffered, setInterestsOffered] = useState(true);
  // The facet hint is for developers: a developer role, or the query language used once.
  const [facetsUsed, setFacetsUsed] = useState(false);
  const searchSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The routed front door was selected for the person (not opened by them).
  const autoSelected = useRef<string | null>(null);

  // ── What this moment is (computed here, never sent) ────────────────
  useEffect(() => ensureDoctor(), []);
  // Keyed by content: a new doctor answer with the same agents changes nothing below.
  const installedKey = (doctor.rows ?? [])
    .filter((r) => r.installed && !r.broken && r.id !== "custom")
    .map((r) => r.id)
    .join(",");
  const installedAgentIds = useMemo(() => (installedKey ? installedKey.split(",") : []), [installedKey]);
  const installedTargets = useMemo(() => new Set(installedAgentIds.map(worksTarget)), [installedAgentIds]);
  const projectPath = active?.working_directory || null;
  const projectName = projectPath ? (projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath) : null;
  const activeAgent = active?.ai_provider ?? null;
  const stage = useMemo(() => {
    if (!projectPath) return null;
    const track = getTrackState(projectPath);
    const f = track.features.find((x) => x.slug === track.slug) ?? null;
    return f?.meta ? (PHASE_STAGE[f.meta.phase] ?? null) : null;
  }, [projectPath]);
  const context: LibraryContext = useMemo(
    () => ({
      projectPath,
      works: [...installedTargets],
      activeWork: activeAgent ? worksTarget(activeAgent) : null,
      stage,
      showEverything,
    }),
    [projectPath, installedTargets, activeAgent, stage, showEverything],
  );

  // ── Status, shelves, user state ─────────────────────────────────────
  const refreshStatus = useCallback(() => {
    libraryStatus()
      .then(setStatus)
      .catch((e) => console.warn("[library] status:", e));
  }, []);
  const refreshStates = useCallback(() => {
    libraryItemStates()
      .then(setItemStates)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshStatus();
    refreshStates();
    getSetting("library_onboarded")
      .then((v) => setInterestsOffered(v === "true"))
      .catch(() => {});
    getSetting("library_facets_used")
      .then((v) => setFacetsUsed(v === "true"))
      .catch(() => {});
  }, [refreshStatus, refreshStates]);
  useEffect(() => {
    if (facetsUsed || !usesFacets(query)) return;
    setFacetsUsed(true);
    void setSetting("library_facets_used", "true").catch(() => {});
  }, [query, facetsUsed]);

  const loadShelves = useCallback(() => {
    libraryShelves(context)
      .then(setShelves)
      .catch((e) => console.warn("[library] shelves:", e));
  }, [context]);
  useEffect(() => {
    if (status?.ready) loadShelves();
  }, [status?.ready, loadShelves]);

  useEffect(() => {
    let off: (() => void) | null = null;
    let live = true;
    listen(LIBRARY_UPDATED_EVENT, () => {
      if (!live) return;
      setFresh(true);
      refreshStatus();
      loadShelves();
    }).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, [refreshStatus, loadShelves]);

  useEffect(() => {
    let live = true;
    Promise.all([loadClassics(), loadMine()])
      .then(async ([c, m]) => {
        const replaced = await libraryResolve(c.map((x) => x.id)).catch(() => ({}));
        if (!live) return;
        const shown = visibleClassics(c, replaced);
        for (const x of shown) warnMissingAlias(x.id, x.source);
        setClassics(shown);
        setMine(m);
      })
      .catch((e) => console.warn("[library] classics:", e));
    // A 2.0 pin on a built-in template becomes a pin on its library entry.
    import("../../library/parts")
      .then((m) => m.carryLegacyPins())
      .then(() => live && refreshStates())
      .catch((e) => console.warn("[library] carrying 2.0 pins:", e));
    return () => {
      live = false;
    };
  }, [refreshStates]);

  const pinned = useMemo(() => new Set(itemStates.filter((s) => s.pinned).map((s) => s.itemId)), [itemStates]);
  const recent = useMemo(() => recentIds(itemStates), [itemStates]);
  const hidden = useMemo(() => new Set(itemStates.filter((s) => s.hidden).map((s) => s.itemId)), [itemStates]);

  // ── Search ──────────────────────────────────────────────────────────
  const chosen = kinds.size > 0 || domain !== null || category !== null || intent !== null || topic !== null || depths.size > 0 || health || stackAuto;
  const searching_ = nav !== "home" || query.trim() !== "" || chosen;
  // Clearing the search brings the home view back; it is heavy, so it renders in the background
  // and a new search interrupts it (on a slow machine the next results waited a second behind it).
  const showSearchLagging = useDeferredValue(searching_);
  const filters = useMemo(() => {
    const f: Record<string, string[]> = {};
    if (kinds.size > 0) f.kind = [...kinds];
    if (domain) f.domain = [domain];
    if (category) f.cat = [category];
    if (intent) f.intent = [intent];
    if (topic) f.topic = [topic];
    if (depths.size > 0) f.depth = [...depths];
    if (health) f.adv = HEALTH_ADVICE;
    if (worksAuto && activeAgent && query.trim()) f.works = [worksTarget(activeAgent)];
    if (stackAuto && shelves?.stack.length) f.stack = shelves.stack.map((s) => s.value);
    return f;
  }, [kinds, domain, category, intent, topic, depths, health, worksAuto, activeAgent, stackAuto, shelves?.stack, query]);

  const runSearch = useCallback(
    async (cursor: string | null) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      // Test builds only: a log of every search the page sends (the latency scenario prints it when slow).
      const trace = import.meta.env.VITE_HERMES_E2E === "1"
        ? (((window as unknown as { __libSearchLog?: unknown[] }).__libSearchLog ??= []) as unknown[])
        : null;
      const t0 = performance.now();
      try {
        const res = await librarySearch(
          { query, filters, cursor, limit: 50, sort, personalise: !showEverything, includeHidden: nav === "hidden", counts: !cursor },
          context,
        );
        trace?.push({ seq, query, t0: Math.round(t0), ms: Math.round(performance.now() - t0), stale: seq !== searchSeq.current, works: context?.works?.length ?? null });
        if (seq !== searchSeq.current) return; // a newer search answered
        setAnswered(query);
        setPage((p) => (cursor && p ? { ...res, total: p.total, totalCapped: p.totalCapped, kindCounts: p.kindCounts } : res));
        setHits((h) => (cursor ? [...h, ...res.hits.filter((x) => !h.some((y) => y.id === x.id))] : res.hits));
      } catch (e) {
        if (seq === searchSeq.current) console.warn("[library] search:", e);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [query, filters, sort, showEverything, nav, context],
  );

  useEffect(() => {
    if (!status?.ready || !searching_ || nav === "recent" || nav === "pinned" || nav === "installed" || nav === "mine" || nav === "classics") return;
    const timer = setTimeout(() => void runSearch(null), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [status?.ready, searching_, nav, runSearch]);

  // Lists by id: recent, pinned, installed in this project.
  useEffect(() => {
    if (nav !== "recent" && nav !== "pinned" && nav !== "installed") {
      setListHits(null);
      return;
    }
    let live = true;
    const ids = async () => {
      if (nav === "recent") return recent;
      if (nav === "pinned") return [...pinned];
      const inst = await libraryInstalls(projectPath);
      return [...new Set(inst.lock.entries.map((e) => e.id))];
    };
    ids()
      .then((list) => libraryHits(list, context))
      .then((h) => live && setListHits(h))
      .catch(() => live && setListHits([]));
    return () => {
      live = false;
    };
  }, [nav, pinned, recent, projectPath, context]);

  const levels = useMemo(() => shelves?.depths ?? [], [shelves?.depths]);
  const route = !listHits && answered === query ? (page?.route ?? null) : null;
  const leftover = useMemo(() => (answered === query ? (page?.leftover ?? []) : []), [answered, query, page?.leftover]);
  const items: ResultItem[] = useMemo(() => {
    const out: ResultItem[] = [];
    const libHits = listHits ?? (nav === "mine" || nav === "classics" ? [] : hits);
    if (libHits.length > 0 && !listHits && levels.length > 0) {
      // Depth sections in the catalog's order, basic ("Start here") first.
      for (const sec of depthSections(libHits, levels)) {
        const id = sec.level?.id ?? "";
        const open = !folded.has(id);
        const n = page?.depthCounts?.[id];
        const count = n === undefined ? String(sec.hits.length) : n > 1000 ? "1000+" : String(n);
        out.push({ type: "header", key: `h:depth:${id}`, label: sec.level?.label ?? id, count, section: id, open });
        if (open) for (const h of sec.hits) out.push({ type: "hit", key: `hit:${h.id}`, hit: h });
      }
    } else if (libHits.length > 0) {
      out.push({ type: "header", key: "h:lib", label: t("library.results.groupLibrary"), count: String(libHits.length) });
      for (const h of libHits) out.push({ type: "hit", key: `hit:${h.id}`, hit: h });
    }
    const withLegacy = nav === "mine" || nav === "classics" || (nav !== "recent" && nav !== "pinned" && nav !== "installed" && nav !== "hidden" && !chosen);
    if (withLegacy) {
      const q = query.trim();
      const cls = nav === "mine" ? [] : q || nav === "classics" ? filterLegacy(classics, q) : [];
      const own = nav === "classics" ? [] : q || nav === "mine" ? filterLegacy(mine, q) : [];
      if (cls.length > 0) {
        out.push({ type: "header", key: "h:classics", label: t("library.results.groupClassics"), count: String(cls.length) });
        for (const c of cls) out.push({ type: "legacy", key: c.key, item: c });
      }
      if (own.length > 0) {
        out.push({ type: "header", key: "h:mine", label: t("library.results.groupMine"), count: String(own.length) });
        for (const m of own) out.push({ type: "legacy", key: m.key, item: m });
      }
    }
    return out;
  }, [hits, listHits, nav, classics, mine, query, chosen, levels, folded, page?.depthCounts, t]);

  // ── Selection and detail ────────────────────────────────────────────
  // Opened by the person: it goes to Recent (not a use).
  const openId = useCallback(
    (id: string, reasons: LibraryHit["reasons"] = []) => {
      autoSelected.current = null;
      setSelection({ type: "hit", id, reasons });
      void libraryRecordOpen(id)
        .then(refreshStates)
        .catch(() => {});
    },
    [refreshStates],
  );
  // A plain need's front door is shown beside its results, as the mock of
  // "trip" does; the person's own choice is never replaced.
  const lead = route ? (route.exact ?? route.to) : null;
  useEffect(() => {
    if (!lead) return;
    const mineSelected = selection && !(selection.type === "hit" && selection.id === autoSelected.current);
    if (mineSelected || (selection?.type === "hit" && selection.id === lead.id)) return;
    autoSelected.current = lead.id;
    // In the background: the answer shows first, the front door's details follow.
    startTransition(() => setSelection({ type: "hit", id: lead.id, reasons: lead.reasons }));
  }, [lead, selection]);
  // The best match's questions take the words the search left over.
  const answers = useMemo(() => {
    if (!detail || !lead || detail.id !== lead.id || leftover.length === 0) return null;
    return fillFromLeftover(argsOf(detail.body), leftover);
  }, [detail, lead, leftover]);
  // "Leads to": the entry's pairs_with, or the routed need's specialists.
  const [leads, setLeads] = useState<LibraryHit[]>([]);
  useEffect(() => {
    const ids = pairsWith(detail?.body?.fm.pairs_with);
    if (ids.length === 0) {
      setLeads(route && detail?.id === route.to.id ? route.refine : []);
      return;
    }
    let live = true;
    libraryHits(ids.slice(0, 8), context)
      .then((list) => live && setLeads(list))
      .catch(() => live && setLeads([]));
    return () => {
      live = false;
    };
  }, [detail, route, context]);
  // "Open in Library" from Prompts: show that entry (with "Add as a command" open when asked).
  useEffect(() => {
    const apply = () => {
      const f = takeLibraryFocus();
      if (!f?.id) return;
      setSelection({ type: "hit", id: f.id, reasons: [] });
      if (f.install) setInstalling(true);
    };
    apply();
    window.addEventListener(OPEN_LIBRARY_EVENT, apply);
    return () => window.removeEventListener(OPEN_LIBRARY_EVENT, apply);
  }, []);
  useEffect(() => {
    if (selection?.type !== "hit") {
      setDetail(null);
      return;
    }
    let live = true;
    setDetail(null);
    libraryGet(selection.id)
      .then((d) => live && setDetail(d))
      .catch((e) => console.warn("[library] get:", e));
    return () => {
      live = false;
    };
  }, [selection]);

  const selectedKey = selection ? (selection.type === "hit" ? `hit:${selection.id}` : selection.item.key) : null;

  const sessionChoices: SessionChoice[] = useMemo(
    () =>
      sessions
        .filter((s) => s.phase !== "destroyed")
        .map((s) => ({ id: s.id, label: s.label, mode: s.mode === "agent" ? "agent" : "terminal", agentId: s.ai_provider ?? null })),
    [sessions],
  );

  // ── Actions ─────────────────────────────────────────────────────────
  const toast = useCallback(
    (message: string, type: "info" | "success" | "warning" | "error" = "success") => toasts.addToast({ message, type, duration: 6000 }),
    [toasts],
  );
  const selectedTitle = selection?.type === "legacy" ? selection.item.title : (detail?.row.title ?? "");
  const selectedLibId = selection?.type === "hit" ? (detail?.id ?? selection.id) : null;

  const actions = {
    use: (text: string, sessionId: string) => {
      const s = state.sessions[sessionId];
      if (!s) return;
      const mode = s.mode === "agent" ? "agent" : "terminal";
      void placeInSession(
        { id: sessionId, mode, draft: state.composers[sessionId]?.draft ?? "" },
        text,
        sessionDeps((id, draft) => dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: id, draft })),
      )
        .then((result) => {
          if (selectedLibId) void libraryRecordUse(selectedLibId).then(refreshStates);
          if (result === "copied") {
            toast(t("library.toast.copiedInstead", { session: s.label }), "warning");
            return;
          }
          toast(result === "draft" ? t("library.toast.drafted", { title: selectedTitle, session: s.label }) : t("library.toast.pasted", { title: selectedTitle, session: s.label }));
          setActive(sessionId);
          onClose();
          if (mode === "terminal") requestAnimationFrame(() => focusTerminal(sessionId));
        })
        .catch((e) => toast(t("library.toast.failed", { error: String(e) }), "error"));
    },
    startTask: (task: string, persona: { text: string } | null) => {
      const pick = detail ? { id: detail.id, version: detail.row.v, title: detail.row.title } : null;
      setLauncherSeed({
        task,
        prompt: persona ? null : pick,
        persona: persona && pick ? { ...pick, text: persona.text } : null,
      });
      if (selectedLibId) void libraryRecordUse(selectedLibId);
      onClose();
      onStartTask();
    },
    install: () => setInstalling(true),
    copy: (text: string) => {
      void navigator.clipboard.writeText(text).then(() => toast(t("library.toast.copied")));
      if (selectedLibId) void libraryRecordUse(selectedLibId);
    },
    pin: (next: boolean) => {
      if (!selectedLibId) return;
      void librarySetItem(selectedLibId, { pinned: next }).then(() => {
        refreshStates();
        loadShelves();
      });
    },
    hide: (next: boolean) => {
      if (!selectedLibId) return;
      void librarySetItem(selectedLibId, { hidden: next }).then(() => {
        refreshStates();
        loadShelves();
        if (next) toast(t("library.toast.hidden"), "info");
      });
    },
    duplicate: (text: string) => {
      if (!detail) return;
      // The copy goes into Mine, the one place the person's own prompts live.
      void import("../../library/myPrompts")
        .then(({ saveMyPrompt }) =>
          saveMyPrompt({
            kind: detail.row.kind === "persona" ? "persona" : detail.row.kind === "style" ? "style" : "prompt",
            title: detail.row.title,
            description: detail.row.desc,
            text,
            from: { id: detail.id, version: detail.row.v },
          }),
        )
        .then(() => loadMine().then(setMine))
        .then(() => toast(t("library.toast.duplicated", { title: detail.row.title })))
        .catch((e) => toast(t("library.toast.failed", { error: String(e) }), "error"));
    },
  };

  const toggleShowEverything = (on: boolean) => {
    setShowEverything(on);
  };

  const onSeeAll = (shelf: Shelf) => {
    setNav("home");
    if (shelf.id === "project") {
      setStackAuto(true);
      setQuery("");
      setDomain(null);
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const finishInterests = () => {
    setInterestsOffered(true);
    setInterestsOpen(false);
    void setSetting("library_onboarded", "true").catch(() => {});
    loadShelves();
  };

  const clearSearch = () => {
    setQuery("");
    setKinds(new Set());
    setDomain(null);
    setCategory(null);
    setIntent(null);
    setTopic(null);
    setDepths(new Set());
    setHealth(false);
    setStackAuto(false);
    setNav("home");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !installing && !updateOpen) {
        e.preventDefault();
        if (selection) setSelection(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [installing, updateOpen, selection, onClose]);

  if (!ready) return <div className="library-view" aria-busy="true" />;

  const showSearch = searching_;
  const rows = status?.catalog?.rows ?? 0;
  const domainLabel = domain ? (shelves?.domains.find((d) => d.id === domain)?.label ?? domain) : null;
  const categoryLabel = category ? (shelves?.domains.flatMap((d) => d.categories ?? []).find((c) => c.id === category)?.label ?? category) : null;
  const vocabLabel = (list: { id: string; label: string }[] | undefined, id: string | null) => (id ? (list?.find((x) => x.id === id)?.label ?? id) : null);
  const intentLabel = vocabLabel(shelves?.intents, intent);
  const topicLabel = vocabLabel(shelves?.topics, topic);
  const labels = {
    domain: (id: string) => shelves?.domains.find((d) => d.id === id)?.label ?? id,
    category: (id: string) => shelves?.domains.flatMap((d) => d.categories ?? []).find((c) => c.id === id)?.label ?? id,
  };
  const filledFromSearch =
    answers && detail && Object.keys(answers).length > 0
      ? argsOf(detail.body)
          .map((a) => answers[a.name])
          .filter(Boolean)
          .join(" · ")
      : null;
  const navItems: { id: Nav; label: string; count?: number }[] = [
    { id: "home", label: t("library.nav.forYou") },
    ...(recent.length > 0 ? [{ id: "recent" as Nav, label: t("library.nav.recent"), count: recent.length }] : []),
    { id: "pinned", label: t("library.nav.pinned"), count: pinned.size },
    ...(projectName ? [{ id: "installed" as Nav, label: t("library.nav.installed", { project: projectName }) }] : []),
    { id: "mine", label: t("library.nav.mine"), count: mine.length },
    // Only the 2.0 built-ins the catalog has no entry for are left here.
    ...(classics.length > 0 ? [{ id: "classics" as Nav, label: t("library.nav.classics"), count: classics.length }] : []),
    ...(hidden.size > 0 ? [{ id: "hidden" as Nav, label: t("library.nav.hidden"), count: hidden.size }] : []),
  ];

  return (
    <div className="library-view" data-testid="library-view" data-ready={status?.ready ? "true" : "false"} data-answered={answered ?? undefined}>
      <div className="lib-head">
        <span className="lib-title">{t("library.title")}</span>
        <LibraryUpdateBadge status={status} fresh={fresh} open={updateOpen} onToggle={() => {
            // The background check may have run since: show its verdict.
            refreshStatus();
            setUpdateOpen((o) => !o);
          }} />
        <CloseButton label={t("library.close")} onClick={onClose} />
      </div>
      {updateOpen && status && (
        <div className="lib-popover" role="dialog" aria-label={t("library.update.title")}>
          <LibraryUpdatePanel
            status={status}
            onChanged={() => {
              refreshStatus();
              loadShelves();
            }}
          />
        </div>
      )}

      {showSearch && (
        <div className="lib-facets" role="toolbar" aria-label={t("library.facets.label")}>
          {domainLabel && (
            <Chip size="sm" selected onToggle={() => setDomain(null)} onRemove={() => setDomain(null)} removeLabel={t("library.facets.remove")}>
              {t("library.facets.domain", { domain: domainLabel })}
            </Chip>
          )}
          {categoryLabel && (
            <Chip size="sm" selected onToggle={() => setCategory(null)} onRemove={() => setCategory(null)} removeLabel={t("library.facets.remove")}>
              {t("library.facets.category", { category: categoryLabel })}
            </Chip>
          )}
          {intentLabel && (
            <Chip size="sm" selected onToggle={() => setIntent(null)} onRemove={() => setIntent(null)} removeLabel={t("library.facets.remove")}>
              {intentLabel}
            </Chip>
          )}
          {topicLabel && (
            <Chip size="sm" selected onToggle={() => setTopic(null)} onRemove={() => setTopic(null)} removeLabel={t("library.facets.remove")}>
              {topicLabel}
            </Chip>
          )}
          {KINDS.map((k) => (
            <Chip
              key={k}
              size="sm"
              selected={kinds.has(k)}
              onToggle={(on) =>
                setKinds((cur) => {
                  const next = new Set(cur);
                  if (on) next.add(k);
                  else next.delete(k);
                  return next;
                })
              }
              buttonAttrs={{ className: "lib-kind-chip", "data-kind": k }}
            >
              {t(`library.kinds.${k}`)}
              {page?.kindCounts[k] !== undefined ? ` ${page.kindCounts[k] > 1000 ? "1000+" : page.kindCounts[k]}` : ""}
            </Chip>
          ))}
          {levels.map((l) => (
            <Chip
              key={l.id}
              size="sm"
              selected={depths.has(l.id)}
              onToggle={(on) =>
                setDepths((cur) => {
                  const next = new Set(cur);
                  if (on) next.add(l.id);
                  else next.delete(l.id);
                  return next;
                })
              }
              buttonAttrs={{ className: "lib-depth-chip", "data-depth": l.id }}
            >
              {l.label}
            </Chip>
          ))}
          <Chip size="sm" selected={health} onToggle={setHealth} buttonAttrs={{ className: "lib-health-chip" }}>
            {t("library.care.health")}
          </Chip>
          {activeAgent && (
            <Chip size="sm" selected={worksAuto} onToggle={setWorksAuto} buttonAttrs={{ className: "lib-works-chip", "data-auto": "true" }}>
              {t("library.facets.works", { agent: agentName(activeAgent) })}
            </Chip>
          )}
          {(shelves?.stack.length ?? 0) > 0 && (
            <Chip size="sm" selected={stackAuto} onToggle={setStackAuto} buttonAttrs={{ className: "lib-stack-chip" }}>
              {t("library.facets.stack", { stack: shelves!.stack.map((s) => s.label).join(", ") })}
            </Chip>
          )}
          <span className="lib-spacer" />
          <Segmented
            size="sm"
            label={t("library.facets.sort")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "you", label: t("library.facets.sortYou") },
              { value: "best", label: t("library.facets.sortBest") },
              { value: "new", label: t("library.facets.sortNew") },
            ]}
          />
        </div>
      )}

      <div className={selection ? "lib-body lib-body--open" : "lib-body"}>
        <nav className="lib-nav" aria-label={t("library.nav.label")}>
          {navItems.map((n) => (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              aria-current={nav === n.id ? "page" : undefined}
              className={(n.id === "home" ? nav === "home" && !showSearch : nav === n.id) ? "lib-nav-item lib-nav-item--on" : "lib-nav-item"}
              data-nav={n.id}
              onClick={() => {
                setNav(n.id);
                if (n.id === "home") clearSearch();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setNav(n.id);
                  if (n.id === "home") clearSearch();
                }
              }}
            >
              <span>{n.label}</span>
              {n.count !== undefined && <span className="lib-count">{n.count}</span>}
            </div>
          ))}
          {shelves && shelves.profile.domains.length > 0 && (
            <>
              <div className="lib-nav-label">{t("library.nav.yourDomains")}</div>
              {shelves.domains
                .filter((d) => d.mine)
                .map((d) => (
                  <div
                    key={d.id}
                    role="button"
                    tabIndex={0}
                    className={domain === d.id ? "lib-nav-item lib-nav-item--on" : "lib-nav-item"}
                    data-domain={d.id}
                    onClick={() => setDomain(d.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDomain(d.id);
                      }
                    }}
                  >
                    <span>{d.label}</span>
                    <span className="lib-count">{d.count}</span>
                  </div>
                ))}
            </>
          )}
        </nav>

        <div className="lib-main">
          <LibraryAsk
            compact={showSearch && !interestsOpen}
            hint={facetsUsed || (shelves?.profile.roles ?? []).some(isDeveloperRole)}
            inputRef={inputRef}
            query={query}
            rows={rows}
            essentials={shelves?.essentials ?? []}
            route={route}
            onQuery={(q) => {
              setQuery(q);
              if (nav !== "home" && !nav.startsWith("domain:")) setNav("home");
            }}
            onOpen={(hit) => openId(hit.id, hit.reasons)}
            onFirst={() => {
              const first = items.find((i) => i.type !== "header");
              if (!first) return false;
              if (first.type === "hit") openId(first.hit.id, first.hit.reasons);
              else if (first.type === "legacy") setSelection({ type: "legacy", item: first.item });
              return true;
            }}
          />
          {interestsOpen ? (
            <div className="lib-center">
              <LibraryInterests onSaved={finishInterests} onSkip={() => setInterestsOpen(false)} />
            </div>
          ) : showSearch || showSearchLagging ? (
            <LibraryResults
              items={items}
              total={listHits ? listHits.length : (page?.total ?? 0)}
              totalCapped={!listHits && !!page?.totalCapped}
              query={query}
              filtered={chosen}
              loading={searching}
              selectedKey={selectedKey}
              pinned={pinned}
              personal={!showEverything && sort === "you"}
              route={route}
              filledFromSearch={filledFromSearch}
              partial={!listHits && answered === query && !!page?.partial}
              onOpen={(item) => {
                if (item.type === "hit") openId(item.hit.id, item.hit.reasons);
                else if (item.type === "legacy") setSelection({ type: "legacy", item: item.item });
              }}
              onOpenId={(hit) => openId(hit.id, hit.reasons)}
              onToggleSection={(id) =>
                setFolded((cur) => {
                  const next = new Set(cur);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onMore={() => {
                if (page?.nextCursor && !searching && !listHits) void runSearch(page.nextCursor);
              }}
              onClear={clearSearch}
            />
          ) : (
            <LibraryHome
              shelves={shelves}
              loading={!status}
              selectedId={selection?.type === "hit" ? selection.id : null}
              installedAgentIds={installedAgentIds}
              pinned={pinned}
              itemStates={itemStates}
              projectName={projectName}
              showInterests={!interestsOffered && !!shelves && shelves.profile.roles.length === 0 && shelves.profile.domains.length === 0}
              onOpen={(id) => {
                const hit = [...(shelves?.essentials ?? []), ...(shelves?.shelves.flatMap((s) => s.hits) ?? [])].find((h) => h.id === id);
                openId(id, hit?.reasons ?? []);
              }}
              onSeeAll={onSeeAll}
              onBrowseDomain={(d) => {
                setCategory(null);
                setDomain(d);
              }}
              onBrowseCategory={(d, c) => {
                setDomain(d);
                setCategory(c);
              }}
              onSearchIntent={(i, tp) => {
                setIntent(i);
                setTopic(tp);
              }}
              onShowEverything={toggleShowEverything}
              onInterestsDone={finishInterests}
              onEditInterests={() => setInterestsOpen(true)}
            />
          )}
        </div>

        {selection && (
          <LibraryDetail
            entry={selection.type === "hit" ? detail : null}
            answers={answers}
            leads={leads}
            labels={labels}
            onOpenLead={(hit) => openId(hit.id, hit.reasons)}
            legacy={selection.type === "legacy" ? selection.item : null}
            reasons={selection.type === "hit" ? selection.reasons : []}
            sessions={sessionChoices}
            defaultSessionId={state.activeSessionId}
            installAgentId={activeAgent && activeAgent !== "custom" ? activeAgent : (installedAgentIds[0] ?? "claude")}
            pinned={selectedLibId ? pinned.has(selectedLibId) : false}
            hidden={selectedLibId ? hidden.has(selectedLibId) : false}
            actions={actions}
          />
        )}
      </div>

      {installing && detail && projectPath && (
        <LibraryInstall
          entry={detail}
          projectPath={projectPath}
          installedAgentIds={installedAgentIds}
          initialAgentId={activeAgent && activeAgent !== "custom" ? activeAgent : (installedAgentIds[0] ?? "claude")}
          catalog={status?.catalog?.catalog ?? ""}
          onClose={() => setInstalling(false)}
          onInstalled={(message) => {
            setInstalling(false);
            toast(message);
            if (nav === "installed") setNav("home");
          }}
        />
      )}
      {installing && !projectPath && (
        <div className="lib-sheet-backdrop" role="presentation" onClick={() => setInstalling(false)}>
          <div className="lib-sheet" role="alertdialog" aria-label={t("library.install.noProject")}>
            <div className="lib-sheet-body">
              <p>{t("library.install.noProject")}</p>
            </div>
            <div className="lib-sheet-foot">
              <Button variant="primary" onClick={() => setInstalling(false)}>
                {t("library.ok")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
