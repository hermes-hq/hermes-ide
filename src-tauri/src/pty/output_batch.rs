//! Terminal output batching (F24, fleetPerf flag).
//!
//! Every event the backend sends to the web view is a script the UI thread
//! has to run. A PTY hands its reader small pieces (about 1 KB on macOS), so
//! a command printing a lot of text turned into thousands of events a second
//! and the UI thread, not the terminal, set the pace. With batching on, the
//! pieces that arrive within a few milliseconds of each other go out as one
//! event: a burst of output costs a handful of events, while a single echo
//! still goes out after at most `QUIET` of silence.
//!
//! With batching off, every piece goes out on its own, as before.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

/// Set from the frontend when the fleetPerf flag is on.
static BATCHING: AtomicBool = AtomicBool::new(false);

pub fn set_batching(enabled: bool) {
    BATCHING.store(enabled, Ordering::Relaxed);
}

fn batching_enabled() -> bool {
    BATCHING.load(Ordering::Relaxed)
}

/// Silence that ends a batch.
const QUIET: Duration = Duration::from_millis(2);
/// The longest a batch may hold its first byte back (under a frame).
const MAX_WAIT: Duration = Duration::from_millis(12);
/// A batch is sent at this size even while output keeps coming.
const MAX_BYTES: usize = 256 * 1024;

enum Msg {
    Data(Vec<u8>),
    /// Send everything received so far, then answer.
    Flush(mpsc::Sender<()>),
}

/// Sends a session's output through `sink` from its own thread, batched
/// while the flag is on. Dropping it sends what is left and ends the thread.
pub struct OutputBatcher {
    tx: mpsc::Sender<Msg>,
}

impl OutputBatcher {
    pub fn spawn(sink: impl FnMut(&[u8]) + Send + 'static) -> Self {
        Self::spawn_with(sink, batching_enabled)
    }

    fn spawn_with(mut sink: impl FnMut(&[u8]) + Send + 'static, enabled: fn() -> bool) -> Self {
        let (tx, rx) = mpsc::channel::<Msg>();
        thread::spawn(move || {
            let mut buf: Vec<u8> = Vec::new();
            'outer: loop {
                // Wait for the first piece of the next batch.
                match rx.recv() {
                    Ok(Msg::Data(d)) => buf.extend_from_slice(&d),
                    Ok(Msg::Flush(ack)) => {
                        let _ = ack.send(());
                        continue;
                    }
                    Err(_) => break,
                }
                let batching = enabled();
                let started = Instant::now();
                let mut ack: Option<mpsc::Sender<()>> = None;
                let mut closed = false;
                while buf.len() < MAX_BYTES {
                    let next = if batching {
                        let left = MAX_WAIT.saturating_sub(started.elapsed());
                        if left.is_zero() {
                            break;
                        }
                        match rx.recv_timeout(QUIET.min(left)) {
                            Ok(m) => Some(m),
                            Err(RecvTimeoutError::Timeout) => None,
                            Err(RecvTimeoutError::Disconnected) => {
                                closed = true;
                                None
                            }
                        }
                    } else {
                        // Unbatched: one piece per event, as before.
                        None
                    };
                    match next {
                        Some(Msg::Data(d)) => buf.extend_from_slice(&d),
                        Some(Msg::Flush(a)) => {
                            ack = Some(a);
                            break;
                        }
                        None => break,
                    }
                }
                sink(&buf);
                buf.clear();
                if let Some(a) = ack {
                    let _ = a.send(());
                }
                if closed {
                    // Every sender is gone and the last batch went out.
                    break 'outer;
                }
            }
        });
        Self { tx }
    }

    pub fn push(&self, data: &[u8]) {
        let _ = self.tx.send(Msg::Data(data.to_vec()));
    }

    /// Wait (up to two seconds) until everything pushed so far has gone
    /// through the sink: the session's end must not overtake its output.
    pub fn flush(&self) {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.tx.send(Msg::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(Duration::from_secs(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn on() -> bool {
        true
    }
    fn off() -> bool {
        false
    }

    /// Every event the sink was given, in order.
    type Events = Arc<Mutex<Vec<Vec<u8>>>>;

    fn recorder() -> (Events, impl FnMut(&[u8]) + Send + 'static) {
        let out: Events = Arc::default();
        let sink_out = Arc::clone(&out);
        (out, move |b: &[u8]| {
            sink_out.lock().unwrap().push(b.to_vec())
        })
    }

    #[test]
    fn a_burst_goes_out_in_a_few_events_with_every_byte_in_order() {
        let (out, sink) = recorder();
        let b = OutputBatcher::spawn_with(sink, on);
        let mut expected = Vec::new();
        for i in 0..2000u32 {
            let piece = format!("line {i}\n").into_bytes();
            expected.extend_from_slice(&piece);
            b.push(&piece);
        }
        b.flush();
        let events = out.lock().unwrap().clone();
        assert_eq!(events.concat(), expected);
        assert!(
            events.len() < 20,
            "2000 pieces became {} events",
            events.len()
        );
    }

    #[test]
    fn a_lone_echo_goes_out_promptly() {
        let (out, sink) = recorder();
        let b = OutputBatcher::spawn_with(sink, on);
        let t = Instant::now();
        b.push(b"hello\r\n");
        while out.lock().unwrap().is_empty() {
            assert!(
                t.elapsed() < Duration::from_millis(500),
                "the echo never went out"
            );
            thread::sleep(Duration::from_millis(1));
        }
        assert!(
            t.elapsed() < Duration::from_millis(100),
            "took {:?}",
            t.elapsed()
        );
        assert_eq!(out.lock().unwrap().concat(), b"hello\r\n");
    }

    #[test]
    fn a_batch_never_exceeds_the_size_cap() {
        let (out, sink) = recorder();
        let b = OutputBatcher::spawn_with(sink, on);
        let piece = vec![b'x'; 64 * 1024];
        for _ in 0..16 {
            b.push(&piece);
        }
        b.flush();
        let events = out.lock().unwrap().clone();
        assert_eq!(events.iter().map(Vec::len).sum::<usize>(), 16 * 64 * 1024);
        assert!(events.iter().all(|e| e.len() <= MAX_BYTES + piece.len()));
        assert!(events.len() >= 4);
    }

    #[test]
    fn with_batching_off_every_piece_is_its_own_event() {
        let (out, sink) = recorder();
        let b = OutputBatcher::spawn_with(sink, off);
        for i in 0..50u8 {
            b.push(&[i]);
            b.flush();
        }
        let events = out.lock().unwrap().clone();
        assert_eq!(events.len(), 50);
        assert_eq!(events.concat(), (0..50u8).collect::<Vec<_>>());
    }

    #[test]
    fn flush_waits_for_pending_output_and_drop_sends_the_rest() {
        let (out, sink) = recorder();
        let b = OutputBatcher::spawn_with(sink, on);
        b.push(b"before exit");
        b.flush();
        assert_eq!(out.lock().unwrap().concat(), b"before exit");
        b.push(b" and after");
        drop(b);
        let t = Instant::now();
        while out.lock().unwrap().concat() != b"before exit and after" {
            assert!(t.elapsed() < Duration::from_secs(2), "the rest was lost");
            thread::sleep(Duration::from_millis(1));
        }
    }
}
