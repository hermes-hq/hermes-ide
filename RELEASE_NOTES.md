# Hermes IDE 1.3.2

A recovery release for the agent mode: when a conversation grows past
the model's context window, Hermes now tells you what happened and
gives you a one-step path out.

## You'll know when Claude can't continue

Previously, if a conversation hit "prompt is too long" — usually after
a multi-task workflow with a few large file reads or a long todo list
— the agent would simply stop responding with no explanation. The
chat looked frozen. The error was being recorded internally but
nothing surfaced it.

Now you get a clear red banner the moment it happens. It shows the
exact reason Claude returned, and when the cause is a context-window
overflow it points at the recovery commands so you don't have to
guess.

## `/compact` actually compacts the session

This is the headline fix. Before, typing `/compact` in agent mode
opened a separate embedded terminal that compacted a different
session entirely — so the conversation you cared about was never
touched, and you had no way back.

Now `/compact` runs against the live agent session over the same
channel as your normal messages. After it finishes, the conversation
continues from the summarised history. The same fix applies to
`/clear`, `/init`, and `/review` — all of these used to be misrouted
to the wrong place, and all of them now work where you'd expect.

## Cleaner feedback for the side-effect-only commands

`/compact` and `/clear` don't have anything conversational to say
back — their effect is internal. Previously you'd see a "Hermes: (no
content)" turn after sending one, which read as a broken response.

Now you see a small confirmation card with a brass checkmark — for
example, **✓ Compacted conversation — Older turns were summarised so
the session can continue.** Same shape for `/clear`, `/init`, and
`/review`.

## Subagents popover scrollbar is grabbable

The thin scrollbar on the conversation pane now fattens when you
hover directly on it and stays thin everywhere else. Earlier this
version of the redesign left the pill big for as long as the cursor
was anywhere in the conversation — now it shrinks back the moment you
move off the pill, so the timeline reads cleanly while you're
reading.
