# Hermes IDE 1.4.0

Hermes now speaks your language. The interface ships translated into
eight languages, and switching takes two clicks — no restart.

## Eight languages, built in

Open **Plugins → Hermes Language Pack** and pick your language from
the selector: Russian, Spanish, French, German, Portuguese (Brazil),
Simplified Chinese, Japanese, or Hindi — alongside English.

The switch is instant: every translated surface re-renders in place.
Your choice is remembered across launches.

## The whole interface, not just the menus

Translations cover the surfaces you actually live in: the start
screen, the command palette and every shortcut description, the
settings tabs end to end, the session creation flow including the SSH
and tmux steps, the usage and plan limits panel, the plugin manager,
and the prompt composer with its roles, styles, and templates.

The language pack is a built-in plugin, so it appears in your
installed plugins list where you can see its version and manage it
like anything else — but there is nothing to install, and it can't be
removed by accident.

One honest limit: the native macOS menu bar stays English for now.

## The latest Claude, in agent mode

Agent mode now runs on the newest Claude tooling, and the model picker
gains **Fable 5.1** alongside Opus, Sonnet, and Haiku — which now point
at the latest version of each model automatically.

Claude's task list keeps working with the new tooling: the TODO panel
fills in and updates as Claude plans and checks off its work.

## Closed sessions stay closed

If you closed a terminal session while a program inside it was still
running, the session could come back — often after your computer woke
from sleep — as a black, unusable entry in the sidebar that no amount
of closing would remove. Closed sessions now stay gone, and whatever
was still running inside them is shut down with them.

## Sessions name themselves

Agent sessions you didn't name are now named after your first message,
so the sidebar reads like a list of what you're working on instead of
"Session 1", "Session 2". Rename any of them whenever you like.

## Fixes

- Switching to another session and back now opens the conversation at
  the latest message instead of at the top.
- **Split Right** and **Split Down** from the terminal's right-click
  menu now open a fresh session with a working prompt instead of an
  empty pane.
- On Windows, Hermes no longer opens off-screen or "vanishes" after
  being minimized or maximized.
- On Windows, agent sessions no longer crash on the first message with
  an `EISDIR: lstat 'C:'` error.
- Session cards and pane headers show the model you're actually using
  instead of just "claude".
- When Hermes can't create a session's branch workspace, you now get a
  clear message instead of the session silently not appearing.
- Keystrokes typed inside full-screen programs (Claude, vim, less, and
  the like) no longer end up in your shell history and suggestions.
- Kiro's auto mode now launches with the right permission setting.

## Also in this release

- The usage panel now counts input tokens from the whole session,
  including the turns that happened before you opened the panel.
- The Context Panel action on the start screen works before you've
  opened a session.
