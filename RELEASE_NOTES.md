# Hermes IDE 1.1.2

A focused stability release that fixes Agent mode in the shipped 1.1 build and tightens long-session memory.

## Agent mode now works in shipped builds

The public 1.1 build couldn't actually run Agent mode — every conversation got stuck on *awaiting claude* because the agent runtime files weren't included in the installer, and even when they were, macOS apps launched from Finder couldn't find Node.js. Both gaps are closed in 1.1.2.

If you tried Agent mode on 1.1 and it hung, please update — it works now.

## Reliability fixes for Agent mode

- **Permission requests no longer disappear when you switch sessions.** If Claude was waiting on you to approve a tool and you clicked another session, the prompt used to vanish and the agent would hang. The prompt now follows you back when you return.
- **No more phantom *agent process exited* banner.** When swapping models, permission modes, or effort levels, a brief race could paint a red exit notice over a perfectly healthy session.
- **The activity indicator no longer hangs on *running* forever** if a tool was interrupted by a respawn or crash.
- **Spawn failures show up inline now.** If the agent runtime couldn't start, the conversation pane used to stay silent; you now see exactly why, so you can fix it (for example, install Node.js).
- **Clearer error path on the permission modal.** If your allow/deny decision fails to deliver to the agent, you now see a banner and the prompt comes back so you can try again.
- **Model, permission-mode, and effort swaps actually take effect.** Previously the chip would update but the underlying agent kept its prior settings until the next user message; the swap is now respected immediately on the next turn.
- **Conversation timeline survives session switching.** Switching to another session and back no longer wipes the chat — the messages you saw before are still there.

## Performance & memory

- **Long sessions no longer accumulate memory.** Verbose subprocess output is now capped, and every closed session is fully cleaned up — previously a handful of internal tracking entries lingered for the lifetime of the app.
- **Cost lozenge is accurate.** A duplicate-event guard ensures usage and cost can't be double-counted when the agent runtime resumes.

---

# Hermes IDE 1.1.1

A small patch release that restores the Windows installer for v1.1, plus a clearer statement of how each platform is supported going forward.

## What changed

- **Windows installer is back.** The v1.1.0 release couldn't produce a Windows build due to a packaging issue. v1.1.1 ships a working `_x64-setup.exe` (and ARM64 build). macOS and Linux installers were unaffected.

## Platform support, stated clearly

Hermes is built and tested primarily on macOS and Linux. Both receive every update.

**Windows is supported on a best-effort basis.** Core terminal features are stable, but newer capabilities — such as Agent mode, introduced in v1.1 — may arrive late on Windows or stay macOS / Linux only. If you rely on Windows day-to-day, pin to a known-good version.

The download page on hermes-ide.com now reflects this directly when you select the Windows tab.

---

# Hermes IDE 1.1.0

## A modern session timeline

The agent timeline got a top-to-bottom redesign that reads like a real conversation, not an instrument-panel logbook.

- A small avatar chip identifies who's talking — **You** with your accent color, **Hermes** with a friendly bot icon. Replaces the cramped `№ 01` left-gutter numbering.
- Body text moves to a refined sans-serif at a comfortable reading size; mono is preserved where it matters (code, file paths, tool calls, the cost meter).
- Your messages appear in a soft accent-tinted card instead of a vertical brass stripe.
- Whitespace replaces the hairline rules between turns. Conversations breathe.
- The masthead is calmer — `Agent · model · cwd` in normal case, no more all-caps tracked mono.

Every theme paints this layout differently — `hacker` keeps its phosphor scanlines, `designer` adds a subtle paper grain, `tron` pulses a cyan rail, `nightowl` gets a glass aurora. Switching themes now changes how a conversation feels, not just what color it is.

## Slash commands you can actually find

Type `/` and Hermes shows **every Claude Code slash command** in the popover — built-ins, plugins, skills, your custom `~/.claude/commands` files. Each entry is clearly labeled:

- `✦ in-app` — runs in the chat (sent as a prompt to Claude)
- `▣ terminal` — opens an embedded terminal that runs `claude /<command>` interactively

Pick `/mcp`, `/agents`, `/cost`, `/help`, `/login`, or any other interactive built-in and a small inline terminal pops above the composer running the actual Claude REPL with the command auto-typed for you. Arrow-navigate the TUI, hit Enter, close when done.

## Inline shell terminal

A new **Terminal** button next to Builder opens a quick shell prompt right where the chat composer lives — for `git status`, `npm run dev`, `ls`, anything you'd reach for without leaving the agent surface. Same xterm, your default shell, current project as the working directory.

## MCP server panel that actually helps

Click any MCP server in the right panel and you see:

- A color-coded status note (Connected / Needs auth / Failed / Unknown) explaining why the dot is the color it is
- The transport (stdio / sse / http) plus command + args or URL
- The environment-variable keys the server expects (values are never shown — they may carry secrets)
- The list of tools that server exposes
- **Restart** and **Remove** actions, with a confirmation step on remove

Removing an MCP server now actually disappears it from the panel immediately; cloud-managed servers (claude.ai Gmail, Drive, Calendar, etc.) are detected and labeled "managed elsewhere" so you don't get stuck trying to delete them locally.

## Permission cards stop hiding

The "approve / deny / always allow" buttons that appear when Claude asks to run a tool are now real, prominent buttons — not tiny mono-link text. The primary "Approve once" gets a brief attract pulse so your eye lands on the right thing. Standard dialog layout: deny on the left, confirm on the right, Enter submits.

## Plan mode actually works

Plan mode used to silently drop your responses — clicking Approve on a plan or answering a multi-question prompt looked like nothing happened. Both flows now route through the correct path and Claude sees your answer.

Switching the model or permission mode mid-session also stays in sync now; the picker chips reflect Claude's reality even when the change came from inside a conversation (e.g. Claude entered plan mode itself).

## Smaller things you'll notice

- The first message in a fresh session shows the thinking indicator immediately, not after a silent pause while the bridge boots
- The Cost & Tokens panel section is gone — its only button didn't work; the running cost meter in the header is the live source of truth
- The activity-bar Context button now actually toggles the agent context panel (Cmd+E to hide it for more horizontal room)
- The dirty-close session dialog stops surfacing `.aider.chat.history.md` and other auto-generated noise files
- Composer chips truncate cleanly on narrow widths instead of overlapping each other
- The bot/person icons in the speaker chip take the theme accent — green-phosphor on `hacker`, cyan on `tron`, terracotta on `designer`

## Prefer the previous look?

If the new timeline isn't for you, **Settings → Appearance → Use classic compact timeline** restores the denser, mono-bodied logbook style this release replaced — with the brass left bar on user messages, hairline rules between turns, and the prior typography. Toggle it back any time. Themes still apply on top.

---

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
