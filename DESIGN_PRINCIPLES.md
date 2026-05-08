# Hermes IDE — Design Principles

These principles guide every decision about what Hermes IDE is and isn't. They are ordered by priority. When principles conflict, higher wins.

## 0. Agent-native for Claude, terminal-faithful for everything else

Starting with v1.0.0, Hermes IDE is an **agent-native** surface for Claude Code: we talk to Claude through its structured stream-json protocol, render real messages and tool calls as first-class UI, and stop pretending a terminal is a chat. For every other AI provider — and for any user who explicitly wants a terminal — we remain **terminal-faithful**: an honest, polished xterm host that doesn't get in the way.

The decision rule: if a piece of UI exists to help a user **converse with Claude**, it belongs to Agent mode and should consume Claude's structured events directly. If it exists to help a user **run a program**, it belongs to Terminal mode and should stay out of the program's way.

We ask: **"Are we faking chat by typing into a TTY?"** If yes, the right answer is Agent mode, not a cleverer puppet show.

## 1. Focused, not full-featured

Hermes IDE solves a specific set of problems exceptionally well rather than solving every problem adequately. We will always have fewer features than IntelliJ, VS Code, or Emacs. That is intentional.

We ask: **"Does removing this make the product worse for 80%+ of users?"** If no, it doesn't belong in core.

## 2. Fast by default

Every feature costs performance — startup time, memory, cognitive overhead, maintenance. A feature must justify its weight.

We ask: **"Does this make the app slower or heavier?"** If yes, it needs extraordinary justification.

## 3. Opinionated over configurable

We make decisions so users don't have to. Fewer settings means fewer things to break, less documentation, faster onboarding.

We ask: **"Can we pick one good default instead of adding a setting?"**

## 4. Core vs. Extension

If a feature serves a subset of users, it belongs in an extension, not core. Core features are things every user interacts with.

- **Core examples:** terminal emulation, AI chat, file navigation
- **Extension examples:** language-specific support, third-party integrations

## 5. Stable over novel

We don't add features to chase trends. A feature must solve a demonstrated problem. "Other editors have this" is not sufficient justification.

## 6. Saying "no" is a feature

Every feature we reject makes the features we accept better. Focus is an ongoing, active effort.

---

## When Evaluating Any Proposal

1. Does this align with the project's core purpose?
2. Would 80%+ of users benefit?
3. Can this be an extension instead?
4. What is the ongoing maintenance cost?
5. Does it add cognitive overhead for users who don't use it?
6. Is this the simplest possible solution?

If any answer raises concern, the default is **"no"** or **"not yet."**
