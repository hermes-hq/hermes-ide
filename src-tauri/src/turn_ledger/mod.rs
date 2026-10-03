//! Turn ledger (F20): at the end of every agent turn, a snapshot of the
//! worktree — tracked, modified and untracked files, never ignored ones —
//! lands in the hidden git reference `refs/hermes/<session>/turn/<n>` and a
//! row in `agent_turns` (contract C0, docs/adr/004-2.0-contracts.md).
//!
//! What it never does: touch HEAD, the user's index or the stash (see
//! `snapshot.rs`: a private index, plumbing only). What it does off the PTY
//! reader thread: everything — a turn end only spawns a worker, and workers
//! are single-flight per worktree (one snapshot at a time per git dir).
//!
//! Turn boundaries come from two places:
//! - exact: a `turn_start` / `turn_end` SessionEvent (an agent's own hook,
//!   forwarded by the frontend through `turn_ledger_turn_ended`);
//! - guessed: the PTY phase going Busy -> Idle/NeedsInput in a session that
//!   runs an agent, until that session reports an exact boundary, after
//!   which the guess is ignored for it.
//!
//! A snapshot that runs past the budget (2 s) is stopped; that worktree then
//! keeps only a diffstat summary per turn (`degraded`). Every
//! [`RETRY_AFTER_TURNS`] summaries a full snapshot is tried again, so one
//! slow moment (a cold index on a large repository) does not switch a
//! worktree off for the rest of the run.
//! Kill switches: the `turnLedger` feature flag (the frontend tells the
//! backend once at start) and the `turn_ledger` setting (`off`).
//!
//! Nothing is written to a repository until a turn actually changed
//! something: the baseline a session starts from is only kept in memory (the
//! tree object, plus a warm private index) and is committed to
//! `refs/hermes/<session>/base` together with the first recorded turn. A
//! terminal session that never ran an agent, or an agent that never edited,
//! leaves no reference behind. References of a session closed 14 days ago
//! are collected at startup.

pub mod snapshot;
pub mod store;

use crate::contract::turns::{turn_ref, Diffstat, Turn, TurnDiff};
use crate::db::Database;
use crate::pty::SessionPhase;
use crate::AppState;
use serde::Serialize;
use snapshot::{Repo, WriteTree, DEFAULT_BUDGET};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// The Tauri event the turn bar refreshes on.
pub const TURN_LEDGER_EVENT: &str = "hermes:turn-ledger";

/// Settings key of the kill switch; `off` disables snapshots.
pub const KILL_SWITCH_SETTING: &str = "turn_ledger";

/// A baseline is taken once per session start on a cold private index; it
/// may take longer than a turn and nobody waits for it.
const BASELINE_BUDGET: Duration = Duration::from_secs(30);

/// Refs of sessions closed this long ago are collected.
pub const GC_AFTER_DAYS: i64 = 14;

/// A degraded worktree tries a full snapshot again after this many summary
/// turns.
pub const RETRY_AFTER_TURNS: u32 = 5;

fn base_ref(session_id: &str) -> String {
    format!("refs/hermes/{session_id}/base")
}

/// Every restore keeps the worktree it replaced under its own number, so a
/// second restore never discards what the first one set aside.
fn before_restore_ref(session_id: &str, k: usize) -> String {
    format!("{}{k}", before_restore_prefix(session_id))
}

fn before_restore_prefix(session_id: &str) -> String {
    format!("refs/hermes/{session_id}/before-restore/")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Per-session bookkeeping: where the chain of snapshots is.
#[derive(Debug, Default, Clone)]
struct SessionState {
    root: Option<PathBuf>,
    /// The tree of the last snapshot (base, turn or restore target). With
    /// `last_commit` None it is a baseline that lives only here, committed
    /// when the first turn that changed something is recorded.
    last_tree: Option<String>,
    /// The commit the next snapshot is parented on.
    last_commit: Option<String>,
    /// An exact boundary was seen: PTY guesses are ignored from then on.
    exact_seen: bool,
    /// When the turn in progress started (exact or guessed).
    turn_started_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotOutcome {
    Recorded(Turn),
    /// The worktree is the same as after the previous snapshot: no commit.
    NoChange,
    /// The snapshot ran past the budget; only a summary row was kept.
    Degraded(Turn),
    NotARepo,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub turn: Turn,
    /// What restoring would change, as a unified diff of the worktree now
    /// against the turn's tree.
    pub patch: String,
    pub diffstat: Diffstat,
    /// Files with edits no turn made (the person's, since the last
    /// snapshot): a restore sets them aside, and Undo brings them back.
    pub set_aside: Vec<String>,
}

/// The changes no turn made, between two turns (see `between_turns`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BetweenTurns {
    /// The turn these changes came before.
    pub before: u32,
    pub patch: String,
    pub diffstat: Diffstat,
    /// When the turn before ended (epoch ms): the changes came after it.
    pub at: i64,
}

/// A review file Hermes writes for the person (`r` in the Track view):
/// `.hermes/features/<slug>/review-<n>.md`.
pub fn is_hermes_review_file(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    matches!(parts.as_slice(), [".hermes", "features", _, name] if name.starts_with("review-") && name.ends_with(".md"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub n: u32,
    /// Paths written or removed.
    pub files: u32,
    /// The number `k` of `before-restore/<k>`, which holds the worktree as
    /// it was before this restore: what Undo goes back to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_aside: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnLedgerEvent {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<Turn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_to: Option<u32>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GcReport {
    pub sessions: u32,
    pub refs: u32,
}

pub struct TurnLedger {
    enabled: AtomicBool,
    budget: Mutex<Duration>,
    /// One lock per git dir: a worktree is snapshotted by one worker at a time.
    lanes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Git dirs whose snapshots ran past the budget: summary rows only,
    /// with how many summaries were recorded since (a full snapshot is
    /// tried again at [`RETRY_AFTER_TURNS`]).
    degraded: Mutex<HashMap<String, u32>>,
    sessions: Mutex<HashMap<String, SessionState>>,
    /// Sessions with a turn-end snapshot queued but not yet started: a
    /// chatty PTY (Busy -> Idle several times before the first snapshot
    /// gets the lane) queues one worker, not one per transition.
    queued: Mutex<HashSet<String>>,
    /// Per session, the order its background jobs (baseline at a turn's
    /// start, snapshot at its end) were asked for: they run in that order,
    /// so a turn start's baseline is never taken after that turn's end (it
    /// would hand the agent's work to "between turns"), and a turn end never
    /// overtakes the baseline of its start (it would charge the person's
    /// edits to the agent).
    order: Mutex<HashMap<String, Tickets>>,
    order_cv: Condvar,
}

#[derive(Debug, Default, Clone, Copy)]
struct Tickets {
    next: u64,
    serving: u64,
}

/// How long a job waits for the ones asked for before it (a stuck git).
const ORDER_WAIT: Duration = Duration::from_secs(30);

/// Held while a session's job runs; lets the next one go when dropped.
pub struct TicketGuard<'a> {
    ledger: &'a TurnLedger,
    session_id: String,
    ticket: u64,
}

impl Drop for TicketGuard<'_> {
    fn drop(&mut self) {
        let mut order = self.ledger.order.lock().unwrap_or_else(|p| p.into_inner());
        let t = order.entry(self.session_id.clone()).or_default();
        t.serving = t.serving.max(self.ticket + 1);
        self.ledger.order_cv.notify_all();
    }
}

impl Default for TurnLedger {
    fn default() -> Self {
        Self::with_budget(DEFAULT_BUDGET)
    }
}

impl TurnLedger {
    pub fn with_budget(budget: Duration) -> Self {
        TurnLedger {
            enabled: AtomicBool::new(false),
            budget: Mutex::new(budget),
            lanes: Mutex::new(HashMap::new()),
            degraded: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            queued: Mutex::new(HashSet::new()),
            order: Mutex::new(HashMap::new()),
            order_cv: Condvar::new(),
        }
    }

    /// Take the session's next place in line, when its job is asked for.
    pub fn take_ticket(&self, session_id: &str) -> u64 {
        let mut order = self.order.lock().unwrap_or_else(|p| p.into_inner());
        let t = order.entry(session_id.to_string()).or_default();
        let k = t.next;
        t.next += 1;
        k
    }

    /// Wait until every job of the session asked for before `ticket` ran
    /// (or [`ORDER_WAIT`] passed), then run; the guard lets the next go.
    pub fn wait_ticket(&self, session_id: &str, ticket: u64) -> TicketGuard<'_> {
        let deadline = std::time::Instant::now() + ORDER_WAIT;
        let mut order = self.order.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            let serving = order.get(session_id).map(|t| t.serving).unwrap_or(0);
            let now = std::time::Instant::now();
            if serving >= ticket || now >= deadline {
                break;
            }
            order = self
                .order_cv
                .wait_timeout(order, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        TicketGuard {
            ledger: self,
            session_id: session_id.to_string(),
            ticket,
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    fn set_budget(&self, budget: Duration) {
        *self.budget.lock().unwrap() = budget;
    }

    fn budget(&self) -> Duration {
        *self.budget.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lane(&self, key: &str) -> Arc<Mutex<()>> {
        let mut lanes = self.lanes.lock().unwrap_or_else(|p| p.into_inner());
        lanes.entry(key.to_string()).or_default().clone()
    }

    pub fn is_degraded(&self, repo: &Repo) -> bool {
        self.degraded
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(&repo.lane_key())
    }

    fn mark_degraded(&self, repo: &Repo) {
        self.degraded
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(repo.lane_key(), 0);
    }

    fn clear_degraded(&self, repo: &Repo) {
        self.degraded
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&repo.lane_key());
    }

    /// Count one more summary turn for a degraded worktree; true when it is
    /// time to try a full snapshot again.
    fn degraded_retry_due(&self, repo: &Repo) -> bool {
        let mut degraded = self.degraded.lock().unwrap_or_else(|p| p.into_inner());
        let Some(count) = degraded.get_mut(&repo.lane_key()) else {
            return true;
        };
        *count += 1;
        if *count >= RETRY_AFTER_TURNS {
            *count = 0;
            true
        } else {
            false
        }
    }

    /// Claim the queue slot of a session's turn-end snapshot; false when one
    /// is already waiting (it will see this turn's changes when it runs).
    pub fn queue_turn_end(&self, session_id: &str) -> bool {
        self.queued
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session_id.to_string())
    }

    fn dequeue_turn_end(&self, session_id: &str) {
        self.queued
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(session_id);
    }

    /// Whether snapshots run at all: the flag (told by the frontend) and the
    /// kill-switch setting.
    fn active(&self, db: &Mutex<Database>) -> bool {
        if !self.is_enabled() {
            return false;
        }
        let off = db
            .lock()
            .ok()
            .and_then(|d| d.get_setting(KILL_SWITCH_SETTING).ok().flatten())
            .map(|v| v.trim().eq_ignore_ascii_case("off"))
            .unwrap_or(false);
        !off
    }

    fn with_session<T>(&self, session_id: &str, f: impl FnOnce(&mut SessionState) -> T) -> T {
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        f(sessions.entry(session_id.to_string()).or_default())
    }

    /// The session's chain on this repo, (re)read from the refs when the
    /// session is new here or moved to another repository.
    fn session_state(&self, db: &Mutex<Database>, session_id: &str, repo: &Repo) -> SessionState {
        let known = self.with_session(session_id, |s| s.clone());
        if known.root.as_deref() == Some(repo.root.as_path()) {
            return known;
        }
        let max = db
            .lock()
            .ok()
            .and_then(|d| store::max_n(&d, session_id).ok())
            .unwrap_or(0);
        let last_commit = (max > 0)
            .then(|| turn_ref(session_id, max))
            .flatten()
            .and_then(|r| repo.rev_parse(&r))
            .or_else(|| repo.rev_parse(&base_ref(session_id)));
        let last_tree = last_commit.as_deref().and_then(|c| repo.tree_of(c));
        let fresh = SessionState {
            root: Some(repo.root.clone()),
            last_tree,
            last_commit,
            exact_seen: known.exact_seen,
            turn_started_at: known.turn_started_at,
        };
        self.with_session(session_id, |s| *s = fresh.clone());
        fresh
    }

    fn remember(&self, session_id: &str, tree: &str, commit: &str) {
        self.with_session(session_id, |s| {
            s.last_tree = Some(tree.to_string());
            s.last_commit = Some(commit.to_string());
            s.turn_started_at = None;
        });
    }

    /// A baseline was (re)taken: the turn in progress, if any, keeps its
    /// start time.
    fn remember_baseline(&self, session_id: &str, tree: &str, commit: Option<&str>) {
        self.with_session(session_id, |s| {
            s.last_tree = Some(tree.to_string());
            if let Some(c) = commit {
                s.last_commit = Some(c.to_string());
            }
        });
    }

    /// Note that a turn began (exact or guessed) so its row gets a start time.
    pub fn note_turn_started(&self, session_id: &str, at: i64, exact: bool) -> bool {
        self.with_session(session_id, |s| {
            if exact {
                s.exact_seen = true;
            } else if s.exact_seen {
                return false;
            }
            s.turn_started_at = Some(at);
            true
        })
    }

    /// Whether a turn end from this source counts for the session: an exact
    /// one always, a guess only while no exact boundary was ever reported.
    pub fn accepts_turn_end(&self, session_id: &str, exact: bool) -> bool {
        self.with_session(session_id, |s| {
            if exact {
                s.exact_seen = true;
                true
            } else {
                !s.exact_seen
            }
        })
    }

    /// The snapshot every turn is diffed against: taken when a session
    /// starts and refreshed at each turn start, so edits made between turns
    /// (by a person, or between two runs of Hermes) are never charged to a
    /// turn. Nothing happens when the worktree still matches the last
    /// snapshot. Until the session has recorded a turn the baseline is only
    /// remembered (no commit, no ref); once it has a chain of snapshots a
    /// refreshed baseline is committed onto it, so that chain stays exact.
    pub fn ensure_baseline(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        cwd: &Path,
    ) -> Result<SnapshotOutcome, String> {
        self.ensure_baseline_at(db, session_id, cwd, None)
    }

    /// `ensure_baseline` for a turn that started at `turn_started_at` (ms).
    /// The start is reported after the fact (the agent's hook, then the
    /// app), so an agent can already be at work when it arrives: when a file
    /// that moved since the last snapshot was written at or after the start,
    /// the baseline is left as it was, so the turn's own edits stay the
    /// turn's.
    pub fn ensure_baseline_at(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        cwd: &Path,
        turn_started_at: Option<i64>,
    ) -> Result<SnapshotOutcome, String> {
        if !self.active(db) {
            return Ok(SnapshotOutcome::Disabled);
        }
        let Some(repo) = Repo::discover(cwd) else {
            return Ok(SnapshotOutcome::NotARepo);
        };
        let lane = self.lane(&repo.lane_key());
        let _flight = lane.lock().unwrap_or_else(|p| p.into_inner());
        let state = self.session_state(db, session_id, &repo);
        if self.is_degraded(&repo) {
            return Ok(SnapshotOutcome::NoChange);
        }
        let tree = match repo.write_tree(BASELINE_BUDGET)? {
            WriteTree::Tree(t) => t,
            WriteTree::TooSlow { elapsed } => {
                log::warn!(
                    "[turn-ledger] baseline of {} took over {elapsed:?}; summaries only from now on",
                    repo.root.display()
                );
                self.mark_degraded(&repo);
                return Ok(SnapshotOutcome::NoChange);
            }
        };
        if state.last_tree.as_deref() == Some(tree.as_str()) {
            return Ok(SnapshotOutcome::NoChange);
        }
        if let (Some(at), Some(last)) = (turn_started_at, state.last_tree.as_deref()) {
            if written_since(&repo, last, &tree, at) {
                return Ok(SnapshotOutcome::NoChange);
            }
        }
        let Some(parent) = state.last_commit.clone() else {
            // No turn recorded yet: the repository stays untouched.
            self.remember_baseline(session_id, &tree, None);
            return Ok(SnapshotOutcome::NoChange);
        };
        let commit = repo.commit_tree(
            &tree,
            Some(&parent),
            &format!("Hermes baseline for session {session_id}"),
        )?;
        repo.update_ref(&base_ref(session_id), &commit)?;
        self.remember_baseline(session_id, &tree, Some(&commit));
        Ok(SnapshotOutcome::NoChange)
    }

    /// Snapshot the worktree at the end of a turn.
    pub fn record_turn(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        cwd: &Path,
        started_at: Option<i64>,
        ended_at: i64,
    ) -> Result<SnapshotOutcome, String> {
        if !self.active(db) {
            self.dequeue_turn_end(session_id);
            return Ok(SnapshotOutcome::Disabled);
        }
        if turn_ref(session_id, 1).is_none() {
            self.dequeue_turn_end(session_id);
            return Err(format!("not a session id: {session_id:?}"));
        }
        let Some(repo) = Repo::discover(cwd) else {
            self.dequeue_turn_end(session_id);
            return Ok(SnapshotOutcome::NotARepo);
        };
        let lane = self.lane(&repo.lane_key());
        let _flight = lane.lock().unwrap_or_else(|p| p.into_inner());
        // From here on this worker owns the snapshot: a turn end arriving
        // now queues a new one, which will run after this one.
        self.dequeue_turn_end(session_id);
        let state = self.session_state(db, session_id, &repo);
        let started_at = started_at.or(state.turn_started_at).unwrap_or(ended_at);

        let was_degraded = self.is_degraded(&repo);
        if was_degraded && !self.degraded_retry_due(&repo) {
            return self.record_summary(db, &repo, session_id, started_at, ended_at);
        }
        let tree = match repo.write_tree(self.budget())? {
            WriteTree::Tree(t) => t,
            WriteTree::TooSlow { elapsed } => {
                log::warn!(
                    "[turn-ledger] snapshot of {} took over {elapsed:?}; summaries only for the next {RETRY_AFTER_TURNS} turns",
                    repo.root.display()
                );
                self.mark_degraded(&repo);
                return self.record_summary(db, &repo, session_id, started_at, ended_at);
            }
        };
        if was_degraded {
            log::info!(
                "[turn-ledger] snapshots of {} are back inside the budget",
                repo.root.display()
            );
            self.clear_degraded(&repo);
        }
        let before_tree = match state.last_tree.clone() {
            Some(t) => t,
            None => match repo.tree_of("HEAD") {
                Some(t) => t,
                None => repo.empty_tree()?,
            },
        };
        if tree == before_tree {
            self.with_session(session_id, |s| s.turn_started_at = None);
            return Ok(SnapshotOutcome::NoChange);
        }
        // The review files Hermes writes for the person while the agent
        // works (`.hermes/features/<slug>/review-<n>.md`) are not the
        // agent's: they go into the baseline the turn is diffed against.
        let hermes_paths: Vec<String> = repo
            .paths_between(&before_tree, &tree)?
            .into_iter()
            .filter(|p| is_hermes_review_file(p))
            .collect();
        let agent_before = if hermes_paths.is_empty() {
            before_tree.clone()
        } else {
            repo.graft(&before_tree, &tree, &hermes_paths)?
        };
        // The first change this session records: its baseline (kept in
        // memory until now) becomes the root of the chain, so the diff of
        // turn 1 is against the worktree as the session found it.
        let mut parent = match (state.last_commit.clone(), state.last_tree.as_deref()) {
            (Some(c), _) => Some(c),
            (None, Some(_)) if agent_before == tree => {
                // Only Hermes's files moved, and nothing was recorded yet.
                self.remember_baseline(session_id, &tree, None);
                self.with_session(session_id, |s| s.turn_started_at = None);
                return Ok(SnapshotOutcome::NoChange);
            }
            (None, Some(base_tree)) => {
                let head = repo.rev_parse("HEAD");
                let base = repo.commit_tree(
                    base_tree,
                    head.as_deref(),
                    &format!("Hermes baseline for session {session_id}"),
                )?;
                repo.update_ref(&base_ref(session_id), &base)?;
                Some(base)
            }
            (None, None) => repo.rev_parse("HEAD"),
        };
        if agent_before != before_tree {
            let base = repo.commit_tree(
                &agent_before,
                parent.as_deref(),
                &format!("Hermes baseline for session {session_id} (review files)"),
            )?;
            repo.update_ref(&base_ref(session_id), &base)?;
            if agent_before == tree {
                self.remember_baseline(session_id, &tree, Some(&base));
                self.with_session(session_id, |s| s.turn_started_at = None);
                return Ok(SnapshotOutcome::NoChange);
            }
            parent = Some(base);
        }
        let before_tree = agent_before;
        let n = {
            let d = db.lock().map_err(|_| "database lock poisoned")?;
            store::max_n(&d, session_id)? + 1
        };
        let git_ref = turn_ref(session_id, n).ok_or("turn ref")?;
        let commit = repo.commit_tree(
            &tree,
            parent.as_deref(),
            &format!("Hermes turn {n} for session {session_id}"),
        )?;
        repo.update_ref(&git_ref, &commit)?;
        let diffstat = repo.diffstat(&before_tree, &tree)?;
        let turn = Turn {
            session_id: session_id.to_string(),
            n,
            git_ref,
            started_at,
            ended_at: Some(ended_at),
            diffstat,
            degraded: false,
            checks: None,
        };
        {
            let d = db.lock().map_err(|_| "database lock poisoned")?;
            store::insert_turn(&d, &turn)?;
        }
        self.remember(session_id, &tree, &commit);
        Ok(SnapshotOutcome::Recorded(turn))
    }

    fn record_summary(
        &self,
        db: &Mutex<Database>,
        repo: &Repo,
        session_id: &str,
        started_at: i64,
        ended_at: i64,
    ) -> Result<SnapshotOutcome, String> {
        let diffstat = repo.summary_diffstat();
        let d = db.lock().map_err(|_| "database lock poisoned")?;
        let n = store::max_n(&d, session_id)? + 1;
        let turn = Turn {
            session_id: session_id.to_string(),
            n,
            git_ref: String::new(),
            started_at,
            ended_at: Some(ended_at),
            diffstat,
            degraded: true,
            checks: None,
        };
        store::insert_turn(&d, &turn)?;
        drop(d);
        self.with_session(session_id, |s| s.turn_started_at = None);
        Ok(SnapshotOutcome::Degraded(turn))
    }

    /// The unified diff of one turn: its tree against the snapshot before it.
    pub fn turn_diff(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        n: u32,
        cwd: Option<&Path>,
    ) -> Result<Option<TurnDiff>, String> {
        let turn = {
            let d = db.lock().map_err(|_| "database lock poisoned")?;
            store::get_turn(&d, session_id, n)?
        };
        let Some(turn) = turn else {
            return Ok(None);
        };
        if turn.degraded {
            return Ok(Some(TurnDiff {
                turn,
                patch: String::new(),
            }));
        }
        let repo = cwd.and_then(Repo::discover);
        let Some(repo) = repo else {
            return Ok(Some(TurnDiff {
                turn,
                patch: String::new(),
            }));
        };
        let Some(commit) = repo.rev_parse(&turn.git_ref) else {
            return Ok(Some(TurnDiff {
                turn,
                patch: String::new(),
            }));
        };
        let tree = repo.tree_of(&commit).ok_or("turn tree")?;
        let before = match repo.parent_of(&commit).and_then(|p| repo.tree_of(&p)) {
            Some(t) => t,
            None => repo.empty_tree()?,
        };
        let patch = repo.patch(&before, &tree)?;
        Ok(Some(TurnDiff { turn, patch }))
    }

    /// What changed between turn `n - 1` and the start of turn `n` that no
    /// turn made (the person's edits, a restore, the review files Hermes
    /// wrote): the snapshot before turn `n` against turn `n - 1`'s. None for
    /// the first turn, a summary-only turn, or when nothing changed.
    pub fn between_turns(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        n: u32,
        cwd: &Path,
    ) -> Result<Option<BetweenTurns>, String> {
        if n < 2 {
            return Ok(None);
        }
        let (turn, prev) = {
            let d = db.lock().map_err(|_| "database lock poisoned")?;
            (
                store::get_turn(&d, session_id, n)?,
                store::get_turn(&d, session_id, n - 1)?,
            )
        };
        let (Some(turn), Some(prev)) = (turn, prev) else {
            return Ok(None);
        };
        if turn.degraded || prev.degraded {
            return Ok(None);
        }
        let Some(repo) = Repo::discover(cwd) else {
            return Ok(None);
        };
        let (Some(commit), Some(prev_commit)) =
            (repo.rev_parse(&turn.git_ref), repo.rev_parse(&prev.git_ref))
        else {
            return Ok(None);
        };
        let Some(start) = repo.parent_of(&commit) else {
            return Ok(None);
        };
        let (Some(start_tree), Some(prev_tree)) =
            (repo.tree_of(&start), repo.tree_of(&prev_commit))
        else {
            return Ok(None);
        };
        if start_tree == prev_tree {
            return Ok(None);
        }
        let diffstat = repo.diffstat(&prev_tree, &start_tree)?;
        let patch = repo.patch(&prev_tree, &start_tree)?;
        Ok(Some(BetweenTurns {
            before: n,
            patch,
            diffstat,
            at: prev.ended_at.unwrap_or(prev.started_at),
        }))
    }

    fn turn_target(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        n: u32,
        repo: &Repo,
    ) -> Result<Option<(Turn, String, String)>, String> {
        let turn = {
            let d = db.lock().map_err(|_| "database lock poisoned")?;
            store::get_turn(&d, session_id, n)?
        };
        let Some(turn) = turn else {
            return Ok(None);
        };
        if turn.degraded {
            return Err(format!("turn {n} has no snapshot (summary only)"));
        }
        let commit = repo
            .rev_parse(&turn.git_ref)
            .ok_or_else(|| format!("the snapshot of turn {n} is gone"))?;
        let tree = repo.tree_of(&commit).ok_or("turn tree")?;
        Ok(Some((turn, commit, tree)))
    }

    /// What restoring to turn `n` would change, without changing anything.
    pub fn preview_restore(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        n: u32,
        cwd: &Path,
    ) -> Result<Option<RestorePreview>, String> {
        let Some(repo) = Repo::discover(cwd) else {
            return Err("this session is not in a git repository".to_string());
        };
        let lane = self.lane(&repo.lane_key());
        let _flight = lane.lock().unwrap_or_else(|p| p.into_inner());
        let state = self.session_state(db, session_id, &repo);
        let Some((turn, _commit, target)) = self.turn_target(db, session_id, n, &repo)? else {
            return Ok(None);
        };
        let current = match repo.write_tree(BASELINE_BUDGET)? {
            WriteTree::Tree(t) => t,
            WriteTree::TooSlow { .. } => return Err("reading the worktree timed out".to_string()),
        };
        let patch = repo.patch(&current, &target)?;
        let diffstat = repo.diffstat(&current, &target)?;
        let set_aside = match state.last_tree.as_deref() {
            Some(last) if last != current => repo
                .paths_between(last, &current)?
                .into_iter()
                .filter(|p| !is_hermes_review_file(p))
                .collect(),
            _ => Vec::new(),
        };
        Ok(Some(RestorePreview {
            turn,
            patch,
            diffstat,
            set_aside,
        }))
    }

    /// Undo a restore: the worktree goes back to what restore `k` set aside
    /// (`refs/hermes/<session>/before-restore/<k>`), the person's edits
    /// included.
    pub fn undo_restore(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        k: u32,
        cwd: &Path,
    ) -> Result<RestoreResult, String> {
        let Some(repo) = Repo::discover(cwd) else {
            return Err("this session is not in a git repository".to_string());
        };
        let lane = self.lane(&repo.lane_key());
        let _flight = lane.lock().unwrap_or_else(|p| p.into_inner());
        let _ = self.session_state(db, session_id, &repo);
        let kept = repo
            .rev_parse(&before_restore_ref(session_id, k as usize))
            .ok_or_else(|| "what that restore set aside is gone".to_string())?;
        let target = repo.tree_of(&kept).ok_or("set-aside tree")?;
        let current = match repo.write_tree(BASELINE_BUDGET)? {
            WriteTree::Tree(t) => t,
            WriteTree::TooSlow { .. } => return Err("reading the worktree timed out".to_string()),
        };
        let files = repo.restore(&current, &target)?;
        self.remember(session_id, &target, &kept);
        Ok(RestoreResult {
            n: 0,
            files,
            set_aside: None,
        })
    }

    /// Make the worktree exactly the tree of turn `n`. The state before is
    /// kept in `refs/hermes/<session>/before-restore/<k>` (k counts up per
    /// restore) when it differs from the last snapshot.
    pub fn restore(
        &self,
        db: &Mutex<Database>,
        session_id: &str,
        n: u32,
        cwd: &Path,
    ) -> Result<Option<RestoreResult>, String> {
        let Some(repo) = Repo::discover(cwd) else {
            return Err("this session is not in a git repository".to_string());
        };
        let lane = self.lane(&repo.lane_key());
        let _flight = lane.lock().unwrap_or_else(|p| p.into_inner());
        let state = self.session_state(db, session_id, &repo);
        let Some((_turn, commit, target)) = self.turn_target(db, session_id, n, &repo)? else {
            return Ok(None);
        };
        let current = match repo.write_tree(BASELINE_BUDGET)? {
            WriteTree::Tree(t) => t,
            WriteTree::TooSlow { .. } => return Err("reading the worktree timed out".to_string()),
        };
        // What is there now is always kept (Undo brings it back): as its own
        // commit when it differs from the last snapshot, else that snapshot.
        let keep = match (state.last_tree.as_deref(), state.last_commit.clone()) {
            (Some(last), Some(c)) if last == current => c,
            _ => {
                let parent = state.last_commit.clone().or_else(|| repo.rev_parse("HEAD"));
                repo.commit_tree(
                    &current,
                    parent.as_deref(),
                    &format!("Hermes: worktree before restoring turn {n}"),
                )?
            }
        };
        let k = repo.refs_under(&before_restore_prefix(session_id)).len() + 1;
        repo.update_ref(&before_restore_ref(session_id, k), &keep)?;
        let files = repo.restore(&current, &target)?;
        self.remember(session_id, &target, &commit);
        Ok(Some(RestoreResult {
            n,
            files,
            set_aside: Some(k as u32),
        }))
    }
}

/// Delete the refs (and rows) of sessions closed at or before `cutoff`.
pub fn gc_expired(db: &Mutex<Database>, cutoff: &str) -> Result<GcReport, String> {
    let expired = {
        let d = db.lock().map_err(|_| "database lock poisoned")?;
        store::expired_sessions(&d, cutoff)?
    };
    let mut report = GcReport::default();
    for session in expired {
        let mut seen = HashSet::new();
        for dir in &session.candidates {
            let Some(repo) = Repo::discover(dir) else {
                continue;
            };
            if !seen.insert(repo.lane_key()) {
                continue;
            }
            for r in repo.refs_under(&format!("refs/hermes/{}/", session.session_id)) {
                match repo.delete_ref(&r) {
                    Ok(()) => report.refs += 1,
                    Err(e) => log::warn!("[turn-ledger] could not delete {r}: {e}"),
                }
            }
        }
        let d = db.lock().map_err(|_| "database lock poisoned")?;
        store::delete_turns(&d, &session.session_id)?;
        report.sessions += 1;
    }
    Ok(report)
}

/// The SQLite datetime text `GC_AFTER_DAYS` before now (UTC).
pub fn gc_cutoff_now() -> String {
    (chrono::Utc::now() - chrono::Duration::days(GC_AFTER_DAYS))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

// ─── Tauri glue ──────────────────────────────────────────────────────

/// The working directory of a session: the live one, else the saved one.
fn session_cwd(app: &AppHandle, session_id: &str) -> Option<PathBuf> {
    let state = app.try_state::<AppState>()?;
    let live = state
        .pty_manager
        .lock()
        .ok()
        .and_then(|m| m.sessions.get(session_id).map(|p| Arc::clone(&p.session)))
        .and_then(|s| s.lock().ok().map(|s| s.working_directory.clone()));
    if let Some(cwd) = live {
        return Some(PathBuf::from(cwd));
    }
    let saved: Option<String> = state.db.lock().ok().and_then(|d| {
        d.conn
            .query_row(
                "SELECT working_directory FROM sessions WHERE id = ?1",
                rusqlite::params![session_id],
                |r| r.get(0),
            )
            .ok()
    });
    saved.map(PathBuf::from)
}

fn emit(app: &AppHandle, event: TurnLedgerEvent) {
    if let Err(e) = app.emit(TURN_LEDGER_EVENT, &event) {
        log::warn!("[turn-ledger] could not emit: {e}");
    }
}

fn spawn_worker(app: &AppHandle, name: &'static str, f: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name(format!("turn-ledger-{name}"))
        .spawn(move || f(&app))
    {
        log::warn!("[turn-ledger] could not start the {name} worker: {e}");
    }
}

/// A session's job, run in the order it was asked for among that
/// session's jobs (see [`TurnLedger::take_ticket`]).
fn spawn_in_order(
    app: &AppHandle,
    ledger: &TurnLedger,
    session_id: &str,
    name: &'static str,
    f: impl FnOnce(&AppHandle, &AppState, &TurnLedger) + Send + 'static,
) {
    let ticket = ledger.take_ticket(session_id);
    let sid = session_id.to_string();
    let app2 = app.clone();
    let started = std::thread::Builder::new()
        .name(format!("turn-ledger-{name}"))
        .spawn(move || {
            let (Some(state), Some(ledger)) =
                (app2.try_state::<AppState>(), app2.try_state::<TurnLedger>())
            else {
                return;
            };
            let _turn = ledger.wait_ticket(&sid, ticket);
            f(&app2, &state, &ledger);
        });
    if let Err(e) = started {
        log::warn!("[turn-ledger] could not start the {name} worker: {e}");
        // Let the session's next job go.
        drop(ledger.wait_ticket(session_id, ticket));
    }
}

/// How long before a turn's reported start a write still counts as the
/// turn's (file times are coarse on some file systems).
const TURN_START_SLACK_MS: i64 = 1_000;

/// Whether a path that differs between `from` and `to` was written at or
/// after `at` (ms since the epoch, less the slack).
fn written_since(repo: &Repo, from: &str, to: &str, at: i64) -> bool {
    let Ok(paths) = repo.paths_between(from, to) else {
        return false;
    };
    paths.iter().any(|p| {
        std::fs::metadata(repo.root.join(p))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .is_some_and(|d| d.as_millis() as i64 >= at - TURN_START_SLACK_MS)
    })
}

/// A session got its terminal: take its baseline in the background.
pub fn on_session_started(app: &AppHandle, session_id: &str, cwd: &str) {
    let Some(ledger) = app.try_state::<TurnLedger>() else {
        return;
    };
    if !ledger.is_enabled() {
        return;
    }
    let sid = session_id.to_string();
    let cwd = PathBuf::from(cwd);
    spawn_in_order(
        app,
        &ledger,
        session_id,
        "baseline",
        move |_, state, ledger| {
            if let Err(e) = ledger.ensure_baseline(&state.db, &sid, &cwd) {
                log::warn!("[turn-ledger] baseline for {sid}: {e}");
            }
        },
    );
}

/// A turn began. `exact` when the agent itself said so. The worktree as it
/// is now becomes what the turn is diffed against: whatever changed since
/// the last turn (the person's edits) is never the agent's.
pub fn on_turn_started(app: &AppHandle, session_id: &str, at: i64, exact: bool) {
    let Some(ledger) = app.try_state::<TurnLedger>() else {
        return;
    };
    if !ledger.is_enabled() || !ledger.note_turn_started(session_id, at, exact) {
        return;
    }
    let Some(cwd) = session_cwd(app, session_id) else {
        return;
    };
    let sid = session_id.to_string();
    spawn_in_order(
        app,
        &ledger,
        session_id,
        "turn-start",
        move |_, state, ledger| {
            if let Err(e) = ledger.ensure_baseline_at(&state.db, &sid, &cwd, Some(at)) {
                log::warn!("[turn-ledger] baseline at turn start for {sid}: {e}");
            }
        },
    );
}

/// A turn ended: snapshot in the background and tell the frontend.
pub fn on_turn_ended(app: &AppHandle, session_id: &str, at: i64, exact: bool) {
    let Some(ledger) = app.try_state::<TurnLedger>() else {
        return;
    };
    if !ledger.is_enabled() || !ledger.accepts_turn_end(session_id, exact) {
        return;
    }
    let Some(cwd) = session_cwd(app, session_id) else {
        log::debug!("[turn-ledger] no working directory for {session_id}; nothing to snapshot");
        return;
    };
    if !ledger.queue_turn_end(session_id) {
        return;
    }
    let sid = session_id.to_string();
    spawn_in_order(
        app,
        &ledger,
        session_id,
        "turn-end",
        move |app, state, ledger| match ledger.record_turn(&state.db, &sid, &cwd, None, at) {
            Ok(SnapshotOutcome::Recorded(turn)) | Ok(SnapshotOutcome::Degraded(turn)) => {
                log::info!(
                    "[turn-ledger] {sid} turn {} ({} files, +{} -{}){}",
                    turn.n,
                    turn.diffstat.files,
                    turn.diffstat.insertions,
                    turn.diffstat.deletions,
                    if turn.degraded { ", summary only" } else { "" }
                );
                emit(
                    app,
                    TurnLedgerEvent {
                        session_id: sid,
                        turn: Some(turn),
                        restored_to: None,
                    },
                );
            }
            Ok(SnapshotOutcome::NoChange) => {
                log::debug!("[turn-ledger] {sid}: turn changed nothing")
            }
            Ok(SnapshotOutcome::NotARepo) => {
                log::debug!("[turn-ledger] {sid}: not a git repository")
            }
            Ok(SnapshotOutcome::Disabled) => {}
            Err(e) => log::warn!("[turn-ledger] snapshot for {sid} failed: {e}"),
        },
    );
}

/// The PTY heuristic: a session running an agent goes Busy -> Idle or
/// NeedsInput when the agent's turn ends; Idle -> Busy when one starts.
/// Called from the reader thread with what it already holds (never looks
/// the session up); only spawns work.
pub fn on_phase_change(
    app: &AppHandle,
    session_id: &str,
    cwd: &str,
    from: &SessionPhase,
    to: &SessionPhase,
    has_agent: bool,
) {
    if !has_agent {
        return;
    }
    let Some(ledger) = app.try_state::<TurnLedger>() else {
        return;
    };
    if !ledger.is_enabled() {
        return;
    }
    let at = now_ms();
    match phase_edge(from, to) {
        Some(PhaseEdge::TurnEnd) => {
            if !ledger.accepts_turn_end(session_id, false) || !ledger.queue_turn_end(session_id) {
                return;
            }
            let sid = session_id.to_string();
            let cwd = PathBuf::from(cwd);
            spawn_in_order(
                app,
                &ledger,
                session_id,
                "turn-end-guess",
                move |app, state, ledger| match ledger.record_turn(&state.db, &sid, &cwd, None, at)
                {
                    Ok(SnapshotOutcome::Recorded(turn)) | Ok(SnapshotOutcome::Degraded(turn)) => {
                        emit(
                            app,
                            TurnLedgerEvent {
                                session_id: sid,
                                turn: Some(turn),
                                restored_to: None,
                            },
                        )
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("[turn-ledger] guessed turn for {sid} failed: {e}"),
                },
            );
        }
        Some(PhaseEdge::TurnStart) => {
            // A guessed turn start takes the baseline too, like an exact
            // one: the person's edits since the last turn are theirs.
            if !ledger.note_turn_started(session_id, at, false) {
                return;
            }
            let sid = session_id.to_string();
            let cwd = PathBuf::from(cwd);
            spawn_in_order(
                app,
                &ledger,
                session_id,
                "turn-start-guess",
                move |_, state, ledger| {
                    if let Err(e) = ledger.ensure_baseline_at(&state.db, &sid, &cwd, Some(at)) {
                        log::warn!("[turn-ledger] baseline at a guessed turn start for {sid}: {e}");
                    }
                },
            );
        }
        None => {}
    }
}

/// What a PTY phase change means for an agent's turn (the heuristic of
/// [`on_phase_change`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PhaseEdge {
    /// Busy -> Idle or NeedsInput: the turn ended.
    TurnEnd,
    /// Anything else -> Busy: a turn started.
    TurnStart,
}

fn phase_edge(from: &SessionPhase, to: &SessionPhase) -> Option<PhaseEdge> {
    match (from, to) {
        (SessionPhase::Busy, SessionPhase::Idle)
        | (SessionPhase::Busy, SessionPhase::NeedsInput) => Some(PhaseEdge::TurnEnd),
        (from, SessionPhase::Busy) if !matches!(from, SessionPhase::Busy) => {
            Some(PhaseEdge::TurnStart)
        }
        _ => None,
    }
}

/// Collect the refs of sessions closed 14 days ago, off the startup path.
pub fn gc_at_startup(app: &AppHandle) {
    spawn_worker(app, "gc", |app| {
        std::thread::sleep(Duration::from_secs(20));
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        match gc_expired(&state.db, &gc_cutoff_now()) {
            Ok(r) if r.sessions > 0 => log::info!(
                "[turn-ledger] collected {} refs of {} closed sessions",
                r.refs,
                r.sessions
            ),
            Ok(_) => {}
            Err(e) => log::warn!("[turn-ledger] gc: {e}"),
        }
    });
}

// ─── Commands ────────────────────────────────────────────────────────

/// The frontend tells the backend whether the `turnLedger` flag is on.
#[tauri::command]
pub fn set_turn_ledger_enabled(app: AppHandle, ledger: State<'_, TurnLedger>, enabled: bool) {
    let was = ledger.is_enabled();
    ledger.set_enabled(enabled);
    if enabled && !was {
        // Sessions that already have a terminal get their baseline now.
        let live: Vec<(String, String)> = app
            .try_state::<AppState>()
            .and_then(|s| {
                s.pty_manager.lock().ok().map(|m| {
                    m.sessions
                        .iter()
                        .filter_map(|(id, p)| {
                            p.session
                                .lock()
                                .ok()
                                .map(|s| (id.clone(), s.working_directory.clone()))
                        })
                        .collect()
                })
            })
            .unwrap_or_default();
        for (sid, cwd) in live {
            on_session_started(&app, &sid, &cwd);
        }
        gc_at_startup(&app);
    }
}

#[tauri::command]
pub fn turn_ledger_turn_started(app: AppHandle, session_id: String, at: i64, exact: bool) {
    on_turn_started(&app, &session_id, at, exact);
}

#[tauri::command]
pub fn turn_ledger_turn_ended(app: AppHandle, session_id: String, at: i64, exact: bool) {
    on_turn_ended(&app, &session_id, at, exact);
}

/// Filled contract command: the turns of a session, oldest first.
pub fn list_turns_for(app: &AppHandle, session_id: &str) -> Result<Vec<Turn>, String> {
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(Vec::new());
    };
    let d = state.db.lock().map_err(|_| "database lock poisoned")?;
    store::list_turns(&d, session_id)
}

/// Filled contract command: the diff of one turn.
pub fn turn_diff_for(
    app: &AppHandle,
    session_id: &str,
    n: u32,
) -> Result<Option<TurnDiff>, String> {
    let (Some(state), Some(ledger)) = (app.try_state::<AppState>(), app.try_state::<TurnLedger>())
    else {
        return Ok(None);
    };
    let cwd = session_cwd(app, session_id);
    ledger.turn_diff(&state.db, session_id, n, cwd.as_deref())
}

#[tauri::command]
pub fn preview_restore_turn(
    app: AppHandle,
    ledger: State<'_, TurnLedger>,
    state: State<'_, AppState>,
    session_id: String,
    n: u32,
) -> Result<Option<RestorePreview>, String> {
    if turn_ref(&session_id, n).is_none() {
        return Err(format!("not a turn: {session_id:?} #{n}"));
    }
    let cwd = session_cwd(&app, &session_id).ok_or("unknown session")?;
    ledger.preview_restore(&state.db, &session_id, n, &cwd)
}

#[tauri::command]
pub fn restore_turn(
    app: AppHandle,
    ledger: State<'_, TurnLedger>,
    state: State<'_, AppState>,
    session_id: String,
    n: u32,
) -> Result<Option<RestoreResult>, String> {
    if turn_ref(&session_id, n).is_none() {
        return Err(format!("not a turn: {session_id:?} #{n}"));
    }
    let cwd = session_cwd(&app, &session_id).ok_or("unknown session")?;
    let result = ledger.restore(&state.db, &session_id, n, &cwd)?;
    if result.is_some() {
        emit(
            &app,
            TurnLedgerEvent {
                session_id,
                turn: None,
                restored_to: Some(n),
            },
        );
    }
    Ok(result)
}

/// Undo of a restore (the turn bar's Undo): back to what restore `k` set aside.
#[tauri::command]
pub fn undo_restore_turn(
    app: AppHandle,
    ledger: State<'_, TurnLedger>,
    state: State<'_, AppState>,
    session_id: String,
    k: u32,
) -> Result<RestoreResult, String> {
    if turn_ref(&session_id, 1).is_none() {
        return Err(format!("not a session id: {session_id:?}"));
    }
    let cwd = session_cwd(&app, &session_id).ok_or("unknown session")?;
    let result = ledger.undo_restore(&state.db, &session_id, k, &cwd)?;
    emit(
        &app,
        TurnLedgerEvent {
            session_id,
            turn: None,
            restored_to: None,
        },
    );
    Ok(result)
}

/// What changed before turn `n` that no turn made (the Review Desk's
/// "Between turns · you" row), or null.
#[tauri::command]
pub fn turn_ledger_between(
    app: AppHandle,
    ledger: State<'_, TurnLedger>,
    state: State<'_, AppState>,
    session_id: String,
    n: u32,
) -> Result<Option<BetweenTurns>, String> {
    if turn_ref(&session_id, n.max(1)).is_none() {
        return Err(format!("not a turn: {session_id:?} #{n}"));
    }
    let Some(cwd) = session_cwd(&app, &session_id) else {
        return Ok(None);
    };
    ledger.between_turns(&state.db, &session_id, n, &cwd)
}

#[cfg(test)]
mod tests {
    use super::snapshot::testing::{write, TestRepo};
    use super::store::testing::{insert_session, open_db};
    use super::*;
    use std::time::Instant;

    fn ledger() -> TurnLedger {
        let l = TurnLedger::default();
        l.set_enabled(true);
        l
    }

    fn recorded(o: SnapshotOutcome) -> Turn {
        match o {
            SnapshotOutcome::Recorded(t) => t,
            other => panic!("expected a recorded turn, got {other:?}"),
        }
    }

    #[test]
    fn now_is_the_wall_clock_in_milliseconds() {
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let now = now_ms();
        assert!(now >= before && now - before < 60_000, "{now} vs {before}");
    }

    #[test]
    fn a_turn_is_snapshotted_into_a_hidden_ref_and_a_row_without_touching_the_user_state() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        assert!(
            t.repo.refs_under("refs/hermes/").is_empty(),
            "a baseline alone writes nothing to the repository"
        );

        // What a shell `sed -i` does: rewrite a tracked file; plus a new file.
        write(t.root(), "src/app.txt", "hello world\n");
        write(t.root(), "notes/new.txt", "draft\n");
        let before = t.user_state();
        let turn = recorded(
            l.record_turn(&db, "s1", t.root(), Some(1000), 2000)
                .unwrap(),
        );
        assert_eq!(turn.n, 1);
        assert_eq!(turn.git_ref, "refs/hermes/s1/turn/1");
        assert_eq!((turn.started_at, turn.ended_at), (1000, Some(2000)));
        assert_eq!(
            turn.diffstat,
            Diffstat {
                files: 2,
                insertions: 2,
                deletions: 1
            }
        );
        assert!(!turn.degraded);
        assert_eq!(
            t.user_state(),
            before,
            "HEAD, the index, the status and the stash are as they were"
        );
        assert_eq!(t.git(&["branch", "--show-current"]), "main");

        let listed = store::list_turns(&db.lock().unwrap(), "s1").unwrap();
        assert_eq!(listed, vec![turn.clone()]);
        let diff = l.turn_diff(&db, "s1", 1, Some(t.root())).unwrap().unwrap();
        assert!(
            diff.patch.contains("-hello\n+hello world"),
            "{}",
            diff.patch
        );
        assert!(diff.patch.contains("+draft"), "{}", diff.patch);
        // The snapshot is chained onto the baseline (committed with this
        // first turn), which sits on HEAD.
        let base = t
            .repo
            .rev_parse("refs/hermes/s1/base")
            .expect("the baseline ref exists once a turn is recorded");
        assert_eq!(
            t.repo.parent_of(&t.repo.rev_parse(&turn.git_ref).unwrap()),
            Some(base.clone())
        );
        assert_eq!(t.repo.parent_of(&base), t.repo.rev_parse("HEAD"));
    }

    #[test]
    fn a_no_change_turn_creates_no_commit_and_no_row() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        assert_eq!(
            l.record_turn(&db, "s1", t.root(), None, 1).unwrap(),
            SnapshotOutcome::NoChange
        );
        assert!(t.repo.refs_under("refs/hermes/s1/turn/").is_empty());
        assert!(store::list_turns(&db.lock().unwrap(), "s1")
            .unwrap()
            .is_empty());
        write(t.root(), "src/app.txt", "changed\n");
        let one = recorded(l.record_turn(&db, "s1", t.root(), None, 2).unwrap());
        assert_eq!(one.n, 1);
        assert_eq!(
            l.record_turn(&db, "s1", t.root(), None, 3).unwrap(),
            SnapshotOutcome::NoChange
        );
        write(t.root(), "src/app.txt", "changed again\n");
        let two = recorded(l.record_turn(&db, "s1", t.root(), None, 4).unwrap());
        assert_eq!(two.n, 2);
        assert_eq!(t.repo.refs_under("refs/hermes/s1/turn/").len(), 2);
        // Turn 2's diff is only what turn 2 changed.
        let diff = l.turn_diff(&db, "s1", 2, Some(t.root())).unwrap().unwrap();
        assert!(
            diff.patch.contains("-changed\n+changed again"),
            "{}",
            diff.patch
        );
        assert!(!diff.patch.contains("-hello"), "{}", diff.patch);
    }

    #[test]
    fn a_session_that_never_records_a_turn_leaves_no_ref_behind() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        // A plain terminal session: opened, edited by a person, a turn
        // start guessed, a turn end that changed nothing, then closed.
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(t.root(), "README.md", "# edited by a person\n");
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        assert_eq!(
            l.record_turn(&db, "s1", t.root(), None, 1).unwrap(),
            SnapshotOutcome::NoChange
        );
        assert!(
            t.repo.refs_under("refs/hermes/").is_empty(),
            "no ref for a session without a recorded turn: {:?}",
            t.repo.refs_under("refs/hermes/")
        );
        assert!(store::list_turns(&db.lock().unwrap(), "s1")
            .unwrap()
            .is_empty());
        // The baseline still counts: the first real turn is diffed against
        // the worktree as it was at the last turn start, not against HEAD.
        write(t.root(), "src/app.txt", "by the agent\n");
        let turn = recorded(l.record_turn(&db, "s1", t.root(), None, 2).unwrap());
        assert_eq!(turn.diffstat.files, 1, "{:?}", turn.diffstat);
        let diff = l.turn_diff(&db, "s1", 1, Some(t.root())).unwrap().unwrap();
        assert!(!diff.patch.contains("README.md"), "{}", diff.patch);
        let mut refs = t.repo.refs_under("refs/hermes/s1/");
        refs.sort();
        assert_eq!(refs, vec!["refs/hermes/s1/base", "refs/hermes/s1/turn/1"]);
    }

    #[test]
    fn without_a_baseline_the_first_turn_is_diffed_against_head() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        write(t.root(), "src/app.txt", "hello world\n");
        let turn = recorded(l.record_turn(&db, "s1", t.root(), None, 5).unwrap());
        assert_eq!(turn.diffstat.files, 1);
        assert_eq!(
            t.repo.parent_of(&t.repo.rev_parse(&turn.git_ref).unwrap()),
            t.repo.rev_parse("HEAD")
        );
        assert_eq!(turn.started_at, 5, "no start known: the end time is used");
    }

    #[test]
    fn edits_between_turns_are_not_charged_to_the_next_turn() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(
            t.root(),
            "README.md",
            "# a person edited this between turns\n",
        );
        // A turn start refreshes the baseline...
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(t.root(), "src/app.txt", "hello world\n");
        let turn = recorded(l.record_turn(&db, "s1", t.root(), None, 9).unwrap());
        assert_eq!(
            turn.diffstat.files, 1,
            "only the turn's own change: {:?}",
            turn.diffstat
        );
        let diff = l.turn_diff(&db, "s1", 1, Some(t.root())).unwrap().unwrap();
        assert!(!diff.patch.contains("README.md"), "{}", diff.patch);
    }

    #[test]
    fn a_turn_start_reported_after_the_agent_began_keeps_its_edits() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        // The turn started a minute ago; its start reaches the ledger only
        // after the agent wrote this file.
        write(t.root(), "src/app.txt", "by the agent\n");
        l.ensure_baseline_at(&db, "s1", t.root(), Some(now - 60_000))
            .unwrap();
        let turn = recorded(l.record_turn(&db, "s1", t.root(), None, 9).unwrap());
        assert_eq!(turn.diffstat.files, 1, "{:?}", turn.diffstat);
        // An edit older than the start is still the person's.
        write(t.root(), "notes.txt", "mine\n");
        l.ensure_baseline_at(&db, "s1", t.root(), Some(now + 60_000))
            .unwrap();
        write(t.root(), "src/app.txt", "by the agent, turn 2\n");
        let two = recorded(l.record_turn(&db, "s1", t.root(), None, 10).unwrap());
        let diff = l.turn_diff(&db, "s1", 2, Some(t.root())).unwrap().unwrap();
        assert!(!diff.patch.contains("notes.txt"), "{}", diff.patch);
        assert_eq!(two.diffstat.files, 1, "{:?}", two.diffstat);
    }

    #[test]
    fn the_persons_edits_between_turns_are_their_own_row_and_never_a_turns() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(t.root(), "agent1.txt", "by the agent\n");
        recorded(l.record_turn(&db, "s1", t.root(), None, 1).unwrap());
        // Between turns: the person.
        write(t.root(), "person.txt", "mine\n");
        // Turn 2 starts (the baseline), the agent works.
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(t.root(), "agent2.txt", "by the agent\n");
        // Hermes writes a review file while the agent works.
        write(
            t.root(),
            ".hermes/features/demo/review-1.md",
            "# Review 1\n",
        );
        let two = recorded(l.record_turn(&db, "s1", t.root(), None, 2).unwrap());
        assert_eq!(two.diffstat.files, 1, "{:?}", two.diffstat);
        let diff = l.turn_diff(&db, "s1", 2, Some(t.root())).unwrap().unwrap();
        assert!(diff.patch.contains("agent2.txt"), "{}", diff.patch);
        assert!(!diff.patch.contains("person.txt"), "{}", diff.patch);
        assert!(!diff.patch.contains("review-1.md"), "{}", diff.patch);
        // The person's edit (and Hermes's file) are the "between turns" row.
        let between = l.between_turns(&db, "s1", 2, t.root()).unwrap().unwrap();
        assert_eq!(between.before, 2);
        assert!(between.patch.contains("person.txt"), "{}", between.patch);
        assert!(between.patch.contains("review-1.md"), "{}", between.patch);
        assert!(!between.patch.contains("agent2.txt"), "{}", between.patch);
        assert!(l.between_turns(&db, "s1", 1, t.root()).unwrap().is_none());
        // A turn that only Hermes's review file moved records nothing.
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(
            t.root(),
            ".hermes/features/demo/review-2.md",
            "# Review 2\n",
        );
        assert_eq!(
            l.record_turn(&db, "s1", t.root(), None, 3).unwrap(),
            SnapshotOutcome::NoChange
        );
        // No edit between turns: no row.
        write(t.root(), "agent3.txt", "x\n");
        recorded(l.record_turn(&db, "s1", t.root(), None, 4).unwrap());
        assert!(l.between_turns(&db, "s1", 3, t.root()).unwrap().is_some());
        assert!(is_hermes_review_file(".hermes/features/x/review-12.md"));
        assert!(!is_hermes_review_file(".hermes/features/x/plan.md"));
        assert!(!is_hermes_review_file("src/review-1.md"));
    }

    #[test]
    fn a_sessions_jobs_run_in_the_order_they_were_asked_for() {
        let l = Arc::new(ledger());
        let start = l.take_ticket("s1");
        let end = l.take_ticket("s1");
        let other = l.take_ticket("s2");
        let log = Arc::new(Mutex::new(Vec::new()));
        // The turn end's worker is scheduled first, but waits for the start.
        let (l2, log2) = (l.clone(), log.clone());
        let ender = std::thread::spawn(move || {
            let _g = l2.wait_ticket("s1", end);
            log2.lock().unwrap().push("end");
        });
        std::thread::sleep(Duration::from_millis(50));
        assert!(log.lock().unwrap().is_empty(), "the end waits");
        // Another session never waits for this one.
        drop(l.wait_ticket("s2", other));
        {
            let _g = l.wait_ticket("s1", start);
            log.lock().unwrap().push("start");
        }
        ender.join().unwrap();
        assert_eq!(*log.lock().unwrap(), vec!["start", "end"]);
    }

    #[test]
    fn the_chain_survives_a_restart_of_the_ledger() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(t.root(), "src/app.txt", "one\n");
        recorded(l.record_turn(&db, "s1", t.root(), None, 1).unwrap());
        // A new Hermes run: fresh in-memory state, same database and refs.
        let l2 = ledger();
        assert_eq!(
            l2.record_turn(&db, "s1", t.root(), None, 2).unwrap(),
            SnapshotOutcome::NoChange
        );
        write(t.root(), "src/app.txt", "two\n");
        let turn = recorded(l2.record_turn(&db, "s1", t.root(), None, 3).unwrap());
        assert_eq!(turn.n, 2);
        let diff = l2.turn_diff(&db, "s1", 2, Some(t.root())).unwrap().unwrap();
        assert!(diff.patch.contains("-one\n+two"), "{}", diff.patch);
    }

    #[test]
    fn a_slow_snapshot_degrades_that_worktree_to_summaries() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        for i in 0..300 {
            write(t.root(), &format!("many/f{i}.txt"), "x\n");
        }
        l.set_budget(Duration::from_nanos(1));
        let turn = match l.record_turn(&db, "s1", t.root(), None, 1).unwrap() {
            SnapshotOutcome::Degraded(t) => t,
            other => panic!("expected a degraded turn, got {other:?}"),
        };
        assert!(turn.degraded && turn.git_ref.is_empty());
        assert_eq!(
            turn.diffstat.files, 300,
            "the summary still says how much changed"
        );
        assert!(
            t.repo.refs_under("refs/hermes/s1/turn/").is_empty(),
            "no snapshot ref"
        );
        assert!(l.is_degraded(&t.repo));
        // The worktree stays degraded for the next turns even with a
        // generous budget now: no `git add` is even tried.
        l.set_budget(Duration::from_secs(30));
        for n in 2..=RETRY_AFTER_TURNS {
            write(t.root(), "src/app.txt", &format!("more {n}\n"));
            assert!(
                matches!(l.record_turn(&db, "s1", t.root(), None, n as i64).unwrap(), SnapshotOutcome::Degraded(t) if t.n == n),
                "turn {n} is a summary"
            );
        }
        let diff = l.turn_diff(&db, "s1", 2, Some(t.root())).unwrap().unwrap();
        assert_eq!(diff.patch, "", "a summary turn has no patch");
        assert!(
            l.preview_restore(&db, "s1", 2, t.root()).is_err(),
            "a summary turn cannot be restored"
        );
        // Another worktree is unaffected.
        let u = TestRepo::new();
        write(u.root(), "src/app.txt", "elsewhere\n");
        assert!(matches!(
            l.record_turn(&db, "s2", u.root(), None, 1).unwrap(),
            SnapshotOutcome::Recorded(_)
        ));
        // After RETRY_AFTER_TURNS summaries a full snapshot is tried again;
        // it fits the budget now, so the worktree is back to snapshots and
        // that turn's diff covers everything since the last real one.
        write(t.root(), "src/app.txt", "recovered\n");
        let back = recorded(l.record_turn(&db, "s1", t.root(), None, 99).unwrap());
        assert_eq!(back.n, RETRY_AFTER_TURNS + 1);
        assert!(!l.is_degraded(&t.repo));
        assert_eq!(back.diffstat.files, 301, "{:?}", back.diffstat);
        let diff = l
            .turn_diff(&db, "s1", back.n, Some(t.root()))
            .unwrap()
            .unwrap();
        assert!(diff.patch.contains("+recovered"), "{}", diff.patch);
        write(t.root(), "src/app.txt", "and on\n");
        assert!(matches!(
            l.record_turn(&db, "s1", t.root(), None, 100).unwrap(),
            SnapshotOutcome::Recorded(t) if t.diffstat.files == 1
        ));
        // A retry that is still too slow keeps the worktree degraded for
        // another RETRY_AFTER_TURNS turns.
        l.set_budget(Duration::from_nanos(1));
        write(t.root(), "src/app.txt", "slow again\n");
        assert!(matches!(
            l.record_turn(&db, "s1", t.root(), None, 101).unwrap(),
            SnapshotOutcome::Degraded(_)
        ));
        l.set_budget(Duration::from_secs(30));
        for i in 0..(RETRY_AFTER_TURNS - 1) {
            write(t.root(), "src/app.txt", &format!("still {i}\n"));
            assert!(matches!(
                l.record_turn(&db, "s1", t.root(), None, 102 + i as i64)
                    .unwrap(),
                SnapshotOutcome::Degraded(_)
            ));
        }
        write(t.root(), "src/app.txt", "back again\n");
        assert!(matches!(
            l.record_turn(&db, "s1", t.root(), None, 200).unwrap(),
            SnapshotOutcome::Recorded(_)
        ));
    }

    #[test]
    fn restore_previews_then_restores_exactly_the_turns_tree_and_keeps_what_was_there() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(t.root(), "src/app.txt", "turn one\n");
        recorded(l.record_turn(&db, "s1", t.root(), None, 1).unwrap());
        write(t.root(), "src/app.txt", "turn two\n");
        write(t.root(), "notes/new.txt", "from turn two\n");
        recorded(l.record_turn(&db, "s1", t.root(), None, 2).unwrap());
        write(t.root(), "src/app.txt", "turn three\n");
        std::fs::remove_file(t.root().join("README.md")).unwrap();
        let three = recorded(l.record_turn(&db, "s1", t.root(), None, 3).unwrap());
        // An edit after the last turn, so "before-restore" has something to keep.
        write(t.root(), "src/app.txt", "after three\n");
        let user_before = t.user_state();

        let preview = l.preview_restore(&db, "s1", 1, t.root()).unwrap().unwrap();
        assert_eq!(preview.turn.n, 1);
        assert!(
            preview.patch.contains("-after three\n+turn one"),
            "{}",
            preview.patch
        );
        assert!(
            preview.patch.contains("-from turn two"),
            "{}",
            preview.patch
        );
        assert_eq!(preview.diffstat.files, 3);
        assert_eq!(
            std::fs::read_to_string(t.root().join("src/app.txt")).unwrap(),
            "after three\n",
            "a preview changes nothing"
        );
        assert!(l.preview_restore(&db, "s1", 9, t.root()).unwrap().is_none());

        assert_eq!(
            preview.set_aside,
            vec!["src/app.txt".to_string()],
            "the edit no turn made is named"
        );
        let result = l.restore(&db, "s1", 1, t.root()).unwrap().unwrap();
        assert_eq!(
            result,
            RestoreResult {
                n: 1,
                files: 3,
                set_aside: Some(1)
            }
        );
        assert_eq!(
            std::fs::read_to_string(t.root().join("src/app.txt")).unwrap(),
            "turn one\n"
        );
        assert!(!t.root().join("notes/new.txt").exists());
        assert!(t.root().join("README.md").exists());
        let WriteTree::Tree(now) = t.repo.write_tree(DEFAULT_BUDGET).unwrap() else {
            panic!()
        };
        assert_eq!(
            Some(now),
            t.repo
                .tree_of(&t.repo.rev_parse("refs/hermes/s1/turn/1").unwrap()),
            "exactly the T1 tree"
        );
        let user_after = t.user_state();
        assert_eq!(user_after.head, user_before.head);
        assert_eq!(user_after.index, user_before.index);
        assert_eq!(user_after.stash, user_before.stash);
        let kept = t
            .repo
            .rev_parse("refs/hermes/s1/before-restore/1")
            .expect("the pre-restore state is kept");
        assert!(t
            .repo
            .patch(
                &t.repo
                    .tree_of(&t.repo.rev_parse(&three.git_ref).unwrap())
                    .unwrap(),
                &t.repo.tree_of(&kept).unwrap()
            )
            .unwrap()
            .contains("+after three"));
        // The next turn is diffed against the restored tree and keeps counting.
        write(t.root(), "src/app.txt", "turn four\n");
        let four = recorded(l.record_turn(&db, "s1", t.root(), None, 4).unwrap());
        assert_eq!(four.n, 4);
        let diff = l.turn_diff(&db, "s1", 4, Some(t.root())).unwrap().unwrap();
        assert!(
            diff.patch.contains("-turn one\n+turn four"),
            "{}",
            diff.patch
        );
        // A second restore keeps its own pre-restore state; the first one's
        // is still there.
        write(t.root(), "src/app.txt", "after four\n");
        let result = l.restore(&db, "s1", 3, t.root()).unwrap().unwrap();
        assert_eq!(result.n, 3);
        assert_eq!(
            std::fs::read_to_string(t.root().join("src/app.txt")).unwrap(),
            "turn three\n"
        );
        assert!(!t.root().join("README.md").exists(), "exactly the T3 tree");
        let mut kept_refs = t.repo.refs_under("refs/hermes/s1/before-restore/");
        kept_refs.sort();
        assert_eq!(
            kept_refs,
            vec![
                "refs/hermes/s1/before-restore/1",
                "refs/hermes/s1/before-restore/2"
            ]
        );
        assert_eq!(
            t.repo.rev_parse("refs/hermes/s1/before-restore/1"),
            Some(kept),
            "the first pre-restore state was not overwritten"
        );
        let kept2 = t.repo.rev_parse("refs/hermes/s1/before-restore/2").unwrap();
        assert!(t
            .repo
            .patch(
                &t.repo
                    .tree_of(&t.repo.rev_parse(&four.git_ref).unwrap())
                    .unwrap(),
                &t.repo.tree_of(&kept2).unwrap()
            )
            .unwrap()
            .contains("+after four"));
        // Restoring when the worktree already is the last snapshot keeps
        // that snapshot itself (no new commit), so Undo can go back to it.
        let again = l.restore(&db, "s1", 1, t.root()).unwrap().unwrap();
        assert_eq!(again.set_aside, Some(3));
        assert_eq!(
            t.repo.rev_parse("refs/hermes/s1/before-restore/3"),
            t.repo.rev_parse("refs/hermes/s1/turn/3"),
        );
        // Undo of the second restore brings "after four" back.
        l.undo_restore(&db, "s1", 2, t.root()).unwrap();
        assert_eq!(
            std::fs::read_to_string(t.root().join("src/app.txt")).unwrap(),
            "after four\n"
        );
        assert!(l.undo_restore(&db, "s1", 9, t.root()).is_err());
    }

    #[test]
    fn turn_end_workers_are_queued_once_per_session_until_the_snapshot_runs() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        assert!(l.queue_turn_end("s1"), "the first turn end queues a worker");
        assert!(
            !l.queue_turn_end("s1"),
            "a second turn end before the snapshot ran is folded into the first"
        );
        assert!(l.queue_turn_end("s2"), "another session has its own slot");
        write(t.root(), "src/app.txt", "x\n");
        recorded(l.record_turn(&db, "s1", t.root(), None, 1).unwrap());
        assert!(
            l.queue_turn_end("s1"),
            "once the snapshot ran the next turn end queues again"
        );
        // Every early exit frees the slot too.
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(
            l.record_turn(&db, "s1", plain.path(), None, 2).unwrap(),
            SnapshotOutcome::NotARepo
        );
        assert!(l.queue_turn_end("s1"));
        l.set_enabled(false);
        assert_eq!(
            l.record_turn(&db, "s1", t.root(), None, 3).unwrap(),
            SnapshotOutcome::Disabled
        );
        assert!(l.queue_turn_end("s1"));
    }

    #[test]
    fn the_kill_switches_stop_every_snapshot() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = TurnLedger::default();
        write(t.root(), "src/app.txt", "x\n");
        assert_eq!(
            l.record_turn(&db, "s1", t.root(), None, 1).unwrap(),
            SnapshotOutcome::Disabled,
            "flag off"
        );
        l.set_enabled(true);
        db.lock()
            .unwrap()
            .set_setting(KILL_SWITCH_SETTING, "off")
            .unwrap();
        assert_eq!(
            l.record_turn(&db, "s1", t.root(), None, 1).unwrap(),
            SnapshotOutcome::Disabled,
            "setting off"
        );
        assert_eq!(
            l.ensure_baseline(&db, "s1", t.root()).unwrap(),
            SnapshotOutcome::Disabled
        );
        assert!(t.repo.refs_under("refs/hermes/").is_empty());
        db.lock()
            .unwrap()
            .set_setting(KILL_SWITCH_SETTING, "on")
            .unwrap();
        assert!(matches!(
            l.record_turn(&db, "s1", t.root(), None, 1).unwrap(),
            SnapshotOutcome::Recorded(_)
        ));
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(
            l.record_turn(&db, "s1", plain.path(), None, 1).unwrap(),
            SnapshotOutcome::NotARepo
        );
        assert!(l.record_turn(&db, "no/slash", t.root(), None, 1).is_err());
    }

    #[test]
    fn guessed_turn_ends_are_ignored_once_the_agent_reports_exact_ones() {
        let l = ledger();
        assert!(
            l.accepts_turn_end("s1", false),
            "a guess counts while nothing exact was seen"
        );
        assert!(l.note_turn_started("s1", 1, false));
        assert!(l.accepts_turn_end("s1", true));
        assert!(
            !l.accepts_turn_end("s1", false),
            "after an exact end, guesses are ignored"
        );
        assert!(!l.note_turn_started("s1", 2, false));
        assert!(l.note_turn_started("s1", 3, true));
        assert!(
            l.accepts_turn_end("s2", false),
            "another session is judged on its own"
        );
    }

    #[test]
    fn a_large_repository_is_snapshotted_correctly_and_its_timing_reported() {
        let t = TestRepo::new();
        let files = 5000;
        for i in 0..files {
            write(
                t.root(),
                &format!("src/d{}/f{i}.txt", i % 100),
                &format!("line {i}\n"),
            );
        }
        t.git(&["add", "."]);
        t.git(&["commit", "-q", "-m", "big"]);
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        // The timing is informational (a loaded CI runner is not a laptop):
        // the budget here is generous, and the wall-clock is printed. The
        // 2 s fallback itself is covered by
        // a_slow_snapshot_degrades_that_worktree_to_summaries.
        l.set_budget(Duration::from_secs(60));
        let cold = Instant::now();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        let cold = cold.elapsed();
        write(t.root(), "src/d7/f7.txt", "edited\n");
        write(t.root(), "src/d7/new.txt", "new\n");
        let warm = Instant::now();
        let turn = recorded(l.record_turn(&db, "s1", t.root(), None, 1).unwrap());
        let warm = warm.elapsed();
        eprintln!(
            "[turn-ledger perf] {files} files: baseline {cold:?}, turn snapshot {warm:?} (target {DEFAULT_BUDGET:?})"
        );
        assert_eq!(turn.diffstat.files, 2);
        assert!(
            !turn.degraded,
            "a warm snapshot of {files} files fits a generous budget (took {warm:?})"
        );
        if warm >= DEFAULT_BUDGET {
            eprintln!(
                "[turn-ledger perf] NOTE: over the {DEFAULT_BUDGET:?} budget on this machine"
            );
        }
    }

    #[test]
    fn gc_deletes_the_refs_and_rows_of_sessions_closed_long_enough_ago() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let cwd = t.root().to_string_lossy().to_string();
        insert_session(&db, "old", &cwd, Some("2026-01-01 00:00:00"));
        insert_session(&db, "fresh", &cwd, Some("2026-09-27 00:00:00"));
        insert_session(&db, "open", &cwd, None);
        let db = Mutex::new(db);
        let l = ledger();
        for sid in ["old", "fresh", "open"] {
            l.ensure_baseline(&db, sid, t.root()).unwrap();
            write(t.root(), "src/app.txt", &format!("by {sid}\n"));
            recorded(l.record_turn(&db, sid, t.root(), None, 1).unwrap());
        }
        assert_eq!(
            t.repo.refs_under("refs/hermes/old/").len(),
            2,
            "base + turn"
        );
        let report = gc_expired(&db, "2026-09-14 00:00:00").unwrap();
        assert_eq!(
            report,
            GcReport {
                sessions: 1,
                refs: 2
            }
        );
        assert!(t.repo.refs_under("refs/hermes/old/").is_empty());
        assert_eq!(t.repo.refs_under("refs/hermes/fresh/").len(), 2);
        assert_eq!(t.repo.refs_under("refs/hermes/open/").len(), 2);
        let d = db.lock().unwrap();
        assert!(store::list_turns(&d, "old").unwrap().is_empty());
        assert_eq!(store::list_turns(&d, "fresh").unwrap().len(), 1);
        drop(d);
        // Running again finds nothing; a cutoff is a plain SQLite datetime.
        assert_eq!(
            gc_expired(&db, "2026-09-14 00:00:00").unwrap(),
            GcReport::default()
        );
        assert!(gc_cutoff_now().len() == 19);
    }

    #[test]
    fn a_pty_phase_change_ends_or_starts_a_turn_only_at_busy() {
        use SessionPhase::*;
        assert_eq!(phase_edge(&Busy, &Idle), Some(PhaseEdge::TurnEnd));
        assert_eq!(phase_edge(&Busy, &NeedsInput), Some(PhaseEdge::TurnEnd));
        assert_eq!(phase_edge(&Idle, &Busy), Some(PhaseEdge::TurnStart));
        assert_eq!(phase_edge(&NeedsInput, &Busy), Some(PhaseEdge::TurnStart));
        assert_eq!(phase_edge(&ShellReady, &Busy), Some(PhaseEdge::TurnStart));
        assert_eq!(phase_edge(&Busy, &Busy), None);
        assert_eq!(phase_edge(&Idle, &NeedsInput), None);
        assert_eq!(phase_edge(&Busy, &Closing), None);
        assert_eq!(phase_edge(&Idle, &Idle), None);
    }

    #[test]
    fn a_first_change_of_only_hermes_review_files_records_nothing() {
        let t = TestRepo::new();
        let (_d, db) = open_db();
        let db = Mutex::new(db);
        let l = ledger();
        l.ensure_baseline(&db, "s1", t.root()).unwrap();
        write(
            t.root(),
            ".hermes/features/demo/review-1.md",
            "# Review 1\n",
        );
        assert_eq!(
            l.record_turn(&db, "s1", t.root(), None, 1).unwrap(),
            SnapshotOutcome::NoChange
        );
        assert!(
            t.repo.refs_under("refs/hermes/").is_empty(),
            "no baseline commit for a change that was not the agent's"
        );
        // The agent's first real change is turn 1, without the review file.
        write(t.root(), "agent.txt", "x\n");
        let one = recorded(l.record_turn(&db, "s1", t.root(), None, 2).unwrap());
        assert_eq!((one.n, one.diffstat.files), (1, 1));
    }

    #[test]
    fn a_write_counts_for_a_turn_from_a_second_before_its_start() {
        let t = TestRepo::new();
        let tree = |r: &snapshot::Repo| match r.write_tree(Duration::from_secs(30)).unwrap() {
            snapshot::WriteTree::Tree(t) => t,
            other => panic!("{other:?}"),
        };
        let before = tree(&t.repo);
        write(t.root(), "new.txt", "x\n");
        let after = tree(&t.repo);
        let mtime = std::fs::metadata(t.root().join("new.txt"))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(written_since(&t.repo, &before, &after, mtime));
        assert!(written_since(
            &t.repo,
            &before,
            &after,
            mtime + TURN_START_SLACK_MS / 2
        ));
        assert!(written_since(
            &t.repo,
            &before,
            &after,
            mtime + TURN_START_SLACK_MS
        ));
        assert!(!written_since(
            &t.repo,
            &before,
            &after,
            mtime + TURN_START_SLACK_MS + 1
        ));
        // Nothing differs: nothing was written.
        assert!(!written_since(&t.repo, &after, &after, 0));
    }
}
