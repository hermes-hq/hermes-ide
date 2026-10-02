# Changelog

All notable user-facing changes to Hermes IDE are documented in this file.

For the format, see the [release template](.github/RELEASE_TEMPLATE.md).
Each release uses the categories: **New**, **Fixed**, **Improved**, **Removed**.

---

# 2.0.0 (2026-09-28)

## New
- Hermes 2.0 is a vendor-neutral console for every coding agent, terminal first: every agent runs in its own terminal interface and is supervised the same way, and the Agent view for Claude stays an option
- The agent list now includes Antigravity CLI, GitHub Copilot CLI, OpenCode, goose and Hermes Agent, each with install and sign-in help
- Custom agent: add any command-line agent; it runs in a terminal and shows under its own name in the sidebar
- More than one account per agent, each signed in on its own with its own models
- Every agent starts from one short line that is the same on every shell and OS
- Quit and reopen Hermes and each agent continues its own conversation; a failed resume says so in one line and starts fresh
- An agent that refuses to start says why in its own words and offers to retry, pick another model or sign in
- An agent stuck at a "do you trust this folder?" prompt is marked as waiting at a startup prompt
- Hermes knows when each terminal agent needs approval, asks a question, finishes or fails, with nothing to set up
- One status for every session (working, needs approval, asked you, done, error, idle), shown as a word and a symbol and dimmed when guessed
- Attention inbox with a title-bar badge; ⌘I jumps to the agent that has waited longest, and notifications arrive only when an agent is blocked or done
- Optional away-from-desk messages to a web address you set up, with only the agent, task and state
- Model and permission mode shown in the session header
- ⌘N task launcher: describe the task, press Enter, and an agent starts on its own new branch with the task as its first prompt; it keeps what you typed and remembers your usual choices per project
- Three-step onboarding and an agent check in Settings → Agents
- New tasks get their dependencies in seconds and their own ports
- Worktree recipes in `.hermes/worktree.toml`: setup commands, files to copy and a default check for each new task
- Each new task gets its own `hermes/<name>` branch, and a branch already in use asks whether to reuse it, pick a new name or cancel
- Every agent turn is saved in git without touching your branch, staged changes or stash, with Diff and Restore (preview and Undo) for each turn
- Review Desk (⌘G): review by turn or file, send line comments back to the agent that wrote them, revert one turn, and see risk flags
- Land sheet: commit, open a pull request or merge locally in one step, with undo
- Your checks decide when an agent is done
- Overlap badge on sessions whose recent turns touched the same files
- Feature Tracks: guided phases kept as short markdown files in your repository, with approvals in the inbox; only you can approve or skip a phase
- On macOS and Linux, agents keep running while Hermes quits, updates or crashes, and you reattach where they were
- Instruction files per agent, one action to link `CLAUDE.md` to `AGENTS.md`, and a read-only view of the MCP servers each agent sees
- One safety default for every new agent session, with a warning when an agent runs looser
- Context gauge for agents that report their context use
- Usage-limit status with the reset time, and continue the task in another agent
- Spend shown where the agent reports it, an estimate marked "(estimated)" elsewhere or "n/a", and an optional spending cap on reported spend
- Task queue with a limit on how many agents run at once; queued tasks survive a quit
- Windows installs with `winget install`
- The Linux AppImage is back
- Close Session has a shortcut, and Windows and Linux have session and pane shortcuts and Ctrl+Shift+C and V to copy and paste in the terminal

## Fixed
- A session closed just before quitting stays closed, even if Hermes is force-quit right after
- Pull, Abort Merge and Discard keep your uncommitted work
- Closing a task keeps submodule and detached-HEAD commits, and the branch switcher never deletes unmerged work without asking
- Land goes into the branch the task started from and never over an uncommitted edit
- Hermes's commits run your repository's hooks, and a refusal is shown as the hook said it
- When Hermes's background service stops, sessions stay listed with their output and come back on Restart
- Agents kept running by the session host report their status again after a relaunch
- Quitting asks about a quiet running command and about every working session
- A very large paste arrives whole, and a terminal font size of 0 no longer freezes the window
- The blocked count in the inbox counts agents only, and a Hermes notice alone lights the badge
- Dialogs keep the keyboard, and Settings and the agent check no longer show refusals that have since gone away
- A hung Agent-view agent can be force-stopped, and a crash stays marked

## Improved
- Typing in a terminal stays responsive while Hermes checks which program is running, most noticeably on Windows
- Starting and tracking agents never changes your agents' own global settings
- Hermes refuses to create a new task below 10 GB of free disk, and the worktree overview shows disk used per worktree, removes build output and clears leftover worktree folders
- Many open terminals stay smooth, and each agent's memory use is shown on its row
- macOS and Linux installers are smaller
- Every new screen is translated and works with a keyboard or a screen reader
- Agent view: when Claude stops, the view says why and offers Retry or Sign in
- A repeated task gets the next free branch name, and branch names git would refuse are flagged before Launch
- The Review Desk names the agent that made each change, keeps comments on their line and flags edits to an agent's own configuration
- Restore says what it sets aside and offers Undo; Make it a feature asks first and its Undo removes exactly what it wrote

## Removed
- Stash & Close; closing a session commits its changes to the session's branch or archives them
- Gemini CLI is marked legacy; Antigravity CLI is the main Google agent
- The four-step New Session wizard as the default; the ⌘N launcher replaces it and the full wizard stays for SSH, tmux and existing branches
- The four-step welcome wizard and the "awaiting first signal" screen; three-step onboarding replaces them
- The "set up notifications" link; agents report their status automatically
- The "Task completed" notification and the status-bar needs-input indicator; the attention inbox replaces them
- The separate Git panels; the Review Desk replaces them
- Rewinding Claude in the Agent view; restoring a recorded turn replaces it
- The context budget meter; the real context gauge replaces it
- Editing your global Claude MCP settings; servers are added to the project's own MCP file

# 1.4.1 (2026-09-28)

## New
- New sessions open every agent, Claude included, in the agent's own terminal interface; Claude's Agent view is an option ("Agent view for Claude") on the agent step of New Session
- New Session starts straight on "What do you want to run?"; the mode step is gone and "Connect over SSH" is a link on that step
- Hermes remembers the agent you picked and how you ran it, and preselects both next time
- Updates wait until every session is idle before relaunching; the dialog says how many sessions it is waiting for and offers "Relaunch now"
- Beta update channel: new builds go to beta first and reach stable after a soak period; pick the channel in Settings → General → Update channel
- Hermes saves a copy of your data before updating it (the three newest copies are kept), and an older version never opens data saved by a newer one
- A failure inside one pane shows an error card with Reload pane and Close pane while every other pane, the session list and the running shells keep working
- Usage analytics is off on a fresh install and nothing is sent unless you opt in; turning it on or off in Settings → Privacy takes effect at once
- "Delete Session Data…" in a session's right-click menu clears the saved output, command history, token usage, pinned context and agent state Hermes keeps about that session
- Windows and Linux: Ctrl+letter keys reach the terminal; app shortcuts are now Ctrl+Shift+letter, and the old Ctrl+letter shortcuts still work when no terminal has focus
- Agent view: an approval prompt no longer takes keyboard focus, so Enter while typing never approves a command by accident
- Agent view: "Always allow" saves the rule to the current project's own Claude settings instead of your global ones, and the rules are listed under Permissions in the Context tab
- "Hermes inline suggestions" toggle in Settings → General turns Hermes suggestions off and leaves your shell's own autosuggestions in charge
- Plugin side panels and the Git and Files views have their own resizable width (240–600 px) and a clear edge against the main area
- Editor font size shortcuts: Cmd/Ctrl+= grows, Cmd/Ctrl+- shrinks, Cmd/Ctrl+0 resets; the size is remembered
- GitHub Copilot means the current Copilot CLI, with the CLI's own slash commands as quick actions
- SSH sessions honour the configured jump host, and a blank SSH user lets your ~/.ssh/config decide
- Agent-view sessions load CLAUDE.md from every folder attached to the session
- Suggestions for starting a VS Code tunnel from the terminal
- `hermes-ide --self-test=report.json` checks an install and writes a report you can send in, with no user or host name in it
- Linux in-app updates install the .deb package
- The About dialog says Hermes IDE is not affiliated with Nous Research or its Hermes Agent

## Fixed
- Each Claude session follows its own project's transcript instead of whichever project was used last
- The Workbench layout and session notes are restored after a restart
- Closing a session that shares a checkout with another session no longer deletes that checkout and its uncommitted work
- The branch picker greys out branches other sessions have checked out, and Next on the folder step waits until Hermes knows whether the folder is a git repository
- `:` intent commands run again instead of typing their raw text into the shell
- Shell history and shell-type detection reach the suggestions again, and ghost text is no longer drawn over the shell's own autosuggestions
- Agent view: clicking Retry twice restarts the agent once instead of starting two processes for one session
- Splitting a pane that is not the focused one no longer shows the new session in two panes
- Unsent image attachments in the agent composer survive switching to a terminal session and back
- The working folder in the header updates even when the shell reports it in two pieces, and an unfinished escape sequence no longer makes Hermes hold long output in memory
- The context-file variable in the launch line uses the session shell's own syntax, so it works in PowerShell and cmd
- Session labels, saved hosts and the file explorer no longer show a fake `ssh@host` or a stray `@` when no SSH user is set
- Having only the retired `gh copilot` extension no longer counts as Copilot being installed; the card shows how to install the CLI
- Opted-in analytics events (app started, session created, feature used) are actually sent; before, none left the app
- A plugin can no longer read another plugin's stored data, use its permissions, grant itself permissions or list what else is installed
- Leftover shell-setup files from older versions are cleaned out of the system temp folder after an upgrade

## Improved
- Faster start: Settings, the plugin manager, the code editor, the Agent view, the New Session wizard, side panels and the welcome screens load when first needed, and only the language in use is loaded
- Terminal-only use starts no extra agent process at launch
- Hermes no longer slows down after days of use; the per-session activity history is capped
- The Keyboard Shortcuts panel and Settings → Shortcuts list every real shortcut in your interface language, and a shortcuts reference page is included in the docs
- Shortcuts follow the letters printed on your keyboard (AZERTY, Dvorak, …) and the menus show the right keys for your platform
- In narrow windows the main area always keeps room to work when side panels are open

## Removed
- The Manual / Assisted / Auto switch, the Autonomous settings tab and the countdown that ran a predicted command; Hermes never types into your terminal on its own
- Inline suggestions and ghost text over an agent CLI; they still work at a plain shell prompt

# 1.4.0 (2026-09-27)

## New
- Interface translations built in — switch Hermes to Russian, Spanish, French, German, Portuguese (Brazil), Simplified Chinese, Japanese, or Hindi from Plugins → Hermes Language Pack; the switch is instant, needs no restart, and is remembered across launches
- Language Pack ships as a built-in plugin, visible and manageable in the installed plugins list
- Localized the start screen, command palette, settings, session creation flow (including the SSH and tmux steps), usage and plan limits, shortcuts, plugin manager, and the prompt composer with roles, styles, and templates
- Fable 5.1 in the agent-mode model picker; Opus, Sonnet, and Haiku now use the latest version of each model
- Agent mode runs on the latest Claude tooling
- Unnamed agent sessions are named after your first message

## Fixed
- Closed terminal sessions no longer come back as black, unusable "ghost" sessions (often after waking the computer)
- Switching sessions opens the agent conversation at the latest message instead of the top
- Split Right / Split Down from the terminal right-click menu open a working new session instead of an empty pane
- Windows: Hermes no longer opens off-screen or disappears after being minimized or maximized
- Windows: agent sessions no longer crash on the first message with "EISDIR: lstat 'C:'"
- Session cards and pane headers show the model in use instead of "claude"
- A clear message appears when a session's branch workspace can't be created, instead of the session silently not opening
- Input typed inside full-screen programs no longer pollutes shell history and suggestions
- Kiro auto mode launches with the correct permission setting
- The TODO panel keeps updating with the latest Claude tooling
- Usage panel now counts input tokens from the whole session, including turns from before the panel was opened

## Improved
- Context Panel action on the start screen works before a session is opened

# 1.2.0 (2026-05-11)

## New
- Voice-color system across every theme — your turns wear a warm tone, the agent's turns wear a cool tone, so a long conversation reads at a glance
- Attach button in the composer for adding images by clicking (paste and drag-and-drop continue to work)
- Three-segment execution mode control in the status bar — Manual, Assisted, and Auto are all visible at once instead of cycling on click
- Pulsing status capsules for "working" and "needs input" replace the bare-text labels
- Version chip in the status bar that shows idle, checking, update-available, and downloading-with-progress in a single element
- Comprehensive design-system documentation describing every visual token and component pattern

## Fixed
- Collapsed "thought" footnotes in agent conversations no longer render as an empty dashed box with their content escaping below; the collapsed state is now an inline brass chip, expanded thoughts pull their body inside the same footprint
- Text contrast on Frosted Light, Atrium, and Linen now meets WCAG AA — previously failed for secondary metadata
- Activity bar icons no longer bob vertically when you hover them
- The minimized composer is a discoverable "Compose" brass pill with the keyboard shortcut visible, instead of a small dark circle hugging the corner

## Improved
- Agent conversation headings have a proper editorial hierarchy (24 / 20 / 16 / 14) — markdown structure in long replies is finally scannable
- Editorial themes (Atelier, Linen, Observatory, Newsprint) use the Newsreader serif typeface for headings
- Newsprint is now a true duotone — brass is the live accent for links and selection, true ink stays as the body color
- Atrium gains a richer slate-teal accent; the previous muted slate didn't pop on the daylight surface
- Frosted Dark and Frosted Light carry subtle cool chroma so the frosted overlays have something to refract
- Composer settings (Model · Permission · Effort) are now compact dot-chips with categorical colored dots
- The Permission chip turns red and pulses when set to Bypass — the danger state announces itself instead of looking like every other pill
- The Send button is now a brass pill that reads `Send →` with the arrow sliding right on hover; the keyboard shortcut moved to the tooltip
- Session row left band carries the live phase — vertical shimmer when busy, amber pulse when needs-input, solid red on error
- Session list description and project chips hide until the row is active or hovered, so the sidebar reads as a glanceable index
- Single-letter monogram glyphs replace the agent-name and SSH chips on session rows
- Logbook entries on the empty state show a preview snippet and shell name for each recent session
- Sliding underline between Terminal and Git tabs instead of a snap
- Focus ring is themed per theme — soft halo on glass themes, sharp double-rule on Newsprint, accent glow on Phosphor, brass on editorial themes
- Activity bar icons are larger and the active-tab indicator anchors flush to the bar edge
- Token count, cost, and elapsed time in the status bar settle to calm grey by default and flash brass briefly when they change
- All animations respect prefers-reduced-motion

## Removed
- The legacy theme rule that quietly collapsed every multi-tone theme's "your" voice into its accent color — themes now declare both voices explicitly

---

# 1.0.0 (2026-04-27)

## New
- Agent mode for Claude — Claude sessions now open in a real chat interface by default, with rich tool calls, thinking blocks, diff cards, and image input
- File edits made by Claude render as syntax-highlighted diff cards instead of plain text
- Tool calls (Bash, Read, Write, Edit, web search, and more) render as collapsible cards with arguments and results visible at a glance
- Each turn ends with a summary showing token usage and timing
- Paste or drop images directly into the Claude composer and Claude sees the actual pixels
- Per-session mode picker in the new-session modal — choose Agent mode (chat experience) or Terminal mode (classic TUI)
- Right-click any session and choose Convert to switch between Agent and Terminal mode
- Conversations with Claude in Agent mode persist across app restarts — reopen the session and continue where you left off

## Improved
- Slash command suggestions for Claude are now sourced from Claude itself, so new commands appear automatically as Claude updates
- The model picker reflects Claude's actual current model and effort options instead of a hardcoded list
- Composer mentions and image attachments are now first-class in the chat input, with previews before you send

## Removed
- The bracketed-paste workaround used to fake a chat experience inside the Claude TUI is gone — Agent mode replaces it with a real chat surface
- The bundled fallback list of slash commands has been removed; commands now come live from Claude

---

# 0.5.8 (2026-03-14)

## Fixed
- Terminal sessions now resize correctly when the window is resized on macOS
- Shell and child processes (e.g. Claude Code) properly pick up new terminal dimensions after resize

---

# 0.5.6 (2026-03-14)

## New
- Plugins can now open links in the default browser via `api.shell.openExternal()`

## Fixed
- Plugin error messages now display correctly instead of showing "Unknown error"

---

# 0.5.5 (2026-03-14)

## Fixed
- Plugin update button now works reliably — previously clicking "Update" could silently do nothing when the update checker state was out of sync

---

# 0.5.4 (2026-03-14)

## New
- Plugins can now fetch data from the internet, enabling new types of plugins like feed readers and API tools
- Plugin Manager now shows your app version and clearer messages when a plugin requires a newer version
- Plugin updates that require a newer app version are no longer offered, preventing incompatible installs

## Improved
- Incompatible plugins in the store now show a detailed warning explaining what version is needed and how to update

---

# 0.5.3 (2026-03-13)

## Improved
- Command suggestions can now be navigated with arrow keys, accepted with Enter, and clicked with the mouse
- Suggestion dropdown shows up to 15 results in a scrollable list, up from 6
- Suggestion dropdown flips above the cursor when typing near the bottom of the terminal
- Light themes now have better contrast for text, labels, and borders

## Fixed
- Command suggestions no longer appear inside interactive CLI tools like vim, htop, or Claude Code
- Suggestion overlay position is now correctly aligned with the cursor

---

# 0.4.6 (2026-03-12)

## New
- Browse, view, and edit files directly in the app — with syntax highlighting and full SSH remote support
- Shift+Enter now inserts a newline in CLI tools that support it, matching the behavior of other modern terminals
