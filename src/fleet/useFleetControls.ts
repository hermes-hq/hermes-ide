// ─── Fleet controls, wired to the app (F31, F37, N22) ─────────────────
//
// Mounted once by App when the `fleetControls` flag is on. It:
//
//   - reads the caps from settings;
//   - keeps the worktree index (repository and feature branch per session);
//   - checks the spend caps whenever a session reports usage (F31);
//   - refreshes Collision Radar when a session ends a turn (F37);
//   - polls the agents' load while a running-agents or memory cap is set,
//     and starts the next queued task when a slot frees (N22).

import { useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSessionEventSnapshot, subscribeSessionEvents } from "../agent/contract/sessionEventStore";
import { raiseInboxItem } from "../agent/contract/inbox";
import { listAllWorktrees } from "../api/git";
import type { CreateSessionOpts, SessionData } from "../types/session";
import { getFleetCaps, loadFleetCaps, subscribeFleetCaps, type FleetCaps } from "./fleetSettings";
import { formatUsd, type CapTrip } from "./spend";
import { createSpendCapWatcher } from "./spendCapWatcher";
import { refreshSessionTurnFiles, setRadarSessions } from "./radarStore";
import { buildWorktreeIndex, EMPTY_WORKTREE_INDEX, type WorktreeIndex } from "./worktreeIndex";
import { applyAgentLoad, fetchAgentLoad, getAllLoads, loadPollDelay, subscribeAgentLoad } from "./fleetLoad";
import {
  enqueueTask,
  hasFreeSlot,
  listQueuedTasks,
  occupiesSlot,
  publishOccupancy,
  queueEnabled,
  registerTaskStarter,
  removeTask,
  subscribeTaskQueue,
  type Occupancy,
  type QueuedTask,
} from "./taskQueue";

type Translate = (key: string, vars?: Record<string, string>) => string;

export const CLOSED_PHASES: ReadonlySet<string> = new Set(["closing", "destroyed", "disconnected"]);

export function isAgentSession(s: Pick<SessionData, "ai_provider">): boolean {
  return !!s.ai_provider;
}

/** Pure: who holds a slot right now, from the sessions, their events and their load. */
export function computeOccupancy(sessions: readonly SessionData[], now: number): Occupancy {
  const loads = getAllLoads();
  const ids: string[] = [];
  let memoryBytes = 0;
  for (const s of sessions) {
    const events = getSessionEventSnapshot(s.id);
    const load = loads.get(s.id) ?? null;
    const created = Date.parse(s.created_at);
    const held = occupiesSlot({
      isAgent: isAgentSession(s),
      closed: CLOSED_PHASES.has(s.phase),
      status: events.status,
      statusReported: events.events.some((e) => e.type === "status" || e.type === "exit"),
      startupEnded: s.agent_startup?.state === "ended",
      running: load ? load.running : false,
      seenRunning: load?.seenRunning ?? false,
      ageMs: Number.isFinite(created) ? now - created : 0,
    });
    if (held) {
      ids.push(s.id);
      memoryBytes += load?.memoryBytes ?? 0;
    }
  }
  return { sessionIds: ids, memoryBytes };
}

export function describeTrip(trip: CapTrip, t: Translate): string {
  const vars = { spent: formatUsd(trip.spentUsd), cap: formatUsd(trip.capUsd), name: trip.label };
  return trip.kind === "session" ? t("fleet.capInboxSession", vars) : t("fleet.capInboxFeature", vars);
}

export interface FleetControlsOptions {
  /** The `fleetControls` flag: when off, nothing here runs. */
  readonly enabled: boolean;
  readonly sessions: readonly SessionData[];
  /** Start a queued task exactly as the New Session wizard would have. */
  readonly startTask: (opts: CreateSessionOpts) => Promise<{ id: string } | null>;
  readonly t: Translate;
}

export interface FleetControls {
  /**
   * For the New Session wizard: queue this agent task instead of starting
   * it when a cap is set and no slot is free (or others already wait).
   * True when it was queued.
   */
  readonly queueIfFull: (opts: CreateSessionOpts, label: string) => boolean;
}

export function useFleetControls({ enabled, sessions, startTask, t }: FleetControlsOptions): FleetControls {
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const tRef = useRef(t);
  tRef.current = t;
  const indexRef = useRef<WorktreeIndex>(EMPTY_WORKTREE_INDEX);
  // Tasks started from the queue that are not in the session list yet
  // (in flight, or created but not rendered): each holds a slot.
  const inFlightRef = useRef(0);
  const pendingIdsRef = useRef(new Set<string>());
  const starting = useCallback(() => {
    for (const id of [...pendingIdsRef.current]) {
      if (sessionsRef.current.some((s) => s.id === id)) pendingIdsRef.current.delete(id);
    }
    return inFlightRef.current + pendingIdsRef.current.size;
  }, []);

  const watcher = useMemo(
    () =>
      createSpendCapWatcher({
        sessions: () => sessionsRef.current.filter((s) => !CLOSED_PHASES.has(s.phase)).map((s) => ({ id: s.id, label: s.label })),
        featureOf: (id) => indexRef.current.features.get(id) ?? null,
        caps: getFleetCaps,
        interrupt: (sessionId) => invoke<boolean>("interrupt_session_agent", { sessionId }),
        raise: raiseInboxItem,
        describe: (trip) => describeTrip(trip, tRef.current),
      }),
    [],
  );

  // ── N22: start the next task when a slot frees ──────────────────────
  const launch = useCallback((task: QueuedTask) => {
    inFlightRef.current++;
    // The new session holds its slot from the moment it exists (see
    // STARTUP_GRACE_MS); until then it is counted as starting.
    startTask(task.opts)
      .then((session) => {
        if (session) pendingIdsRef.current.add(session.id);
      })
      .catch((err) => console.warn("[fleet] a queued task did not start:", err))
      .finally(() => {
        inFlightRef.current--;
      });
  }, [startTask]);

  const pumpingRef = useRef(false);
  const pumpQueue = useCallback(() => {
    // Taking a task out of the queue notifies the queue's subscribers,
    // this function among them: never run twice at once.
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      const caps: FleetCaps = getFleetCaps();
      for (;;) {
        const occupancy = computeOccupancy(sessionsRef.current, Date.now());
        publishOccupancy(occupancy);
        const next = listQueuedTasks()[0];
        if (!next) return;
        if (queueEnabled(caps) && !hasFreeSlot(occupancy, caps, starting())) return;
        removeTask(next.id);
        launch(next);
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [launch, starting]);

  useEffect(() => {
    if (!enabled) return;
    registerTaskStarter(launch);
    return () => registerTaskStarter(null);
  }, [enabled, launch]);

  const queueIfFull = useCallback((opts: CreateSessionOpts, label: string): boolean => {
    if (!enabled || !opts.aiProvider) return false;
    const caps = getFleetCaps();
    if (!queueEnabled(caps)) return false;
    const waiting = listQueuedTasks().length > 0;
    if (!waiting && hasFreeSlot(computeOccupancy(sessionsRef.current, Date.now()), caps, starting())) return false;
    enqueueTask(opts, label);
    return true;
  }, [enabled, starting]);

  useEffect(() => {
    if (!enabled) return;
    void loadFleetCaps().then(() => {
      watcher.check();
      pumpQueue();
    });
    const offCaps = subscribeFleetCaps(() => {
      watcher.check();
      pumpQueue();
    });
    const offQueue = subscribeTaskQueue(pumpQueue);
    const offLoad = subscribeAgentLoad(pumpQueue);
    return () => {
      offCaps();
      offQueue();
      offLoad();
    };
  }, [enabled, watcher, pumpQueue]);

  // ── Per session: usage -> caps, turn ends -> radar, status -> queue ──
  const idsKey = sessions.map((s) => s.id).join("\n");
  useEffect(() => {
    if (!enabled) return;
    const ids = idsKey ? idsKey.split("\n") : [];
    let cancelled = false;
    // Where a session works: its repositories, else its folder.
    const repoKeys = (id: string): readonly string[] => {
      const repos = indexRef.current.repos.get(id);
      if (repos && repos.length > 0) return repos;
      const s = sessionsRef.current.find((x) => x.id === id);
      return s ? [`folder:${s.working_directory}`] : [];
    };
    setRadarSessions(ids, repoKeys);
    listAllWorktrees()
      .then((rows) => {
        if (cancelled) return;
        indexRef.current = buildWorktreeIndex(rows);
        setRadarSessions(ids, repoKeys);
        watcher.check();
      })
      .catch((err) => console.warn("[fleet] could not list worktrees:", err));

    const offs = ids.map((id) => {
      let completed = getSessionEventSnapshot(id).turn.completed;
      let usage = getSessionEventSnapshot(id).usage;
      void refreshSessionTurnFiles(id);
      return subscribeSessionEvents(id, () => {
        const snap = getSessionEventSnapshot(id);
        if (snap.turn.completed !== completed) {
          completed = snap.turn.completed;
          void refreshSessionTurnFiles(id);
        }
        if (snap.usage !== usage) {
          usage = snap.usage;
          watcher.check();
        }
        pumpQueue();
      });
    });
    watcher.check();
    pumpQueue();
    return () => {
      cancelled = true;
      for (const off of offs) off();
    };
  }, [enabled, idsKey, watcher, pumpQueue]);

  // Session phases and startup states change without an event.
  useEffect(() => {
    if (enabled) pumpQueue();
  }, [enabled, sessions, pumpQueue]);

  // ── N22: the agents' load, polled while a cap is set (every second
  // while tasks wait, every few seconds otherwise) ─────────────────────
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerDue = 0;
    let polling = false;
    let stopped = false;
    const schedule = () => {
      const delay = loadPollDelay(listQueuedTasks().length);
      timerDue = Date.now() + delay;
      timer = setTimeout(tick, delay);
    };
    const tick = async () => {
      timer = undefined;
      polling = true;
      const agents = sessionsRef.current.filter((s) => isAgentSession(s) && !CLOSED_PHASES.has(s.phase)).map((s) => s.id);
      if (queueEnabled(getFleetCaps()) && agents.length > 0) {
        try {
          applyAgentLoad(await fetchAgentLoad(agents));
        } catch (err) {
          console.warn("[fleet] could not read the agents' load:", err);
        }
      }
      polling = false;
      if (!stopped) schedule();
    };
    // A task that starts waiting brings the next read forward.
    const offQueue = subscribeTaskQueue(() => {
      if (stopped || polling || !timer || timerDue - Date.now() <= loadPollDelay(listQueuedTasks().length)) return;
      clearTimeout(timer);
      schedule();
    });
    void tick();
    return () => {
      stopped = true;
      offQueue();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return useMemo(() => ({ queueIfFull }), [queueIfFull]);
}
