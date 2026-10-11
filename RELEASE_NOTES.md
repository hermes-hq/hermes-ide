# Hermes IDE 2.2.4

## Fixes

### Terminal

- Pasting a few lines while a long command is running no longer freezes the whole window until that command ends, and Ctrl+C still stops the command.
- Pasting a large snippet while a command is running no longer freezes that terminal, other terminals, or the opening of new ones when sessions are kept running in the background.
- Emoji now take two columns, as the shell and agents expect, so the cursor no longer drifts on lines that contain them.
- zsh users who keep their config under ~/.config/zsh now get their prompt, aliases, PATH and plugins in Hermes terminals.
- On Linux, terminals no longer fall back to plain ASCII: accented file names and locale-aware tools work without "Setting locale failed" warnings.
- Switching to another app and back no longer moves your typing into the terminal while you are in the Library search, renaming a session, writing a commit message or searching.

### Git and review

- Switching branches from the Git panel now brings in that branch's files, instead of leaving the previous branch's files behind as staged changes.
- A push the server refuses, such as to a protected branch, is now reported as a failure with the server's reason, not as "Pushed".
- The stash list now refreshes when stashes change outside the panel, so Drop and Pop act on the stash you clicked.
- Pushing, committing with slow hooks, stashing and starting an isolated task no longer freeze the whole window while they run.
- On Windows, Git actions no longer flash a console window or steal focus from the terminal.
- Pull now refuses with a clear message when no branch is checked out, instead of moving the checked-out commit.
- After merging a task locally, you can still open a pull request for its branch.
- Feature files and worktree settings saved with a byte order mark, common with some Windows editors, can now be approved, skipped and checked.

### Editor and Agent view

- Editing a file whose line endings are mixed no longer rewrites every line to a single ending style.
- Saving while an autosave is still finishing no longer shows a false "changed on disk" warning.
- A permission prompt from a sub-agent working in the background no longer disappears when the main reply finishes.
- On Windows, closing an Agent view session or changing its model, permission mode or effort no longer flashes a console window.
- Permission rules and MCP servers save again when your Claude settings file is a link into a read-only folder.

### Spend and limits

- In Agent view, session spend no longer climbs faster than real spend with every prompt, so spend caps trip at the right amount.
- A spend cap now actually stops an Agent view session when it is reached, instead of only reporting it.
- Estimated spend for terminal Claude sessions now includes the work of sub-agents.
- After Hermes restarts or you resume an older conversation, estimated spend no longer starts at a partial figure from earlier work.
- The Cost Dashboard now shows the real total and the daily and per-provider breakdowns instead of $0.00.

### New tasks and the queue

- Tasks waiting in the queue when you reopen Hermes now wait for your restored agents and your running-agents limit, instead of all starting at once.
- Launching a task on two agents at once now respects the running-agents limit.
- Two queued tasks with similar names now get separate branches, so the second one no longer stops on a branch-in-use prompt.
- A queued task that fails to start now stays in the queue, marked, so you can retry or remove it instead of losing what you typed.
- Feature-tracked tasks written in scripts like Chinese, Japanese, Russian or Hindi each get their own planning files.
- Checks no longer run or count as failures while a Feature Track is still planning or waiting for your review.
- When a turn ends while checks are still running, its changes are now checked once the earlier run finishes.

### Worktrees and agents

- Worktree setup no longer hangs, or keeps the new session from opening, when a setup step starts a server in the background.
- Per-worktree ports now skip a port that a running dev server already uses.
- Worktree setup steps now run correctly for people whose login shell is fish.
- Starting Antigravity in a worktree no longer hides your own project hooks file from git, and no longer changes a hooks file your repository tracks.
- Codex installed through npm no longer asks you to review Hermes's hooks at every start when Hermes is opened from the Dock, and keeps your own notify program.
- On a second Claude account, Hermes now respects the status line you set for that account.
- Agent view's terminal for slash commands no longer shows broken symbols on large screens.

### App

- View > Toggle Fullscreen and F11 now work on Windows and Linux.
- Checking for plugin updates from the command palette now reports a found update or a failed check correctly.
- Switching sessions with Cmd/Ctrl+1–9 now works on French and Belgian AZERTY keyboards.
