# Hermes IDE 1.2.5

The model picker, the permission chip, the effort selector — they
stay where you put them. Even when you switch sessions and come back.

## Your chips stay put

If you opened two Agent sessions, clicked between them a few times,
and watched the model picker / permission chip / effort selector
quietly disappear from your composer — leaving only the `Builder`,
`Terminal`, and `Attach` buttons — that's fixed.

The chips now reflect the actual state of each agent the moment you
look at them, regardless of how long ago the session was spawned or
how many times you've switched away. Plan-mode flips, manual model
swaps, and effort changes all show up immediately on whichever
session you're viewing.

## Why this kept happening

The chips read from a per-session snapshot that was reset every time
you switched, and the underlying signal that populates it only fires
once when the agent boots — so any session you didn't have visible
at boot time silently lost its chip data and never got it back until
the next respawn. The fix caches that snapshot per session and
restores it whenever the composer mounts.

That's all in 1.2.5. Same Agent mode, same branch isolation
guarantees from 1.2.3 — just no more vanishing chips.
