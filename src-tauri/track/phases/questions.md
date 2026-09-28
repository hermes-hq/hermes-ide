# Phase: questions

Before touching code, write down what you do not know. Read feature.md,
look at the parts of the repository the feature touches, and list every
question whose answer changes the design. Answer the ones you can from the
code; leave the rest open for the person driving this feature.

Rules:
- One question per line, as a checkbox: `- [ ] question`. Tick it (`- [x]`)
  once it is answered, and put the answer on the same line after ` — `.
- A question that blocks all further work starts with `!`, e.g.
  `- [ ] ! Which database do we target?`. Hermes shows blocking questions to
  the person right away.
- Keep it short: the file has a line cap. Fewer, sharper questions beat a
  long list.

When the file is written, run `hi phase done`. Hermes then asks the person
to review it before the next phase starts.

## Template
# Questions

## Blocking
- [ ] ! (a question that must be answered before work continues)

## Open
- [ ] (a question you could not answer from the code)

## Answered from the code
- [x] (question) — (answer, with the file that proves it)
