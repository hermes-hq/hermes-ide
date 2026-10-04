// ─── The Library (Hodios inside Hermes) ───────────────────────────────
//
// Loaded on demand: nothing of it is startup code. The first open imports
// the catalog bundled with the app (offline); the first screen shows a few
// shelves of what fits this person and why, search covers every entry, and
// an open entry can be used in any session, started as a task with any
// agent, or installed into the project for an agent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button, Chip, CloseButton, Input, Segmented } from "../ui";
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

type Nav = "home" | "pinned" | "installed" | "mine" | "classics" | "hidden" | `domain:${string}`;

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
  const searchSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

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
  }, [refreshStatus, refreshStates]);

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
  const hidden = useMemo(() => new Set(itemStates.filter((s) => s.hidden).map((s) => s.itemId)), [itemStates]);

  // ── Search ──────────────────────────────────────────────────────────
  const searching_ = nav !== "home" || query.trim() !== "" || kinds.size > 0 || domain !== null || stackAuto;
  const filters = useMemo(() => {
    const f: Record<string, string[]> = {};
    if (kinds.size > 0) f.kind = [...kinds];
    if (domain) f.domain = [domain];
    if (worksAuto && activeAgent && query.trim()) f.works = [worksTarget(activeAgent)];
    if (stackAuto && shelves?.stack.length) f.stack = shelves.stack.map((s) => s.value);
    return f;
  }, [kinds, domain, worksAuto, activeAgent, stackAuto, shelves?.stack, query]);

  const runSearch = useCallback(
    async (cursor: string | null) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const res = await librarySearch(
          { query, filters, cursor, limit: 50, sort, personalise: !showEverything, includeHidden: nav === "hidden", counts: !cursor },
          context,
        );
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
    if (!status?.ready || !searching_ || nav === "pinned" || nav === "installed" || nav === "mine" || nav === "classics") return;
    const timer = setTimeout(() => void runSearch(null), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [status?.ready, searching_, nav, runSearch]);

  // Lists by id: pinned, installed in this project.
  useEffect(() => {
    if (nav !== "pinned" && nav !== "installed") {
      setListHits(null);
      return;
    }
    let live = true;
    const ids = async () => {
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
  }, [nav, pinned, projectPath, context]);

  const items: ResultItem[] = useMemo(() => {
    const out: ResultItem[] = [];
    const libHits = listHits ?? (nav === "mine" || nav === "classics" ? [] : hits);
    if (libHits.length > 0) {
      out.push({ type: "header", key: "h:lib", label: t("library.results.groupLibrary"), count: String(libHits.length) });
      for (const h of libHits) out.push({ type: "hit", key: `hit:${h.id}`, hit: h });
    }
    const withLegacy = nav === "mine" || nav === "classics" || (nav !== "pinned" && nav !== "installed" && nav !== "hidden" && kinds.size === 0 && !domain);
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
  }, [hits, listHits, nav, classics, mine, query, kinds.size, domain, t]);

  // ── Selection and detail ────────────────────────────────────────────
  const openId = useCallback((id: string, reasons: LibraryHit["reasons"] = []) => {
    setSelection({ type: "hit", id, reasons });
  }, []);
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
  const navItems: { id: Nav; label: string; count?: number }[] = [
    { id: "home", label: t("library.nav.forYou") },
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
        <div className="lib-search">
          <Input
            ref={inputRef}
            size="sm"
            type="search"
            className="lib-search-input"
            aria-label={t("library.search.label")}
            placeholder={t("library.search.placeholder", { count: rows.toLocaleString() })}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (nav !== "home" && !nav.startsWith("domain:")) setNav("home");
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                const first = items.find((i) => i.type !== "header");
                if (first) {
                  e.preventDefault();
                  if (first.type === "hit") openId(first.hit.id, first.hit.reasons);
                  else if (first.type === "legacy") setSelection({ type: "legacy", item: first.item });
                }
              }
            }}
            autoFocus
          />
          <span className="lib-search-hint">{t("library.search.hint")}</span>
        </div>
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

      <div className="lib-body">
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

        {interestsOpen ? (
          <div className="lib-center">
            <LibraryInterests onSaved={finishInterests} onSkip={() => setInterestsOpen(false)} />
          </div>
        ) : showSearch ? (
          <LibraryResults
            items={items}
            total={listHits ? listHits.length : (page?.total ?? 0)}
            totalCapped={!listHits && !!page?.totalCapped}
            query={query}
            filtered={Object.keys(filters).length > 0}
            loading={searching}
            selectedKey={selectedKey}
            installedTargets={installedTargets}
            pinned={pinned}
            personal={!showEverything && sort === "you"}
            onOpen={(item) => {
              if (item.type === "hit") openId(item.hit.id, item.hit.reasons);
              else if (item.type === "legacy") setSelection({ type: "legacy", item: item.item });
            }}
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
            installedTargets={installedTargets}
            installedAgentIds={installedAgentIds}
            pinned={pinned}
            projectName={projectName}
            showInterests={!interestsOffered && !!shelves && shelves.profile.roles.length === 0 && shelves.profile.domains.length === 0}
            onOpen={(id) => {
              const hit = shelves?.shelves.flatMap((s) => s.hits).find((h) => h.id === id);
              openId(id, hit?.reasons ?? []);
            }}
            onSeeAll={onSeeAll}
            onBrowseDomain={(d) => setDomain(d)}
            onShowEverything={toggleShowEverything}
            onInterestsDone={finishInterests}
            onEditInterests={() => setInterestsOpen(true)}
          />
        )}

        {selection && (
          <LibraryDetail
            entry={selection.type === "hit" ? detail : null}
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
