# Hermes IDE 1.2.1

A focused stability release closing six regressions introduced by the
1.2 design refresh.

## Slash commands with arguments now run as expected

Typing `/remote-control random`, `/agents create foo`, or any other
CLI slash command followed by arguments used to be rejected with
"isn't available in this environment." These commands now open the
embedded terminal with their arguments intact, the way they always
should have.

## CLI slash commands find `claude` again on app launches

Running `/mcp`, `/agents`, `/remote-control`, etc. from a Finder- or
Launchpad-launched Hermes was failing with "No viable candidates
found in PATH" because the system PATH the app inherits at launch
doesn't include the toolchain folders where `claude` actually lives.
The embedded terminal now augments its PATH the same way the main
agent does, so the binary is found regardless of how you launched
the app.

## Pasted image thumbnails no longer crash into the prompt

The thumbnail row above the composer now has proper breathing room
below the images. Previously the bottom of an attached thumbnail sat
flush against the text input.

## "Show N more lines" button no longer drifts under your cursor

Two distinct bugs were causing the expand button on long code blocks
to "move and move back" — leaving you stabbing at it three or four
times before a click registered. Both are gone: the button now sits
stably under your cursor on press and the first click expands the
block.

## Stop button actually stops the spinner

Hitting Stop before Claude streamed its first reply used to leave
the "awaiting claude" indicator spinning forever, even though the
request was already cancelled and "[Request interrupted by user]"
was visible. The indicator now clears the moment the interrupt
completes.

## Scan button stays inside the New-Session wizard

The Scan button in the Project Context step was hanging off the
right edge of narrow dialogs. The footer row now fits regardless of
the dialog width — the input shrinks before the buttons do.
