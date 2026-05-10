# Hermes IDE 1.1.8

A small fix-up release. Four polish items that smooth over rough
edges users would notice in their first hour with the app.

## The "Install & Relaunch" button now feels alive

Pressing it used to look like nothing happened — the button label
didn't change, nothing spun, and on macOS the install can take
many seconds. People clicked it again and again thinking it was
broken. Now you get a spinner and an "Installing…" label the
instant you click, the button disables itself, and the dismiss
options disappear so an accidental click outside the dialog can't
cancel an install in flight.

## The Bypass chip applies the moment you flip it

If you switched permission mode to Bypass while a turn was in
flight, the next tool call still asked for permission. The chip's
choice didn't reach the live agent until your next message. Now
flipping the chip takes effect immediately — any tool call already
on its way is auto-allowed without a prompt.

## The blue cursor stops blinking after a turn ends abnormally

When an agent turn ended via interrupt, signal, or a sudden
subprocess exit instead of a clean finish, the small blue cursor
at the end of the latest reply kept blinking forever, and any
in-progress thinking timer kept ticking up. Both now settle the
same way they would after a normal turn-end.

## The welcome screen fits compact windows

On smaller displays the empty-state landing page was hiding the
bottom of the logbook behind the window edge with no way to scroll.
The whole composition now scales to the available height and lets
you scroll when it has to, with the Hermes IDE wordmark always the
first thing you see at the top.

---

# Hermes IDE 1.1.7

A memory-hardening release for Agent mode. No new features — every
change is about making long agent sessions stay responsive and free
of memory growth that earlier builds let accumulate over hours of use.

## Long agent sessions stay lean

Several places in Agent mode used to hold on to data that should have
been freed:
- A diagnostic buffer for unrecognised events could grow without
  bound if the bridge misbehaved.
- The TODO panel re-walked every assistant message in history on
  every paint, creating heavy GC pressure during long conversations.
- Reader tasks behind a closed session could keep running in the
  background until the app quit.

All of these are now bounded or cleaned up at session close. After
hours of use, the app should reclaim memory the way you'd expect
when a session ends.

## More resilient under load

- The bridge now respects backpressure when the app is briefly busy
  (a slow renderer, a temporary OS hiccup) instead of buffering an
  unbounded amount of streaming output in memory.
- Pasting a flood of input no longer grows the bridge's internal
  queue without limit; it briefly pauses reading from the host until
  the queue drains.
- A single oversized line of bridge output is dropped with a clear
  diagnostic event, instead of being held in memory while the app
  tries (and fails) to consume it.
- If the host process disappears mid-write, the bridge no longer
  hangs waiting forever — it cleans up and exits.

## Permission cache hardening

- Approval rules with command-prefix wildcards now require a word
  boundary, so an approval for `ls` can no longer match `lsof`.
- Empty-prefix and bare-tool wildcards are refused for sensitive
  tools as a defence-in-depth check, even though the in-app UI never
  emits them.

---

# Hermes IDE 1.1.6

A polish release focused on a smoother conversation surface, a more
trustworthy permission model, and a handful of long-standing layout
papercuts. If 1.1.5 felt sluggish to type into during long agent turns,
this release should fix it.

## Conversation feels lighter and faster

- **Long code blocks fold themselves.** The first ~14 lines render with
  syntax highlighting and the rest hide behind a *show more* button.
  Previously every fence painted in full, and a single 200-line file
  could make typing in the input lag for several seconds. *Show less*
  brings it back. Copy still copies the whole thing.
- **Auto-scroll respects you.** While Claude streams, the conversation
  pins to the bottom only if you were already at the bottom. Scroll up
  to re-read past output and you stay there until you choose to come
  back.
- **The "thinking" indicator is unmissable.** It now reads as a brass
  banner with a live sweep across the bar, instead of a small inline
  glyph that was easy to miss. Reduced-motion users see a static
  version.
- **Completed TODO lists tidy themselves up.** When every item in a
  TODO list is checked off, the panel fades out instead of hanging at
  the bottom of the conversation forever. It returns the moment Claude
  starts a new list.
- **Diagrams + tables in the expanded view got smarter.** The mermaid
  viewer auto-fits the diagram to the window on open, adds 4 directional
  pan buttons, − / + zoom controls, a percent readout, and a *reset to
  fit* button. Arrow keys pan, +/− zoom, `0` resets, Esc closes.

## Permissions you can trust

- **"Allow always" actually persists for the rest of the session.** If
  you approve a specific command (say `git status`) with allow-always,
  Claude won't ask again for matching commands. Previously the rule
  was saved to disk but not consulted within the running session.
- **Bypass permissions truly bypasses.** Setting permission mode to
  *bypass* now skips the approval modal entirely — no flash, no
  round-trip — instead of relying on the modal to auto-dismiss itself.
- **Hardened approval matching.** Approval rules use a word-boundary
  check (so `ls` no longer covers `lsof`), demand exact scoping for
  destructive tools, and reject malformed wildcard rules.

## Layout fixes you'd notice

- **Pasted images don't break the composer.** Drop or paste an image
  and the input box grows to fit the thumbnail rather than collapsing
  the typing area to a single line.
- **Sent images render as images, not as a wall of base64.** Previously
  attaching an image and sending showed a huge string of characters in
  the chat. Now the image appears in the conversation; click to open
  full-size.
- **The Builder *send* works in chat sessions.** Pressing send in the
  prompt builder appends your composed prompt into the chat input
  (instead of doing nothing), so you can review or add to it before
  sending.
- **The welcome screen no longer clips behind the title bar** on macOS,
  scales properly on small windows, and reads "Hermes IDE" instead of
  just "Hermes."  The *what's new* dialog also clears the title bar.

## Code blocks: collapse and re-collapse

Once you've expanded a long code block, a *collapse* button appears at
the bottom of it so you don't have to scroll up to find the toggle.

---

# Hermes IDE 1.1.5

A hotfix for v1.1.4 — Agent mode crashed every conversation in the installed app with a *Cannot find package* error in the activity panel. v1.1.5 ships the missing helper so Agent mode works again.

If you were stuck on *Agent process crashed (code 1)* on v1.1.4, please update.

A guard test now scans the agent runtime for every helper file it imports and asserts each one is included in the installer — the same kind of mistake won't slip through again.

---

# Hermes IDE 1.1.4

A small performance touch-up.

## Faster first Agent session

The first Agent session you open after launching the app now starts noticeably faster. The runtime is warmed up quietly in the background while the app finishes opening, so the *awaiting claude* delay on the first message is largely gone.

The pause was most noticeable on slower disks or right after a fresh restart; subsequent sessions in the same launch were already quick.

---

# Hermes IDE 1.1.3

A focused hotfix that finishes restoring Agent mode in shipped builds, plus two reliability tightenings around tool permissions.

## Agent mode now actually starts

1.1.2 was supposed to restore Agent mode for installed apps, but a piece of the agent runtime was still missing from the bundle — every conversation crashed within seconds with a *Cannot find package* error in the activity panel. 1.1.3 ships the missing runtime, so Agent mode starts and stays running on installed builds.

If you were stuck on *Agent process crashed (code 1)* on 1.1.2, please update.

## Reliability tightening

- **Stopping an agent mid-permission-prompt no longer hangs.** If you press stop while a tool is waiting on your approval, the prompt now resolves immediately instead of leaving the conversation stuck.
- **Bypass-permissions mode is now applied consistently** when selected — previously it could silently fall back to standard prompting in some launches.

## Linux installers

- `.deb` installers ship for both x86_64 and aarch64 (covers Ubuntu/Debian/Mint/Pop!_OS).
- AppImage builds are temporarily paused while we trim the agent runtime; AppImage support is planned to return in a follow-up release.

---

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
