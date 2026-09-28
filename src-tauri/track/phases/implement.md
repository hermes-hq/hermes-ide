# Phase: implement

Execute plan.md step by step. Tick each step in plan.md as it lands, and
keep the diff of each step small enough to review on its own.

Rules:
- Follow the plan; when the plan turns out wrong, change plan.md first and
  say why in one line, then continue.
- Run the checks listed in the plan (and feature.md's done_when, if any)
  before saying you are finished.
- Do not edit feature.md's `gate:` line; approvals come from a person.

Run `hi phase done` when every step is ticked and the checks pass. The
person then reviews and lands the feature from Hermes.

## Template
