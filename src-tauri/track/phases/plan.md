# Phase: plan

Turn the design into an ordered list of steps a person can review in a
minute and an agent can execute one at a time. Every step names the files it
touches and how it is verified.

Rules:
- Steps are checkboxes: `- [ ] step`. Tick them as they land during the
  implement phase.
- Each step is small enough to review as one diff.
- The last steps are the checks: tests, lint, and the real-app proof.
- Respect the line cap; a longer plan means the feature is too big.

Run `hi phase done` when the plan is ready. Hermes asks the person to approve
it before implementation starts.

## Template
# Plan

- [ ] (step) — files: (paths) — verify: (command or check)
- [ ] (step) — files: (paths) — verify: (command or check)
- [ ] Run the checks — verify: (test command)
