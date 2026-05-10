# Hermes IDE 1.1.12

A performance pass with two bug fixes you'll feel right away.

## New Session opens almost instantly

Clicking "New Session" used to wait roughly a second and a half before
the modal became fully visible and interactive. The cinematic gate has
been trimmed to a brief acknowledgement, and the work that doesn't
matter for the first frame — checking which AI tools are installed,
loading SSH history, scanning past sessions for group colours — only
runs once you've actually picked a path that needs it. The default
Agent flow now opens in a fraction of the old time.

## Bypass mode now works mid-session

Flipping the permission-mode chip into Bypass while a session was
already running would silently fail and the chip would snap back. The
session is now spawned with the capability to enter Bypass on demand,
so the flip takes effect immediately on the next turn. Sessions still
default to whatever permission mode they were created with — nothing
happens unless you ask for it.

## Faster, smoother long sessions

Long Agent conversations stay smooth even at hundreds of messages.
Off-screen messages no longer pay layout and paint cost while you
scroll through history. Streaming responses tax the layout pipeline
once per frame instead of once per token. The vintage thinking
indicator ticks at the cadence its readout actually requires —
tenths-of-a-second precision for the first ten seconds, integer
seconds after — instead of forcing ten redundant updates per second
on every active block.

## Snappier turn rendering

The conversation's turn-number gutter no longer recomputes from
scratch on every streaming token. File-edit diffs render once per
real input change instead of once per re-render. Streaming bash
output no longer attempts to pretty-print the partial buffer as JSON
on every chunk. Each fix is small on its own; together they take a
visible bite out of CPU during heavy turns.

## Database is quicker on every read and write

The local store now opens with desktop-tuned cache and mmap settings
and a relaxed-but-safe write mode under the existing journal. Four
missing indexes were added so the queries that drive the recent
sessions panel, the token-cost panel, and per-project filtering hit
the index instead of scanning. None of this changes how anything
looks; you'll just notice fewer little hitches.

## Better international keyboard input in the composer

Typing CJK characters or accented characters that go through an IME
composition (macOS dead keys, voice dictation, Chinese / Japanese /
Korean input methods) no longer stutters or drops partial codepoints.
The composer now waits for the composition to commit before
processing the input, instead of reacting to every transient codepoint
along the way.
