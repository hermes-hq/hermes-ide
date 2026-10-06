# Hermes IDE 2.1.1

## Fixes

- Agents start reliably in project folders that macOS protects (Documents, Desktop, iCloud Drive and similar). If a new terminal briefly cannot find its folder, Hermes moves into the project folder before starting the agent, so the agent no longer stops with a confusing "low max file descriptors" error. If the folder really cannot be read, the session says which folder it is and how to allow access in System Settings → Privacy & Security.
- Hermes no longer types its launch line into a command you've started typing.
- Hermes and its terminals get a higher limit on open files, so agents have room to start.
- Agents start cleanly when the terminal resizes at the moment they launch.
- Agent view sessions show their earlier conversation again after a restart, and the stray STDERR panel no longer appears.
- A check you add in the task launcher is no longer lost if you click right as the repository's settings load.
- The Context panel lists the project's pins and updates when they change.
- The Track panel no longer calls a large file being written "too large (0 B)".
- After a relaunch, restored terminal history appears above the new prompt again, not below it.
