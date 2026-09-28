# Hermes IDE 1.4.1

Every agent now opens in its own terminal, updates wait until your agents
are done, a crash stays inside its pane, and Hermes is private by default.

## Terminal first, for every agent

- New sessions open every agent, Claude included, in the agent's own
  terminal interface, exactly as it runs anywhere else.
- Claude's Agent view is now an option: tick **Agent view for Claude** on
  the agent step of New Session to have Hermes render the conversation
  instead.
- New Session starts straight on "What do you want to run?"; the separate
  mode step is gone, and **Connect over SSH** is a link on that step.
- Hermes remembers the agent you picked and how you ran it, and preselects
  both next time.
- Saved Agent-view sessions still restore in the Agent view.

## Updates wait for your agents

- An update no longer relaunches Hermes while an agent is mid-turn or a
  command is still running; the dialog says how many sessions it is
  waiting for and offers **Relaunch now** if you want to install anyway.
- New builds go to a **beta** channel first and reach stable after a soak
  period; pick your channel in Settings → General → Update channel.
- Before your data is updated, Hermes saves a copy of it and keeps the
  three newest copies.
- An older Hermes no longer opens data saved by a newer one: it explains
  why, offers only Quit, and leaves your data exactly as it was, even
  after a crash.
- On Linux, in-app updates now install the .deb package.

## A crash stays in its pane

- If something inside one pane fails, only that pane shows an error card
  with **Reload pane** and **Close pane**; the other panes, the session
  list and the running shells keep working, and Reload brings the pane
  back with its scrollback.
- A failure inside a single agent message shows an error card in that
  message instead of blanking the conversation.
- If the whole window's interface fails, it can be reloaded without
  losing any session.

## Private by default

- Usage analytics is off on a fresh install; nothing is sent unless you
  opt in, and until then the analytics component is not even loaded.
- Turning analytics on or off in Settings → Privacy takes effect at once,
  without a restart.
- If you do opt in, the three usage events (app started, session created,
  feature used) are now actually sent; before this release none left the
  app.
- New **Delete Session Data…** action in a session's right-click menu
  clears what Hermes keeps about that session: saved terminal output,
  command history, token usage, pinned and remembered context, and agent
  state. It asks first, and leaves the session and its repository alone.
- A plugin can no longer read another plugin's stored data, use another
  plugin's permissions, grant itself permissions, or see what else is
  installed; installed plugins keep working unchanged.

## Ctrl+letter belongs to the terminal (Windows and Linux)

- Ctrl+A, Ctrl+D, Ctrl+E, Ctrl+W and the other Ctrl+letter keys now reach
  the shell or agent in a focused terminal instead of running app
  shortcuts; Ctrl+D ends input, it no longer splits the pane.
- App shortcuts on Windows and Linux are now Ctrl+Shift+letter, like
  Windows Terminal: Ctrl+Shift+D splits, Ctrl+Shift+W closes,
  Ctrl+Shift+K opens the command palette. The old Ctrl+letter shortcuts
  still work when no terminal has focus.
- Shortcuts follow the letters printed on your keyboard (AZERTY, Dvorak,
  …); the menus and the Keyboard Shortcuts panel show the right keys for
  your platform.
- The Keyboard Shortcuts panel and Settings → Shortcuts now list every
  shortcut the app really has, in your interface language, and nothing
  that doesn't exist; a shortcuts reference page is included in the docs.
- macOS is unchanged.

## Safer approvals in Agent view

- An approval prompt no longer grabs keyboard focus: if the agent asks for
  permission while you are typing, Enter sends your message and never
  approves the command by accident.
- **Always allow** now saves the rule to the current project's own Claude
  settings instead of your global ones, so approving a command in one
  project no longer approves it everywhere; the saved rules are listed
  under Permissions in the Context tab.
- Clicking Retry twice now restarts the agent once instead of starting two
  agent processes for one session.

## Faster start

- Settings, the plugin manager, the code editor, the Agent view, the New
  Session wizard, side panels and the welcome screens load the first time
  they are needed, and only the language in use is loaded.
- Terminal-only use starts no extra agent process at launch.
- Hermes no longer slows down after days of use: the per-session activity
  history is capped instead of growing without bound.

## Hermes never types into your terminal

- The Manual / Assisted / Auto switch, the Autonomous settings tab and the
  countdown that ran a predicted command are gone; nothing is ever typed
  into your terminal on your behalf.
- Inline suggestions and ghost text no longer appear over an agent CLI
  (Claude Code, Codex, Gemini CLI or any program the shell started); at a
  plain shell prompt they still work.
- New **Hermes inline suggestions** toggle in Settings → General turns
  Hermes suggestions off entirely and leaves your shell's own
  autosuggestions in charge.

## Also new

- Plugin side panels and the Git and Files views have their own width
  (resizable between 240 and 600 px) and a clear edge against the main
  area; in narrow windows the main area always keeps room to work.
- Editor font size shortcuts: Cmd/Ctrl+= grows, Cmd/Ctrl+- shrinks,
  Cmd/Ctrl+0 resets; the size is remembered.
- GitHub Copilot now means the current Copilot CLI, and its quick actions
  are the CLI's own slash commands. Having only the retired `gh copilot`
  extension no longer counts as Copilot being installed; the card shows
  how to install the CLI.
- SSH sessions now honour the jump host you configured, and leaving the
  SSH user blank lets your `~/.ssh/config` decide, as `ssh myalias` would.
- Agent-view sessions load `CLAUDE.md` from every folder attached to the
  session.
- Suggestions for starting a VS Code tunnel from the terminal.
- `hermes-ide --self-test=report.json` checks an install (database,
  bundled runtime, interface, a real shell) and writes a report you can
  send in; it contains no user or host name.
- The About dialog says Hermes IDE is not affiliated with Nous Research or
  its Hermes Agent.

## Fixes

- Each Claude session follows its own project's transcript; two sessions
  in two projects no longer both show whichever project was used last.
- The Workbench layout and session notes are back after a restart.
- Closing a session that shares a checkout with another session no longer
  deletes that checkout and its uncommitted work.
- The branch picker really greys out branches other sessions have checked
  out, and Next on the folder step waits until Hermes knows whether the
  folder is a git repository, so a quick click can no longer skip the
  branch step.
- `:` intent commands (for example `:status`) run again; they had been
  typing the raw text into the shell.
- Shell history and shell-type detection reach the suggestions again, so
  Hermes no longer draws ghost text on top of your shell's own
  autosuggestions.
- Splitting a pane that is not the focused one no longer shows the new
  session in two panes.
- Unsent image attachments in the agent composer survive switching to a
  terminal session and back.
- The working folder in the header updates even when the shell reports it
  in two pieces, and a stray unfinished escape sequence no longer makes
  Hermes hold long output in memory.
- The context-file variable in the launch line uses the session shell's
  own syntax, so it works in PowerShell and cmd.
- Session labels, saved hosts and the file explorer no longer show a fake
  `ssh@host` or a stray `@` when no SSH user is set.
- Leftover shell-setup files that older versions left in the system temp
  folder are cleaned up after an upgrade.
