# Hermes IDE 2.1.3

## Fixes

- Reopening a closed session shows its earlier history above the new prompt, not below it.
- Hermes no longer types its "read the project context" reminder into a message you've started writing, or into the shell after an agent has exited; it waits until the agent is ready.
- When you open a folder inside a git repository, the New Session wizard now names that repository instead of calling the folder "not a git repository". The session still opens directly in the folder.
- On macOS, an agent could sometimes stay marked as starting after it was already up. It now shows as started.
- The start screen's recent sessions show when they were really closed, instead of hours off in some time zones.
- Updated the app's libraries to their latest versions.
