# Worktree recipes (`.hermes/worktree.toml`)

A new task gets its own worktree: a fresh checkout with none of your local
setup in it. A recipe tells Hermes how to make that checkout ready to work,
before any agent starts in it.

```toml
# .hermes/worktree.toml
setup = ["npm ci", "npm run build:types"]   # run in the new worktree, in order
copy = [".env", "apps/*/.env.local"]        # files git ignores, copied from the project folder
done_when = ["npm test"]                    # the default checks for Done-When

[ports]
web = 3000                                  # HERMES_PORT_WEB for the setup commands
```

Commit the file so every branch has it. Until it is committed, Hermes uses
the one in the project folder.

## What happens when a task starts

1. The first time Hermes sees the file (and again whenever it changes), it
   shows the commands and asks. Nothing runs until you choose **Run setup**.
   **Skip** starts the session without setup.
2. `copy` copies the files each pattern matches from the project folder into
   the same place in the new worktree. A file already there is kept.
3. Each name in `[ports]` gets the first free port at or above its number
   that no other worktree was given, as `HERMES_PORT_<NAME>`.
4. `setup` runs in order in the worktree (`sh` on macOS and Linux, `cmd` on
   Windows). The first command that fails stops the rest.
5. The session starts once setup is done.

The log streams in the **Worktree setup** card while it runs. **Stop** ends
the running command. A failure stays in the card and is added to the inbox.

No `worktree.toml`: nothing changes.

## Patterns

`*` and `?` match within one name, `**` matches any number of folders (it
does not go into folders git ignores, such as `node_modules`). A pattern
without `/` matches in the top folder only. Patterns can't start with `/`,
use `..`, or reach into `.git`.

`copy` only takes files **git ignores**. A pattern that matches a file git
tracks, or one git does not ignore, is refused as a whole with a message,
and setup does not run: copying is for local secrets and caches, never for
files that belong in a commit.

## Secrets

Hermes copies files from disk to disk; their contents never pass through the
app. Values found in copied files (`KEY=value` lines) are masked in the setup
log. The log is kept in memory only: it is never written to disk, the
database, the app's own log or a settings export. The only thing Hermes
stores is a hash of the recipe file you allowed to run.
