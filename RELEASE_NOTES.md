# Hermes IDE 2.0.0

Hermes 2.0 is a vendor-neutral console for every coding agent, terminal first. Claude Code, Codex, Antigravity, GitHub Copilot, OpenCode, goose, Aider, Kiro, Hermes Agent or any command you add run in their own terminal interface, exactly as they run anywhere else, and Hermes supervises them all the same way: it starts them, tells you which one needs you, records what each turn changed and helps you review and land the result. Hermes follows what your agents report and never answers a prompt on their behalf. The Agent view for Claude stays available as an option. Hermes IDE is not affiliated with Nous Research or its Hermes Agent.

## Headline features

### Every agent, started and resumed the same way

- Hermes knows today's coding agents and how to install and sign in to each one, now including Antigravity CLI, GitHub Copilot CLI, OpenCode, goose and Hermes Agent.
- Add any other command-line agent as a **Custom agent**: it runs in a terminal and shows under its own name in the sidebar.
- Add more than one account for an agent: each signs in on its own, shows its own models and never borrows another account's sign-in.
- Every agent starts from one short line that is the same on every shell and OS, instead of its own launch command typed with shell-specific quoting.
- Quit and reopen Hermes and each agent continues its own conversation in its own folder; if an agent cannot resume, it says so in one line and starts fresh.
- When an agent refuses to start (a model your account does not have, or you are signed out), the session says why in the agent's own words and offers to retry, pick another model or sign in.
- An agent stuck at a "do you trust this folder?" prompt is marked as waiting at a startup prompt instead of stalling unseen.

### Know which agent needs you

- Hermes knows when each terminal agent needs approval, asks a question, finishes or fails, with nothing for you to set up.
- Every session shows one clear status (working, needs approval, asked you, done, error, idle) as a word and a symbol, dimmed when Hermes is only guessing.
- A badge in the title bar counts the agents blocked on you and opens an inbox of everything waiting, oldest first, where you can peek at each request before jumping to it.
- Press ⌘I to jump straight to the agent that has waited longest, and press it again to visit the next one. On Windows and Linux that is Ctrl+Shift+I, and Ctrl+Shift+A opens the inbox.
- Notifications arrive only when an agent is blocked on you or done, never for the session you are looking at, and your computer stays awake while an agent is working.
- Away from your desk, Hermes can send a short message to a web address you set up (for example ntfy or Telegram) with only the agent, the task and its state, never your prompts or code, including for the session you left in view once you have been away a while.
- The session header shows which model and permission mode each agent is using.

### Start a task in seconds

- Press ⌘N, describe the task and press Enter: an agent starts in a terminal on its own new branch with your task as its first prompt.
- The launcher keeps what you typed through a sign-in or a visit to Settings, remembers your usual agent and options for each project, and gives a repeated task the next free branch name instead of an error.
- A new task's dependencies are ready in seconds when they match your main checkout, and parallel dev servers get their own ports.
- A `.hermes/worktree.toml` file in your repository lists setup commands, files to copy such as `.env`, and a default check, and each new task runs it with a visible log.
- First launch takes three steps: see which agents are installed and signed in, pick a repository, launch a first task.
- Settings → Agents shows the same agent check at any time, with install and Sign in actions.

### Record, review, land

- Every agent turn is saved in git, including changes made through shell commands, without touching your branch, staged changes or stash, and your own edits between turns are never charged to an agent.
- A bar under the terminal shows what the last turn changed, with Diff and Restore; Restore shows a preview, says what it sets aside and offers Undo.
- The Review Desk (⌘G, Ctrl+Shift+G on Windows and Linux) shows everything an agent changed, by turn or by file, and sends your line comments back to the agent that wrote those lines.
- Revert a single turn after a preview, and see flags on risky changes such as lockfiles, CI workflows, secrets, new binaries and edits to an agent's own configuration.
- The Land sheet commits on the branch, opens a pull request or merges locally in one step, drafts the commit message from the task and the turns, and can undo afterwards. It lands into the branch the task started from and never over an edit you have not committed.
- Pull, Abort Merge and Discard keep your uncommitted work, and closing a task never deletes commits or unmerged branches without asking.
- Hermes's own commits run your repository's hooks, and a refusal is shown exactly as the hook said it.
- Your checks decide when an agent is done: the commands you list run at the end of each turn and before landing, a failing check shows on the session, and Claude is sent back to fix it, up to three times.
- Sessions whose recent turns touched the same files show an overlap badge, so you know before merging.

### Feature Tracks

- Bigger work can follow guided phases (questions, research, design, structure, plan, implement) kept as short markdown files in your repository that you review in your own editor.
- When a phase waits for your approval it appears in the inbox, and approving it moves the feature to the next phase. Only you can approve or skip a phase, and skipping asks first.
- Any agent can drive a track from its own terminal, and quick tasks create no extra files.

### Agents survive restarts and updates

- On macOS and Linux, agents keep running while Hermes quits, updates or crashes, and you reattach to them exactly where they were, with their status reports still flowing.
- Quitting while an agent is working, or a command is still running, asks whether to keep it running or stop it; with only queued tasks it says they are kept.
- If Hermes's background service stops, your sessions stay listed with their output and come back when you press Restart.

## Everyday improvements

- Each agent session shows which instruction files that agent loads, and one action links `CLAUDE.md` to `AGENTS.md` so every agent follows the same project rules.
- A read-only view lists the MCP servers each agent sees in a project.
- A context gauge shows how full each agent's context window is, for agents that report it.
- When an agent hits its usage limit, the session says so with the reset time, and you can continue the task in another agent.
- Spend is shown exactly where the agent reports it and, where it does not, as an estimate marked "(estimated)" or as "n/a"; an optional spending cap per session or feature acts only on reported spend.
- Line up tasks with a limit on how many agents run at once; the next one starts when a slot frees up, and queued tasks survive a quit.
- Many open terminals stay smooth, each agent's memory use is shown on its row, and a layout tiles the agents that are working.
- Windows and Linux have session and pane shortcuts, Ctrl+Shift+C and V to copy and paste, and right-click Paste in the terminal, and menus show the keys that work on your system.
- A very large paste arrives whole, and the session follows the folder you `cd` into in zsh and bash.
- Dialogs keep the keyboard while they are open, and every new screen is translated and works with only a keyboard or with a screen reader.
- Settings and the agent check say only what is true, including when an account refuses its default model.
- Install on Windows with `winget install`.
- The Linux AppImage is back, and the macOS and Linux installers are smaller.
- Typing in a terminal stays responsive while Hermes checks which program is running, most noticeably on Windows.
- In the Agent view, when Claude stops the view says why (could not start, signed out, exited, busy) and offers Retry or Sign in, and a stuck agent can be force-stopped.

## Safety and reliability

- Each new task gets its own `hermes/<name>` branch, and a branch already in use elsewhere asks whether to reuse it, pick a new name or cancel, so two agents never share a checkout by accident.
- Closing a session with uncommitted changes offers to commit them to the session's branch or archive them, and never stashes your work.
- A restored session keeps its branch and its folder.
- Hermes refuses to create a new task when less than 10 GB of disk is free and tells you why.
- The worktree overview shows how much disk each worktree uses, removes build output on request and clears leftover worktree folders in one action.
- Starting and tracking agents never changes your agents' own global settings.
- Every new agent session starts with one safety default (write inside the project, ask before network access or other folders), and an agent running looser than that shows a warning.
- A session you close just before quitting stays closed, even if Hermes is force-quit right after.

## Retired, and what replaces them

- The four-step New Session wizard is no longer the default way to start: the ⌘N task launcher replaces it, and the full wizard (⌘⇧N) stays available for SSH, tmux and existing branches.
- The four-step welcome wizard and the "awaiting first signal" screen are replaced by three-step onboarding; theme and privacy choices live in Settings.
- Stash & Close is gone: closing a session commits its changes to the session's branch or archives them.
- Gemini CLI is marked legacy; Antigravity CLI is now the main Google agent.
- The "set up notifications" link and hand-copied setup snippets are gone: agents report their status automatically.
- The "Task completed" notification and the needs-input indicator in the status bar are replaced by the attention inbox and its notifications.
- The separate Git panels are replaced by the Review Desk, which keeps the log, stash and conflict views.
- Rewinding Claude in the Agent view is replaced by restoring a recorded turn, which also covers changes made through shell commands.
- The context budget meter is replaced by the real context gauge.
- Hermes no longer edits your global Claude MCP settings; servers are added to the project's own MCP file.
