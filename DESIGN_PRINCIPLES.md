# Hermes IDE — Design Principles

These principles guide every decision about what Hermes IDE is and isn't. They are ordered by priority. When principles conflict, higher wins.

## 0. Terminal-faithful first; structured views are optional

Every agent runs in its own terminal interface by default, byte for byte. Hermes observes only what the agent reports on purpose (its hooks, notifications, exit codes) and what git shows. Supervision (status, history, review, landing) works the same for every agent. Hermes never types into a terminal on its own; the only allowed write is one visible line you trigger yourself.

A structured view (today: the optional Agent view for Claude) is something a user opts into per session. It is built only for an agent with a documented, stable machine protocol, and only when it gives users something the agent's own interface cannot. See [ADR 003](docs/adr/003-terminal-first-vendor-neutral.md).

Three rules follow from this:

- **Observe, never answer.** Hermes reads agent signals but never answers a permission prompt or a question on your behalf.
- **Status is honest.** Every status shows its source (exact, signal or guessed).
- **Every new surface retires one.** A change that adds a panel, mode or view names the one it removes.

We ask: **"Would this work the same for every agent, without faking what the agent did not report?"** If not, it does not belong in the default path.

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
