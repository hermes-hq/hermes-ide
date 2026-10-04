#!/usr/bin/env node
// HOD-persona-launch: a library persona at launch, for every agent, through
// the real task launcher. Fake `claude` and `codex` record their argv.
//
//   A  From the Library: open the "Code reviewer" persona, "Start as Code
//      reviewer". The launcher opens with an "Act as: Code reviewer" chip
//      and says how each agent gets it. A task, Launch with Claude Code:
//      the persona travels as its system prompt (--append-system-prompt
//      <persona>, the flag proven with the real CLI) and the task is the
//      first prompt, alone.
//   B  In the launcher, Codex selected, "Prompts" (the one palette, in the
//      launcher's place, filtered to entries that work in Codex): the same
//      persona is picked, then a prompt with an argument fills the task (its
//      chip names the prompt). Launch: Codex has no proven system-prompt flag, so its
//      first prompt is the persona followed by the task, and there is no
//      --append-system-prompt.
//   C  A persona with no task (Codex): the first prompt is the persona and
//      asks the agent to wait for the task.
//
// Negative control: HERMES_E2E_HOD_NEGATIVE=no-persona removes the persona
// chip before each launch; the persona checks must then fail.

import { join } from "node:path";
import { launcherState, openLauncher, pickInMenu, typeInto, waitLaunchEnabled, waitLauncherClosed, waitLauncherReady } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { openEntry, openLibrary, search } from "../library-steps.mjs";

const NAME = "HOD-persona-launch";
const NEGATIVE = process.env.HERMES_E2E_HOD_NEGATIVE === "no-persona";
const PERSONA_HEAD = "From now on, work as this persona: Code reviewer.";
const PERSONA_BODY = "You are a senior engineer reviewing someone else's change.";

async function waitNewRecord(fx, before, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (fx.records().length <= before && Date.now() < deadline) await sleep(250);
  return fx.records()[before] ?? null;
}

async function dropPersonaIfNegative(bridge) {
  if (!NEGATIVE) return;
  await bridge.eval(`const b = e2e.first(".task-launcher-library-persona button"); if (b) e2e.click(b); return true;`);
  await sleep(300);
}

async function pickFromLibrary(bridge, query, id, args = {}) {
  // Prompts (⌘J) takes the launcher sheet's place; the launcher keeps everything set.
  await bridge.clickWhenReady(`return e2e.first('[data-testid="prompt-picker"]') ? true : e2e.click(e2e.must(e2e.first(".task-launcher-from-library"), "Prompts"));`);
  await bridge.waitFor("Prompts", `return !!e2e.first('[data-testid="prompt-picker"][data-context="launcher"] .pp-input');`, { timeoutMs: 20_000 });
  await typeInto(bridge, ".pp-input", query);
  await bridge.waitFor(`${id} among the results`, `return !!e2e.first('.pp-row[data-entry="${id}"]') && e2e.first(".pp-list")?.getAttribute("data-busy") !== "true";`, { timeoutMs: 20_000 });
  // The list may still re-render once for the typed query: click until the entry is the chosen one.
  await bridge.waitFor(`${id} chosen`, `
    if (e2e.first(".pp-pane-inner")?.getAttribute("data-entry") === "${id}") return true;
    const r = e2e.first('.pp-row[data-entry="${id}"]');
    if (r) r.click();
    return false;
  `, { timeoutMs: 20_000, intervalMs: 700 });
  for (const [name, value] of Object.entries(args)) {
    await bridge.waitFor(`the ${name} field`, `return !!e2e.first('.pp-field[data-arg="${name}"] textarea, .pp-field[data-arg="${name}"] input');`, { timeoutMs: 10_000 });
    await typeInto(bridge, `.pp-field[data-arg="${name}"] textarea, .pp-field[data-arg="${name}"] input`, value);
  }
  await bridge.waitFor("nothing left to fill in", `return !e2e.first(".pp-left");`);
  await bridge.click(".pp-primary");
  await bridge.waitFor("Prompts to close", `return !e2e.first('[data-testid="prompt-picker"]');`);
}

const how = (bridge) =>
  bridge.eval(`return e2e.all('[data-testid="launcher-persona-how"] [data-agent]').map((s) => ({ agent: s.getAttribute("data-agent"), delivery: s.getAttribute("data-delivery"), text: e2e.norm(s.innerText) }));`);

await runLauncherQa(
  NAME,
  async ({ bridge, fx, log, check, evidenceDir }) => {
    // A — from the Library, Claude Code.
    await openLibrary(bridge);
    await search(bridge, "code reviewer");
    await openEntry(bridge, "code-reviewer");
    await bridge.screenshot(join(evidenceDir, "01-persona-detail.png"));
    await bridge.click(".lib-start");
    await waitLauncherReady(bridge);
    const chip = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-library-persona")?.innerText ?? "");`);
    log(`  launcher persona chip: "${chip}"`);
    check(/Act as: Code reviewer/.test(chip), "the launcher opens with the persona chip");
    await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
    await sleep(500);
    const howA = await how(bridge);
    log(`  how: ${JSON.stringify(howA)}`);
    check(howA.some((h) => h.agent === "claude" && h.delivery === "system" && h.text.includes("--append-system-prompt")), "it says Claude Code gets the role as a system prompt");
    await typeInto(bridge, ".task-launcher-task", "Review the auth change");
    await dropPersonaIfNegative(bridge);
    await waitLaunchEnabled(bridge);
    await bridge.screenshot(join(evidenceDir, "02-launcher-claude.png"));
    let before = fx.records().length;
    await bridge.click(".task-launcher-launch");
    await waitLauncherClosed(bridge);
    const claude = await waitNewRecord(fx, before);
    const argv = claude?.argv ?? [];
    const at = argv.indexOf("--append-system-prompt");
    log(`  claude argv: ${JSON.stringify(argv.map((a) => (a.length > 80 ? `${a.slice(0, 80)}…(${a.length})` : a)))}`);
    check(at >= 0 && argv[at + 1]?.startsWith(PERSONA_HEAD) && argv[at + 1].includes(PERSONA_BODY), "Claude Code got the persona as --append-system-prompt");
    // Hermes adds its usual pointer to the session's context file after the task.
    check(argv[argv.length - 1].split(/\r?\n\r?\n|\s+Read the file at /)[0] === "Review the auth change" && !argv[argv.length - 1].includes(PERSONA_HEAD), "and the task alone (no persona) as its first prompt");

    // B — in the launcher, Codex, From library: persona then a prompt.
    await openLauncher(bridge);
    await pickInMenu(bridge, "agent", '[data-agent-id="codex"]');
    await sleep(600);
    await pickFromLibrary(bridge, "code reviewer", "code-reviewer");
    await pickFromLibrary(bridge, "review ai generated code", "review-ai-generated-code", { diff: "diff --git a/cart.py b/cart.py" });
    const st = await launcherState(bridge);
    const chips = await bridge.eval(`return { prompt: e2e.norm(e2e.first(".task-launcher-library-prompt")?.innerText ?? ""), persona: e2e.norm(e2e.first(".task-launcher-library-persona")?.innerText ?? "") };`);
    const howB = await how(bridge);
    log(`  chips: ${JSON.stringify(chips)}; task starts ${JSON.stringify((st.task ?? "").slice(0, 60))}; how ${JSON.stringify(howB)}`);
    check(/^Prompt: .*review/i.test(chips.prompt), "the task came from the library prompt (its chip names it)");
    check((st.task ?? "").includes("diff --git a/cart.py b/cart.py"), "rendered with the argument");
    check(howB.some((h) => h.agent === "codex" && h.delivery === "first-message"), "it says Codex gets the role in its first prompt");
    await dropPersonaIfNegative(bridge);
    await waitLaunchEnabled(bridge);
    await bridge.screenshot(join(evidenceDir, "03-launcher-codex.png"));
    before = fx.records().length;
    await bridge.click(".task-launcher-launch");
    await waitLauncherClosed(bridge);
    const codex = await waitNewRecord(fx, before);
    const cargv = codex?.argv ?? [];
    // The prompt is codex's last argument (the fake does not know every codex flag).
    const first = cargv[cargv.length - 1] ?? "";
    log(`  codex first prompt (${first.length} chars) starts ${JSON.stringify(first.slice(0, 80))}`);
    check(!cargv.includes("--append-system-prompt"), "Codex gets no system-prompt flag");
    check(first.startsWith(PERSONA_HEAD) && first.includes(PERSONA_BODY), "its first prompt starts with the persona");
    check(first.includes("diff --git a/cart.py b/cart.py") && first.indexOf("diff --git") > first.indexOf(PERSONA_BODY), "followed by the task");

    // C — a persona alone, Codex.
    await openLauncher(bridge);
    await pickInMenu(bridge, "agent", '[data-agent-id="codex"]');
    await sleep(600);
    await pickFromLibrary(bridge, "code reviewer", "code-reviewer");
    await dropPersonaIfNegative(bridge);
    await waitLaunchEnabled(bridge).catch(() => null);
    before = fx.records().length;
    await bridge.click(".task-launcher-launch");
    await waitLauncherClosed(bridge).catch(() => null);
    const alone = await waitNewRecord(fx, before, 30_000);
    const p = (alone?.argv ?? []).slice(-1)[0] ?? "";
    log(`  persona alone: first prompt (${p.length} chars) ends ${JSON.stringify(p.slice(-200))}`);
    check(p.startsWith(PERSONA_HEAD) && p.includes('Reply "ready" and wait for my task.'), "a persona with no task asks the agent to wait for the task");
  },
  { tag: "hod-persona" },
);
