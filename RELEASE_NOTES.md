# Hermes IDE 2.3.3

Attaching a project to a running session tells the agent about it again, and Gemini 4 Argon is ready to use.

## Fixed

- When you attach a project to a running terminal session, the agent now gets the message to read the updated project context. Before, the message could sit unsent in Claude's input box, or never arrive after Hermes restarted, after you had typed something, or when you closed the project picker quickly.
- Gemini 4 Argon is recognized in terminal sessions, and its estimated cost uses its own price instead of a generic one.
- A security update for a networking component Hermes uses.
