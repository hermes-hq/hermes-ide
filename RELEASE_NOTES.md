# Hermes IDE 2.2.8

This release fixes problems that build up when Hermes stays open for days or weeks.

## Fixes

- Pasting a lot of text into a terminal whose program isn't reading it no longer freezes the whole window when you resize, split or close that terminal.
- Cost and token totals no longer grow while a session sits open: each session's usage is counted once. Totals inflated by earlier versions are corrected on the first launch.
- Turn history snapshots from tasks that ran in their own worktree are now removed from the repository 14 days after the session closes, as promised.
- Hermes no longer slows down or uses up the system's file-watch limit when worktrees contain large dependency or build folders.
- A worktree you choose to keep when closing a session is no longer deleted automatically later.
- A worktree that could not be removed when its session closed is now retried at the next launch, and launching is faster when old leftover worktrees are lying around.
- A dropped or slow SSH connection no longer freezes the window.
- Hermes uses less CPU and battery in the background with many sessions open: git status and memory checks pause while the window is hidden, and idle agent sessions no longer cost more over time.
- On Linux, closing a terminal that left a background job running no longer keeps the background terminal service alive, so it picks up app updates again.
- Plugins that follow a session's transcript stop when the session closes, and closing many sessions no longer leaves data behind in memory.
- Prompt library updates resume after the system clock was briefly set ahead, and the library's local database no longer grows with every catalog update.
- Old data is now cleaned up over time: saved output of sessions closed more than a month ago, undo data for landed tasks after 14 days, worktree backups after 90 days (with automatic clean-up on), pasted screenshots older than a week, Agent view leftovers when a session closes, and the background terminal service's log.
- The review desk no longer fills browser storage over months of use, which could stop review progress and preferences from being saved.
