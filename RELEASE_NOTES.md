# Hermes IDE 2.3.4

Everyday prompts come first in the Library, and the commands above each session are rebuilt for every agent.

## New

- The Library opens with "What do you want to do?": type a plain request like "plan a 5-day trip to Lisbon" or "diet", or pick Write, Plan, Learn, Decide and more, and the right prompt comes first.
- Essentials: the things people ask most, from planning a trip to reviewing a pull request. Each one asks a few questions first, so it works from a blank start.
- Every category now shows its "Start here" prompts first, then the more specific and advanced ones in their own sections.
- Words from your search are filled into the prompt for you, so "Lisbon, 5 days" is already there when you open "Plan a trip".
- Health, money and legal prompts are labelled and include safety checks.
- The Library has a Recent section, and you can browse each area by category.
- The prompt picker (⌘J) searches with the task you already typed.
- The bar above each session now works the same way for every agent, including Antigravity, OpenCode and Kiro: Model, Plan and Review are always in the same place, and you can pin the ones you use.
- A context meter shows how full the conversation is, and offers Compact when it gets close to full.
- The Commands list includes your own commands and skills, each with a short description, and your recent ones.

## Fixed

- Clicking a command never touches what you were typing, and it only runs when the agent is waiting.
- Starting a new chat, resetting or signing out asks first and says what you lose.
- Command lists match each agent's current version.
- In short panes, the bars above and below a session fold into its header, so the agent has more room.
- Scrolling back through a terminal is no longer interrupted when the window resizes.
- Search no longer comes up empty when not every word matches.
- A Claude Code, Codex or Gemini CLI session keeps showing its own model (and its cost) when the conversation mentions another company's model.
- A session pane no longer stops working at some window widths.
- Library search answers faster.
