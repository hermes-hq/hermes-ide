# Feature Tracks

Bigger work gets guided phases — questions, research, design, structure,
plan, implement — as short markdown files in the repository, reviewed in
your own editor, with Hermes telling you when a phase waits on you. Any
agent drives it from any terminal, with the files and the `hi` helper;
nothing is vendor-specific. Behind the `featureTracks` flag while it proves
itself.

## The files are the API

One feature is one `hermes/<slug>` branch, one worktree and one folder:

```
.hermes/features/<slug>/
  feature.md      front matter: slug, track, phase, gate, done_when; then the description
  questions.md    - [ ] question   (- [x] answered;  `!` first = blocking, shown in the inbox)
  research.md, design.md, structure.md, plan.md   one file per phase, each with a line cap
  review-<n>.md   your edits, sent back to the agent with r
.hermes/phases/<phase>.md    the prompt for each phase (seeded per repository, edit freely)
.claude/commands/hermes-phase.md   the one generated slash command (/hermes-phase plan)
```

Tracks: **Quick** creates nothing at all (just do the work); **Light** runs
questions → plan → implement; **Full** runs every phase. Any phase can be
skipped.

Line caps: questions 40, research 80, design 80, structure 60, plan 120.
`hi phase done` and `hi feature check` refuse a file over its cap.

## The `hi` helper

`hi` is on PATH in every Hermes shell while the flag is on.

| Command | What it does |
|---|---|
| `hi feature new <slug> [--track Quick\|Light\|Full] [--title T] [--no-branch]` | Creates the folder (not for Quick), seeds `.hermes/phases/` and the slash command, switches to `hermes/<slug>` |
| `hi phase [name]` | Starts (or re-prints) a phase: prints its prompt, creates `<phase>.md` from the template, sets `phase:` and `gate: none` |
| `hi phase done` | Hands the phase over: `gate: waiting`. Hermes raises a ◆ inbox item |
| `hi phase skip` | Moves to the next phase without a review (not past a waiting gate) |
| `hi approve` | A person approves the waiting gate: `phase: <next>`, `gate: approved`. **Refuses when `HERMES_AGENT` is set** (every agent Hermes launches has it) |
| `hi feature check` | Front matter, caps, missing files; exit 4 on a problem (`hi check` runs the repository's Done-When checks instead) |
| `hi status [--all]` | Plain text: every feature, and what is blocked on you. `--all` covers every worktree of the repository (works over SSH) |
| `hi land [--body-file F]` | Archives the track files as `refs/hermes/archive/<slug>`, removes them from the branch and the worktree so they stay out of the merge, and writes the pull-request title and body from feature.md + plan.md. People only |

Exit codes: 0 ok · 2 usage · 3 people only · 4 refused by the state machine.

## The Track view

Right rail → **Track** (while the flag is on). It shows the worktree's
feature: phases, the gate, the questions, the current file's size against
its cap, and whether this session is the **writer** (the agent that drives
the feature; `r` types into its terminal) or a **reader**. The writer is the
session in the worktree with a turn history (an agent Hermes started and
observed), the oldest of them when several have one; when no session has
run a turn yet — an agent you typed into a plain shell — the oldest session
in the worktree is the writer. So a shell you opened before starting the
agent does not receive your edits by seniority; check the role in the
panel's header before pressing r.

| Key (panel focused) | Action |
|---|---|
| ⌘⏎ / Ctrl+⏎ | Approve the waiting gate (also in the command palette: *Approve gate*) |
| o | Preview the phase file in the panel |
| ⇧O | Open it in `$EDITOR` in a split next to this pane |
| r | Send your edits back: a diff against the version the agent handed over goes to `review-<n>.md`, and one tagged line is typed into the writer's terminal (because you pressed r; Hermes never types on its own) |
| s | Skip the phase |

**Make it a feature** (panel or palette) promotes a session's worktree to a
feature folder and, exactly like `hi feature new`, puts the worktree on
`hermes/<slug>` when it is not there yet (the slug comes from the branch —
`hermes/<slug>` or the branch name — else from the folder's name). The
branch step is never fatal: the folder is what matters, and the toast says
what happened to the branch.

## Gates are protected by the turn history

`hi approve` refuses agents by environment, but an agent can edit
feature.md by hand. Hermes watches the file: a `gate: approved` that it did
not write itself, landing while an attached session is in a turn (the
session's turn events, contract C0), is reverted to `waiting` and raised as
an error item in the inbox. An approval outside every turn (you ran
`hi approve` in your own shell) is accepted.

The guard is soft, and it is only as good as what Hermes can see:

- Both checks depend on the agent having been started through Hermes (the
  `launchHelper` path): that is where `HERMES_AGENT` is set and where the
  turn events come from. An agent you start by typing its command into a
  plain Hermes terminal has neither, so it can run `hi approve` unrefused
  and its hand edits fall outside every turn — they are accepted as yours.
- Only an approval is guarded. An agent that skips a gate instead — editing
  `phase: <next>` together with `gate: none` by hand, or running
  `hi phase skip` before handing the phase over — is not detected; the
  panel simply shows the next phase in progress. `hi phase skip` refuses
  while a gate is waiting, and `hi land` refuses agents, so the last word on
  merging stays with a person.

## Proof

`e2e/app/scenarios/F28-feature-tracks.mjs` drives the real app with a fake
agent (`e2e/app/fixtures/track-agent.mjs`) through a whole Light track,
with a second fake session as reader. `HERMES_E2E_F28_GATE_BUDGET_MS=0`
is the negative control. Unit tests: `src-tauri/track` (the crate the app
and `hi` share), `src-tauri/hi/tests/track.rs`, `src/__tests__/track-*.test.*`.
