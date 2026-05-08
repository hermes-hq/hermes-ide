# Hermes IDE 1.0.0

## Agent mode for Claude

New for 1.0.0: Claude sessions now open in **Agent mode** by default — a real chat experience with rich tool calls, thinking blocks, and proper images instead of a terminal pretending to be a chat.

- Talk to Claude in a real chat interface — no more typing into a terminal disguise
- See Claude's thinking, file edits, and tool results as first-class cards instead of buried in scrollback
- File edits arrive as proper diff cards you can scan at a glance
- A clear summary appears at the end of each turn with token usage and timing
- Paste or drop images that Claude actually sees — not file paths typed for you
- Slash commands and the model picker pull from Claude itself, so they stay in sync as Claude updates
- Sessions persist across restarts — reopen and continue where you left off

## Terminal mode (still here)

Anything that isn't Claude — Aider, Codex, Gemini, Copilot, Kiro, plain shells — keeps working in classic Terminal mode, unchanged. You can also explicitly open a Claude session as a terminal (for the `claude` CLI itself, scripting, or muscle memory) by choosing "Open as terminal instead" in the new-session creator.

You can convert a session between Agent and Terminal mode with right-click → Convert. Conversation history doesn't carry over, so it's a deliberate switch.

## What's required

Agent mode requires `claude` (the Claude Code CLI) on your PATH. Hermes detects it on startup and offers to install if missing. Use whatever auth you've already configured for Claude — Pro, Max, or API key all work; Hermes never asks for tokens.

## Other improvements

- Slash command suggestions for Claude come straight from Claude, so new commands appear automatically as you upgrade
- The model picker shows Claude's actual current model and effort options instead of a hardcoded list
- Mentions and image attachments are now part of the chat composer, with previews before you send

## Upgrade notes

- Existing saved sessions from 0.6.x continue to open in Terminal mode, exactly as before — nothing changes for restored workspaces
- New Claude sessions default to Agent mode; uncheck "Open as terminal instead" in the new-session modal to get the old TUI experience
- Switching modes on an existing session starts a fresh conversation; the previous transcript stays in the original session
