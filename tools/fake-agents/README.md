# Fake agents and recorded sessions

Deterministic stand-ins for real coding agents, so tests need no accounts, no
network and no particular CLI version. Plain Node, no dependencies.

| File | What it is |
|---|---|
| `fake-agent.mjs` | A fake **terminal** agent. Plays a scenario from `scenarios/`: prints a TUI, sends notifications (OSC 2, 9, 9;4, 99, 777, BEL), asks for approval and exits with the code the scenario picks. `--log` writes every input byte, resize and signal it received, plus the environment it saw. |
| `replay-stdio.mjs` | Replays a **cassette** over stdin/stdout. One replayer for every line-delimited JSON protocol: the Claude bridge (`HERMES_BRIDGE_PATH`), ACP and the Codex app-server (JSON-RPC). Covers faults: non-JSON output, torn lines, stderr, hangs, crashes. |
| `record-stdio.mjs` | Records a real session as a cassette. A transparent tee between host and agent; the result is scrubbed. |
| `scrub.mjs` | Deterministic scrubber: home folders, user and host names, e-mails, UUIDs and credential-shaped tokens. `--check` fails on anything left over. |
| `manifest.mjs` | Keeps `cassettes/manifest.json` (agent, version, sha256, scrubber version) in step with the files. |
| `fake-cli.mjs` | A fake **vendor CLI at startup** (`claude`, or any agent that takes `--session-id`, `--resume`, `--settings`). Records how it was started, runs the hooks from its settings file, and can act like a vendor at a folder-trust prompt or one that rejects a resume. |

## Fake terminal agent

```sh
node tools/fake-agents/fake-agent.mjs --scenario approval [--log run.jsonl] [--speed 0]
```

`--scenario` takes a file or a name from `scenarios/`. `--speed 0` skips
sleeps. Exit codes: the scenario's own, 124 when a wait times out, 130 on
Ctrl-C, 143 on SIGTERM, 129 on SIGHUP, 2 on bad usage.

| Scenario | Behaviour |
|---|---|
| `approval` | Full-screen approval box: `y`/`a` exit 0, `n` exit 3 |
| `question` | Multiple choice: `1`/`2` exit 0, other keys exit 4 |
| `exit-error` | Exit 1 |
| `crash` | Killed by SIGKILL (a shell reports 137) |
| `hang` | Never returns |
| `big-osc` | A 64 KB OSC 9 |
| `invalid-utf8` | Bytes that are not UTF-8 |
| `alt-screen-left-on` | Exits inside the alternate screen |
| `bracketed-paste` | Reports one bracketed paste |
| `resize` | Reports a resize |

Steps: `print, sleep, title, osc9, progress, osc99, osc777, bigOsc, bell, raw,
split, altScreen, modes, box, size, waitKey, waitPaste, waitResize, hang, kill,
exit`.

## Fake vendor CLI

```sh
node tools/fake-agents/fake-cli.mjs [--session-id <id>] [--resume <id>] [--settings <file>] [prompt]
```

Like the real CLI it takes `--session-id` as its conversation id (or invents
one), continues a conversation with `--resume <id>`, reads the `--settings`
file and runs its `SessionStart` and `SessionEnd` hooks with the same JSON on
stdin that Claude Code sends, then behaves as a small TUI (`q` quits).

Behaviour per launch, from `HERMES_FAKE_MODE` or the file
`<HERMES_FAKE_DIR>/mode` (so a scenario can change it between app launches):

| mode | behaviour |
|---|---|
| `normal` | starts at once |
| `trust-prompt` | shows a "Do you trust the files in this folder?" dialog and holds every hook back until a key is pressed (`y` continues, `n` exits), as a vendor does in a folder it has not seen |
| `resume-fails` | rejects `--resume` at once (exit 1), as a vendor does for an id it does not know |
| `ignore-resume` | accepts `--resume` but starts a new conversation under a new id anyway (a broken vendor; the negative control of the resume checks) |
| `rate-limit` | starts, writes `src/login.ts` and appends to `README.md` in its folder, runs the settings file's status line with `rate_limits` (five_hour used up, resetting at `<HERMES_FAKE_DIR>/resets_at`, epoch seconds, or in two hours) and ends the turn on its usage limit: the `StopFailure` hooks with `error: "rate_limit"`, as Claude Code 2.1.283 does |
| `server-error` | the same, but the turn ends on `error: "server_error"` (not a limit; the negative control of the limit checks) |

In any mode the key `r` stands for "the limit reset and the agent goes on":
the `Notification` hooks run with `notification_type: "quota_auto_resume_fired"`.
The key `l` ends another turn on the usage limit (the status line and the
`StopFailure` hooks again, without editing files).
Hook groups with a `matcher` run only when it matches (the error of a
`StopFailure`, the notification type of a `Notification`, the tool of a tool
event), like the real CLI.

With `HERMES_FAKE_DIR` set, every launch is recorded to
`<HERMES_FAKE_DIR>/launch-<n>.json`: argv, cwd, the Hermes environment it
saw, the settings file's contents, which hooks ran and how it ended.
`e2e/app/scenarios/N12-launch-and-resume.mjs` puts a `claude` shim that runs
this file first on the app's PATH and reads those records;
`e2e/app/scenarios/N19-limits-and-handoff.mjs` does the same with a `claude`
and a `codex` shim. Tests:
`tools/fake-agents/test/fake-cli.test.mjs`.

## Replaying a cassette

```sh
HERMES_BRIDGE_PATH=tools/fake-agents/replay-stdio.mjs \
HERMES_FAKE_CASSETTE=tools/fake-agents/cassettes/claude-bridge/2.1.283/approval-bash.jsonl \
HERMES_FAKE_SPEED=0
```

A cassette is JSON lines: `header`, `emit`, `expect` (with `branch` and
`capture`), `label`, `goto`, `stderr`, `garbage`, `partial`, `hang`, `crash`,
`exit`. See the top of `replay-stdio.mjs`. Exit 97 means an expected input
never came; 98 means the cassette is broken.

Layout: `cassettes/<agent>/<agent version>/<scenario>.jsonl`. After adding or
changing one, run `node tools/fake-agents/manifest.mjs --write`.

## Recording

Record only in a throwaway folder with made-up content.

```sh
node tools/fake-agents/record-stdio.mjs --out new.jsonl --agent <name> --agent-version <v> -- <command> [args...]
node tools/fake-agents/scrub.mjs --check new.jsonl
```

## Tests

`npx vitest run tools` runs the kit's tests, including the gate that fails on
anything the scrubber would still remove from a committed fixture. The
real-app scenario `e2e/app/scenarios/N03-fake-agent.mjs` runs the fake agent
inside a Hermes terminal with whatever shell it starts (a POSIX shell,
PowerShell or cmd.exe). Test cases that depend on POSIX signals are skipped on
Windows.
