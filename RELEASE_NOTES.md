# Hermes IDE 2.3.0

Picking a project when you start a task is now quick, even with dozens of projects, and a task can work across several folders at once.

## New

- The project menu in the task launcher has a search box. Start typing a project's name or part of its folder path to find it, then press Enter.
- Press ⌘P (Ctrl+P on Windows and Linux) in the task launcher to open the project menu.
- The projects you used most lately appear at the top, and everything else follows in alphabetical order.
- Each project takes one line, and only the part of its folder path that tells it apart from your other projects is shown.
- You can remove a project from the list. Its files stay on disk.
- Projects whose folder no longer exists are listed at the bottom, so you can remove them.
- "Open folder…" and "New project…" are always visible below the list.
- Type a folder path into the search box to start a task in a folder that isn't a project yet.
- Give Claude more than one folder: tick up to 5 extra folders (or press Shift+Enter on one) next to your main project. The project chip shows how many you added, and a line under the chips lists each extra folder with its current branch and any uncommitted changes.
- Only the main project gets the task's new branch. Extra folders are worked on where they are, on the branch they are on, so you only have one branch to review and land.
- Hermes tells you when a folder can't be added, for example because it's the same repository as one you already picked or it sits inside your main project.

## Changed

- Anonymous usage statistics are now on by default to help us improve Hermes. They never include your code, prompts, file names or anything that identifies you. If you have turned them off, they stay off, and you can turn them off anytime in Settings > Privacy.
