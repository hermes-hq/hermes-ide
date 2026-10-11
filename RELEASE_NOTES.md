# Hermes IDE 2.2.2

## Fixes

- Archiving a task while its agent is working now stops the agent first, so files it writes in its last moments are no longer deleted with the task folder.
- If a task's folder is deleted while its session is open, the Git panel now says so instead of committing, discarding or switching branches in your main project folder.
- Choosing Delete anyway on a branch that another task has open now explains in plain words why it is kept.
