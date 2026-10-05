# Hermes IDE 2.1.0

Hermes 2.1 brings thousands of ready-made prompts into the app and keeps old task folders from quietly filling your disk.

## Prompts, built in

- Press ⌘J (Ctrl+Shift+M on Windows and Linux) in any session to open **Prompts**: thousands of expert prompts, personas and answer styles for work, learning and everyday life, from Hodios, the free and open prompt library.
- Search as you type, filter by kind, and see what fits the project you have open first, with a short reason on each suggestion. Pinned and recent prompts come first, so ⌘J then Return runs your last one again.
- Pick a prompt, fill in its blanks in plain fields with help under each, and press Return to put it in the agent's input, or ⌘⇧Return to send it straight away. Text you selected in the terminal fills the first blank.
- Add a persona ("Act as") and an answer style to any prompt. A persona chosen when you start a task reaches the agent as its role, for every agent.
- The task launcher opens the same Prompts window, so starting a task from a prompt takes two keys.
- The library is in the app from the first launch and works offline. New prompts arrive by themselves twice a day, and Hermes only applies an update that is signed by the library and checks every file. Your projects are never changed.

## Your own prompts are kept

- The Prompt Composer and the template lists are replaced by Prompts. Everything you saved in 2.0 is under **Mine**, with exactly the text it sent before: templates become prompts, groups become folders, and your own roles and styles become your personas and answer styles.
- Save any prompt you have filled in to Mine, and export or import your prompts in the same file format as 2.0.
- Prompts you opened in 2.0 by their old names still open the matching prompt in the library.

## Old task folders no longer fill your disk

- Hermes now cleans up after itself in the background: it removes what can be rebuilt (dependencies and build output) from task folders you have not used for a week, and task folders whose work is merged and has nothing uncommitted.
- A task folder with uncommitted or unpushed work is never removed on its own. When you remove one yourself, Hermes keeps a copy of the work in your repository first and tells you how to bring it back.
- Settings → Storage shows the space each project's task folders take, when each was last used and what can be freed safely, with a "Clean up now" button.
- Hermes warns you when your disk is running low, instead of failing later.

## Fixes

- Task folders left behind by sessions that ended without being closed (a quit, a crash, a restore that failed) are now found and tidied up safely, instead of staying on disk forever.
- Two clean-up paths that could delete a folder that still held uncommitted changes now keep it.
- An agent's first turn is no longer sometimes missing from its history when the agent reports its start a moment late.
