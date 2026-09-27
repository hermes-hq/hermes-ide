//! Per-session spawn lock for Agent view.
//!
//! Without it, two restarts of one session (a double-clicked Retry, or a
//! message submit racing an interactive card's reply) each closed and spawned
//! on their own: two agent processes started, the first was killed a moment
//! later, and one of the two callers got an "already exists" error.
//!
//! [`SpawnGate`] gives every session one async lock. Anything that starts,
//! restarts or closes that session's process holds it, so those steps never
//! interleave. A plain restart that had to wait for another restart to finish
//! joins that restart's result instead of starting a second process.
//! It can only merge requests that overlap here; a second request that
//! arrives after the first restart finished is merged by the page instead
//! (`src/utils/respawnQueue.ts`), which knows both were meant as one.
//!
//! The gate is generic over the actual spawn / liveness check so the locking
//! rules are unit-tested with a counting fake instead of a real child.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use tokio::sync::Mutex;

/// Machine-readable kind of an agent command failure. The frontend adds the
/// kinds that only show up in the event stream (signed out, exited, protocol).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentErrorKind {
    /// The agent process could not be started (runtime missing, bad path,
    /// OS refused the spawn).
    SpawnFailed,
    /// The session already has a running agent process.
    Busy,
}

/// Error returned by the spawn / restart commands. Serialized to the
/// frontend as `{ "kind": "spawn_failed" | "busy", "message": "..." }`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentError {
    pub kind: AgentErrorKind,
    pub message: String,
}

impl AgentError {
    pub fn spawn_failed(message: impl Into<String>) -> Self {
        Self {
            kind: AgentErrorKind::SpawnFailed,
            message: message.into(),
        }
    }

    pub fn busy(session_id: &str) -> Self {
        Self {
            kind: AgentErrorKind::Busy,
            message: format!("The agent for session '{}' is already running", session_id),
        }
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for AgentError {
    fn from(message: String) -> Self {
        Self::spawn_failed(message)
    }
}

#[derive(Default)]
struct Slot {
    lock: Mutex<()>,
    /// Bumped every time a process is started for the session. A restart
    /// request remembers the value it saw on arrival; if it changed by the
    /// time the request holds the lock, somebody else restarted meanwhile.
    generation: AtomicU64,
}

/// One lock per session id. Slots are never removed: a slot is a few bytes,
/// and dropping one while a caller still waits on it would let a newcomer
/// take a second, unrelated lock for the same session.
#[derive(Default)]
pub struct SpawnGate {
    slots: StdMutex<HashMap<String, Arc<Slot>>>,
}

impl SpawnGate {
    fn slot(&self, session_id: &str) -> Arc<Slot> {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(slots.entry(session_id.to_string()).or_default())
    }

    /// Start the session's process unless it already has one.
    ///
    /// `live` returns the running process's agent session id, if any;
    /// `spawn` starts the process and returns its agent session id.
    pub async fn spawn<L, LF, S, SF>(
        &self,
        session_id: &str,
        live: L,
        spawn: S,
    ) -> Result<String, AgentError>
    where
        L: FnOnce() -> LF,
        LF: Future<Output = Option<String>>,
        S: FnOnce() -> SF,
        SF: Future<Output = Result<String, AgentError>>,
    {
        let slot = self.slot(session_id);
        let _guard = slot.lock.lock().await;
        if live().await.is_some() {
            return Err(AgentError::busy(session_id));
        }
        let out = spawn().await;
        if out.is_ok() {
            slot.generation.fetch_add(1, Ordering::SeqCst);
        }
        out
    }

    /// Stop the session's process (if any) and start a new one.
    ///
    /// With `coalesce`, a restart that waited behind another restart and
    /// finds the process that one started still running returns that
    /// process's id instead of replacing it. Callers pass `coalesce = false`
    /// when this restart carries new settings (a fork with a new model or
    /// permission mode), which must not be swallowed by a plain restart.
    pub async fn restart<L, LF, C, CF, S, SF>(
        &self,
        session_id: &str,
        coalesce: bool,
        live: L,
        close: C,
        spawn: S,
    ) -> Result<String, AgentError>
    where
        L: FnOnce() -> LF,
        LF: Future<Output = Option<String>>,
        C: FnOnce() -> CF,
        CF: Future<Output = ()>,
        S: FnOnce() -> SF,
        SF: Future<Output = Result<String, AgentError>>,
    {
        let slot = self.slot(session_id);
        let seen = slot.generation.load(Ordering::SeqCst);
        let _guard = slot.lock.lock().await;
        if coalesce && slot.generation.load(Ordering::SeqCst) != seen {
            if let Some(id) = live().await {
                return Ok(id);
            }
        }
        close().await;
        let out = spawn().await;
        if out.is_ok() {
            slot.generation.fetch_add(1, Ordering::SeqCst);
        }
        out
    }

    /// Run `f` while holding the session's lock, so a close never lands in
    /// the middle of a restart (which would leave the new process orphaned).
    pub async fn exclusive<F, FF, T>(&self, session_id: &str, f: F) -> T
    where
        F: FnOnce() -> FF,
        FF: Future<Output = T>,
    {
        let slot = self.slot(session_id);
        let _guard = slot.lock.lock().await;
        f().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    /// A fake agent runtime: counts started processes and tracks which one
    /// is live, with a delay inside spawn so concurrent callers overlap.
    #[derive(Default)]
    struct FakeRuntime {
        started: AtomicUsize,
        closed: AtomicUsize,
        live: StdMutex<Option<String>>,
    }

    impl FakeRuntime {
        async fn live(&self) -> Option<String> {
            self.live.lock().unwrap().clone()
        }
        async fn close(&self) {
            if self.live.lock().unwrap().take().is_some() {
                self.closed.fetch_add(1, Ordering::SeqCst);
            }
        }
        async fn spawn(&self) -> Result<String, AgentError> {
            // Yield so a second caller gets to run while this one is "starting".
            tokio::time::sleep(Duration::from_millis(30)).await;
            let n = self.started.fetch_add(1, Ordering::SeqCst) + 1;
            let id = format!("proc-{n}");
            *self.live.lock().unwrap() = Some(id.clone());
            Ok(id)
        }
        fn started(&self) -> usize {
            self.started.load(Ordering::SeqCst)
        }
    }

    async fn restart(
        gate: &SpawnGate,
        rt: &FakeRuntime,
        coalesce: bool,
    ) -> Result<String, AgentError> {
        gate.restart("s1", coalesce, || rt.live(), || rt.close(), || rt.spawn())
            .await
    }

    #[tokio::test]
    async fn two_concurrent_restarts_start_exactly_one_process() {
        let gate = SpawnGate::default();
        let rt = FakeRuntime::default();
        let (a, b) = tokio::join!(restart(&gate, &rt, true), restart(&gate, &rt, true));
        assert_eq!(rt.started(), 1, "exactly one process must be started");
        assert_eq!(a.unwrap(), "proc-1");
        assert_eq!(b.unwrap(), "proc-1", "the second restart joins the first");
        assert_eq!(rt.live().await.as_deref(), Some("proc-1"));
    }

    #[tokio::test]
    async fn many_concurrent_restarts_start_exactly_one_process() {
        let gate = SpawnGate::default();
        let rt = FakeRuntime::default();
        let calls: Vec<_> = (0..8).map(|_| restart(&gate, &rt, true)).collect();
        let results = futures_join_all(calls).await;
        assert_eq!(rt.started(), 1);
        assert!(results.iter().all(|r| r.as_deref() == Ok("proc-1")));
    }

    #[tokio::test]
    async fn without_coalescing_restarts_are_serialized_not_merged() {
        // A restart that carries new settings must really run, but never at
        // the same time as another one: one live process at the end, and
        // every close happened before the next spawn.
        let gate = SpawnGate::default();
        let rt = FakeRuntime::default();
        let (a, b) = tokio::join!(restart(&gate, &rt, false), restart(&gate, &rt, false));
        assert_eq!(rt.started(), 2);
        assert_eq!(
            rt.closed.load(Ordering::SeqCst),
            1,
            "the first process was closed before the second started"
        );
        assert_eq!(a.unwrap(), "proc-1");
        assert_eq!(b.unwrap(), "proc-2");
        assert_eq!(rt.live().await.as_deref(), Some("proc-2"));
    }

    #[tokio::test]
    async fn sequential_restarts_each_start_a_new_process() {
        // Coalescing only merges restarts that overlapped; a later Retry
        // (for example after the process crashed again) really restarts.
        let gate = SpawnGate::default();
        let rt = FakeRuntime::default();
        assert_eq!(restart(&gate, &rt, true).await.unwrap(), "proc-1");
        assert_eq!(restart(&gate, &rt, true).await.unwrap(), "proc-2");
        assert_eq!(rt.started(), 2);
    }

    #[tokio::test]
    async fn restart_after_the_joined_process_died_starts_a_new_one() {
        let gate = SpawnGate::default();
        let rt = FakeRuntime::default();
        let slow_first = async {
            let r = restart(&gate, &rt, true).await;
            // The process the first restart started dies right away.
            rt.close().await;
            r
        };
        let (a, b) = tokio::join!(slow_first, restart(&gate, &rt, true));
        assert_eq!(a.unwrap(), "proc-1");
        // The waiter found no live process to join, so it started its own.
        assert_eq!(b.unwrap(), "proc-2");
        assert_eq!(rt.started(), 2);
    }

    #[tokio::test]
    async fn spawn_while_running_is_busy_and_starts_nothing() {
        let gate = SpawnGate::default();
        let rt = FakeRuntime::default();
        let (a, b) = tokio::join!(
            gate.spawn("s1", || rt.live(), || rt.spawn()),
            gate.spawn("s1", || rt.live(), || rt.spawn()),
        );
        assert_eq!(rt.started(), 1);
        assert_eq!(a.unwrap(), "proc-1");
        let err = b.unwrap_err();
        assert_eq!(err.kind, AgentErrorKind::Busy);
        assert!(err.message.contains("already running"), "{}", err.message);
    }

    #[tokio::test]
    async fn failed_spawn_is_typed_and_does_not_count_as_a_restart() {
        let gate = SpawnGate::default();
        let rt = FakeRuntime::default();
        let err = gate
            .restart(
                "s1",
                true,
                || rt.live(),
                || rt.close(),
                || async { Err::<String, _>(AgentError::from("node not found".to_string())) },
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind, AgentErrorKind::SpawnFailed);
        assert_eq!(err.to_string(), "node not found");
        // A later restart is not mistaken for "someone already restarted".
        assert_eq!(restart(&gate, &rt, true).await.unwrap(), "proc-1");
    }

    #[tokio::test]
    async fn sessions_do_not_block_each_other() {
        let gate = SpawnGate::default();
        let rt_a = FakeRuntime::default();
        let rt_b = FakeRuntime::default();
        let (a, b) = tokio::join!(
            gate.restart("a", true, || rt_a.live(), || rt_a.close(), || rt_a.spawn()),
            gate.restart("b", true, || rt_b.live(), || rt_b.close(), || rt_b.spawn()),
        );
        assert_eq!(
            (a.unwrap(), b.unwrap()),
            ("proc-1".to_string(), "proc-1".to_string())
        );
        assert_eq!((rt_a.started(), rt_b.started()), (1, 1));
    }

    #[tokio::test]
    async fn close_waits_for_an_in_flight_restart() {
        // A close that arrives mid-restart must see (and stop) the new
        // process, not run before it exists and leave it orphaned.
        let gate = SpawnGate::default();
        let rt = FakeRuntime::default();
        let (r, ()) = tokio::join!(restart(&gate, &rt, true), async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            gate.exclusive("s1", || rt.close()).await
        });
        assert_eq!(r.unwrap(), "proc-1");
        assert_eq!(rt.live().await, None, "the restarted process was closed");
        assert_eq!(rt.closed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn error_serializes_as_kind_and_message() {
        let v = serde_json::to_value(AgentError::busy("s1")).unwrap();
        assert_eq!(v["kind"], "busy");
        assert!(v["message"].as_str().unwrap().contains("s1"));
        let v = serde_json::to_value(AgentError::spawn_failed("boom")).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "kind": "spawn_failed", "message": "boom" })
        );
    }

    /// Poll every future together until all are done (a join_all without
    /// pulling in the `futures` crate for tests).
    async fn futures_join_all<F: Future>(futs: Vec<F>) -> Vec<F::Output> {
        let mut pinned: Vec<_> = futs.into_iter().map(Box::pin).collect();
        let mut done: Vec<Option<F::Output>> = pinned.iter().map(|_| None).collect();
        std::future::poll_fn(|cx| {
            for (f, slot) in pinned.iter_mut().zip(done.iter_mut()) {
                if slot.is_none() {
                    if let std::task::Poll::Ready(v) = f.as_mut().poll(cx) {
                        *slot = Some(v);
                    }
                }
            }
            if done.iter().all(Option::is_some) {
                std::task::Poll::Ready(())
            } else {
                std::task::Poll::Pending
            }
        })
        .await;
        done.into_iter().map(|d| d.expect("finished")).collect()
    }
}
