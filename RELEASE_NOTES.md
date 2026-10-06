# Hermes IDE 2.1.2

## New

- Open a session in any folder, git or not: a plain folder, a parent folder that holds several projects, or a mix. A folder that is not a git repository opens directly, with no worktree, and the agent is told it may create a worktree or branch itself if it needs to change code in a repository inside it.

## Fixes

- Hovering an icon in the left bar now shows a clean label beside it, instead of text drawn over the sidebar.
- On Windows, an agent's activity is no longer mixed up with unrelated system processes, so its status (working, running a command, idle) is reported correctly.
- In a session whose folder is not a git repository but contains git projects, the Review Desk now explains this instead of saying there is no repository.
