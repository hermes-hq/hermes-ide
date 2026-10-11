# Hermes IDE 2.2.3

## Fixes

### Agent view

- Closing, converting or restarting an Agent view session while Claude is working now stops that work, instead of leaving it running in the background.
- When Claude asks for several approvals at once, each prompt now appears in turn, so a turn no longer hangs on a prompt you never saw.
- Pressing Stop no longer shows a "Claude couldn't continue" error or marks the session as failed.
- If you press Stop while Claude is waiting for your approval, the approval prompt now goes away and the session no longer shows that it needs approval.
- Stopping a reply no longer adds a message you never typed to the conversation or throws off the turn numbers.
- The first message to a new or restarted session now starts about three seconds sooner.
- On Windows, permission rules and MCP server settings now load and save correctly when Hermes is opened from the Start menu.
- Adding a permission rule now offers only the places it can be saved, and the new rule shows in the list right away.
- Saving permission rules or MCP servers no longer breaks Claude settings files linked from a dotfiles folder, and keeps their file permissions.

### Editor and files

- The file editor no longer saves over changes an agent made to the open file. It tells you the file changed and lets you reload it or keep your version.
- Opening a file with Windows line endings no longer rewrites it, and edits keep its original line endings.
- Files that aren't UTF-8 text now open read-only, so saving can no longer corrupt their accented characters.
- On Windows and Linux, Alt+Up/Down in the file editor moves the line without also switching to another pane.
- The File Explorer right-click menu no longer shows actions that did nothing.

### Terminal

- Dropping a file whose name has brackets, quotes or $ into a terminal now inserts its exact path.

### Status and attention

- Pressing Esc to interrupt an agent now lets the computer sleep again and frees the agent's place in the task queue.
- A spend-limit or gate-approval alert now leaves the attention inbox and badge once you raise the limit or approve the gate yourself.
- An agent left idle for a minute no longer shows as waiting for your answer after it has finished.
- The inbox shortcut in a session's status bar now opens the attention inbox, and Windows and Linux show the correct shortcut, Ctrl+Shift+I.

### Git and review

- Merging a task locally a second time from the same branch no longer reports a false conflict or lists changes that already landed.
- Opening the Review Desk on a large project no longer freezes the app while the changes load.
- Files with accented or non-Latin names now show their real names in the Review Desk and in review notes sent to the agent.
- Review Desk line counts now include lines that begin with dashes or plus signs, such as Markdown separators or SQL comments.

### Sessions and settings

- Opening Hermes a second time on the same data now explains that it is already running, instead of opening the same sessions twice.
- Cancelling the quit dialog while an agent is working no longer stops your layout, notes and renames from being saved on a later quit.
- Choosing a folder that is already in your project list now selects that project instead of doing nothing.
- A maximized window now reopens maximized, and fullscreen no longer replaces the saved window size.
- Importing settings now adds to your own prompts instead of replacing them.
- Unpinning an entry in the Library now sticks, instead of the entry coming back pinned every time the Library opens.
- Installing a plugin with a broken id is now refused, and no longer removes your other installed plugins.
