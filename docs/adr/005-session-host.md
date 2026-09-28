# ADR 005 — The session host: sessions survive quit, update and crash

**Status:** Accepted (behind the `sessionHost` feature flag; macOS and Linux)
**Date:** 2026-09-28
**Deciders:** Project lead
**Builds on:** [ADR 003](003-terminal-first-vendor-neutral.md) (terminal first; Hermes observes, never types), [ADR 004](004-2.0-contracts.md) (the 2.0 seams)

## Context

Today the app owns every terminal (the PTY master lives in the Hermes
process), so quitting, updating or crashing Hermes hangs up every agent
mid-turn. Vendor resume (N13) brings the conversation back but loses the turn
in flight. tmux was rejected for local use: it is a second terminal emulator
(it changes scrollback and passthrough), it is missing on Windows, and it is
not installed where Hermes runs.

## Decision

A small background process, **`hermes-pty-host`** (`src-tauri/pty-host`),
owns the PTYs and the programs in them. It is deliberately dumb: it spawns
what it is told, forwards bytes both ways, keeps a raw ring buffer (2 MiB)
of every session's output, and knows nothing about vendors. The output
analyzer, the events and the UI stay in the app.

### The seam: `PtyTransport`

`src-tauri/src/pty/transport.rs` defines where a session's terminal lives:

- `InProcessPty` — the PTY in this process, exactly as before (the default,
  and the only option on Windows for now).
- `HostedPty` — a session in the host, reached over a Unix socket.

Everything above the seam (`create_session`, the reader thread, write,
resize, close, the foreground probe) uses the trait only.

### The protocol

`[u32 length][u8 tag][payload]` frames over a Unix socket: tag 0 is one JSON
control message, tag 1 raw terminal bytes. A connection starts with
`Hello {token}` and is then a control connection (`Spawn`, `List`, `Kill`,
`KillAll`, `Ping`) or, after `Attach`, the live channel of one session: the
host replays the ring as data frames, streams live output, and sends
`Exited` when the program ends. Only one client is attached to a session at
a time; a new attach replaces the old one.

### Security

Anyone who can connect can type into an agent, so three checks: the socket
folder is `0700`, every connection presents the token from
`<data>/host/token` (`0600`), and the host checks the connecting process's
uid (`SO_PEERCRED` / `getpeereid`). The socket lives in a short folder keyed
by the data folder (Unix socket paths are limited to about 100 bytes, and a
test run's `TMPDIR` changes on every launch), so two Hermes instances never
share a host: `<root>/hermes-host-<uid>/<hash>/host.sock`, where the root
is the user's own runtime folder (`$XDG_RUNTIME_DIR` on Linux, the per-user
temp folder on macOS) and only without one the shared `/tmp`. Because a
shared root lets any local account create names there, every folder Hermes
owns on that path is created with mode `0700` and verified with `lstat`
before use — a real folder, not a symlink, owned by this uid, no group or
other bits — by the app and again by the host, and refused otherwise
(`pty-host/src/privdir.rs`). A socket that answers but cannot be used
(another protocol version, a bad token, a slow handshake) is never treated
as stale: the app reports it and opens the terminal in-process, so a newer
app can never unlink the socket of a host still running the user's agents.
Only a socket nobody listens on is removed and replaced.

### Lifecycle

- The host is started by the first session that needs it, **from a
  versioned copy** under `<data>/host/bin/<app version>-<hash>/`, never from
  the install folder, so an update can replace the app while the host runs.
  A protocol version, not the binary version, decides compatibility; the
  newer app reattaches to the host the older one started.
- The host exits on its own once it has no sessions (after a short grace),
  and removes its socket.
- On reattach the app replays the ring into the terminal (instead of the
  grey scrollback snapshot), then nudges a repaint by resizing one column
  narrower and back. It never types into the terminal. The analyzer starts
  with `shell_ready` and `context_injected` set so the replayed prompt can
  neither auto-launch the agent again nor type the context nudge. A program
  that ended while the app was away is reported through the ADR 004 event
  channel as `exit` (source `host`).
- Quitting with a hosted session whose agent is at work asks **keep running
  or stop**: the window's close button asks in the frontend before the
  window goes; an app quit (menu, ⌘Q, the test bridge) is held by the
  backend (`prevent_exit`) until the frontend's dialog answers through
  `session_host_quit`. With nothing working, hosted sessions end with the
  app as in-process ones always did. A crash or a force quit runs no handler,
  so the sessions survive — which is the point.

## Consequences

- New optional fields on the session shapes (additive, ADR 004 rules):
  `hosted` on `Session`/`SessionUpdate`/`SessionData`, `reattached` on
  `SessionUpdate`/`SessionData`; a new `session_host` argument on
  `create_session`; three commands `session_host_status`,
  `session_host_quit`, `session_host_stop_all`; one frontend event
  `session-host-quit-requested`.
- The Windows build ships no host: the flag falls back to an in-process
  terminal and the status reports `supported: false`. ConPTY cannot move
  between processes, so the Windows host is a follow-up (it also depends on
  a signed helper, F25).
- The rig proves it on the real app: `e2e/app/scenarios/N20-session-host.mjs`
  kills the app while a fake agent streams, relaunches, checks the same
  process is alive and its output continued, simulates an update (the same
  build reporting a newer version), and drives both answers of the quit
  question. `HERMES_E2E_N20_NEGATIVE=1` is its negative control.
