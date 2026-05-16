# Hermes IDE 1.3.0

A keyboard convention overhaul, a quieter branch picker, and several
header and popover polish fixes.

## Press Enter to send

The agent composer now sends on **Enter**, with **Shift+Enter** for a
new line — matching Claude.ai, ChatGPT, Cursor, Slack, and the
muscle memory you bring to Hermes from those tools.

If you've already learned the older binding, **Cmd+Enter** (Ctrl+Enter
on Windows and Linux) still sends. Nothing lost, just an extra route in.

The send button's tooltip now reads `Send · Shift+Enter for newline` so
the convention is discoverable at a glance.

## One click picks a branch

When you create a session and pick a branch — especially across
multiple projects at once — clicking a branch row now commits your
choice immediately. No more silent trap where the row looked
"selected" but never actually registered, and you ended up with no
branch isolation when you continued.

A small `→` chevron fades in on hover to telegraph that the click is
the action. Remote-only branches get a small `remote` tag so the
single click doesn't feel surprising.

The per-project **Use current branch** escape stays — pick one project
to share, another to isolate.

## Cmd+Enter sends Claude's option lists

When Claude asks you a multiple-choice question in the chat,
**Cmd+Enter** (Ctrl+Enter on Windows and Linux) now sends your
selection without reaching for the mouse. The send button shows the
shortcut as a small chip next to the word, mirroring the **Esc**
cancel chip.

## Quieter agent header

- **"Thinking" is no longer clipped** along its baseline. The brass
  glow had been getting cut off at the bottom edge of the header on
  some themes.
- **No more row jitter** when the status switches between one-word and
  two-word labels. Previously, "Running Bash" or "Awaiting Claude"
  could wrap to a second line in narrow panes, making the whole header
  height jump on every state change.

## Readable subagents popover

The popover that shows your running subagents now has a fully opaque
background. The previous build still let a faint blurred copy of the
chat bleed through on some setups, hurting legibility — that's gone.

The chat behind the popover stays where it is; the popover just stops
being half-see-through.
