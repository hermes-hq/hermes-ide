//! Hermes session host (N20: sessions survive quit, update and crash).
//!
//! A small background process that owns terminals (PTYs) and the programs
//! running in them, so an agent keeps working while the Hermes window is
//! closed, the app updates or the app crashes. The app talks to it over a
//! user-only socket with a framed protocol (`protocol`), and the host keeps a
//! raw ring buffer of every session's output (`ring`) so a reattaching app
//! can replay what it missed.
//!
//! The host is deliberately dumb: no output analysis, no vendor knowledge,
//! no typing on its own. It spawns what it is told, forwards bytes both
//! ways, and exits when it has no sessions left.
//!
//! `server` is the host process itself and `client` the app-side connection;
//! both are Unix-only for now (macOS and Linux; Windows ConPTY is a follow-up).

pub mod protocol;
pub mod ring;

#[cfg(unix)]
pub mod client;
#[cfg(unix)]
pub mod server;

/// The host binary's own version, reported in every `HelloAck`.
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
