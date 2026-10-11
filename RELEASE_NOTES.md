# Hermes IDE 2.2.1

## Fixes

### Terminal

- On macOS with split panes, Ctrl+C now stops the program in the terminal you are typing in, not the one in another pane.
- On Linux, Ctrl+C no longer stops background jobs such as a dev server, and no longer closes an agent that handles Ctrl+C itself.
- Changing the terminal font or font size no longer leaves the shell wrapping lines at the old width.
- Pressing Esc on a command suggestion now removes it completely, so a following Tab no longer runs it.
- A reopened session's history no longer fills up with repeated copies of an agent's screen while it was working.
- A session whose program ended while Hermes was closed now shows "Session ended" after its last output, not before it.

### Sessions

- Converting a terminal Claude session to Agent view no longer makes the session disappear, and no longer throws away uncommitted changes in its task folder.
- If an Agent view session can't start after a relaunch, Retry now continues the earlier conversation instead of starting a new one.
- After relaunching with split panes, the pane of the session shown as active now has the keyboard.
- An image added but not sent in one Agent view session no longer goes out with a message in another session.

### Git and review

- Choosing Delete anyway on a branch that another task has open no longer deletes it out from under that task.
- The Review Desk now shows only a task's own changes when the task was started from a branch other than the default one.

### New Session window

- Starting a second task on the same existing branch with a second agent no longer stops at a "branch exists" message; the second agent gets the next free branch name.
- With Launch & next, files you attach while a launch is running now stay for your next task, and the previous task's files are no longer sent again.
- Files attached to a task in the setup wizard now come back when you keep it as a draft.
- Pasting cells copied from a spreadsheet into the task field now pastes their text instead of attaching a picture of them.
