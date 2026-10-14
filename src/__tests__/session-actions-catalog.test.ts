/**
 * Session actions: one source of truth (the agent catalog) for every
 * agent's commands, mapped onto the cross-agent actions. Pure rules: which
 * command an action is per agent, which chips show and in what order, the
 * context chip, the state chip, the Commands list's sections, and how the
 * bar fits its pane.
 */
import { describe, expect, it } from "vitest";
import { AGENT_CATALOG } from "../catalog/agentCatalog";
import {
  ACTION_IDS,
  DEFAULT_PINNED,
  agentIdOf,
  builtinCommands,
  catalogCommandMessages,
  chipsFor,
  commandForAction,
  commandSlug,
  contextChip,
  matchTypedCommand,
  type SessionActionId,
} from "../sessionActions/catalog";
import { stateChipFor, takesCommands } from "../sessionActions/state";
import { buildSections, commandCount } from "../sessionActions/sections";
import { COLLAPSE_BELOW, pickLayout } from "../sessionActions/layout";
import { pinsFrom } from "../sessionActions/pins";
import { recentFrom, withSent, RECENT_LIMIT } from "../sessionActions/recent";
import { analyticsFeature } from "../sessionActions/run";
import { commandOfTypedLine } from "../sessionActions/init";
import { isShortPane, SHORT_PANE_ROWS } from "../hooks/useShortPane";

const text = (agent: string, action: SessionActionId) => commandForAction(agent, action)?.text;
const ids = (agent: string) => builtinCommands(agent).map((c) => c.text);

describe("catalog → each agent's command for each action", () => {
  it("maps the shared actions to every agent's own command", () => {
    // Claude Code: /review became an alias of /code-review (2.1.223).
    expect(text("claude", "review")).toBe("/code-review");
    expect(builtinCommands("claude").find((c) => c.action === "review")?.aliases).toContain("/review");
    expect(text("claude", "usage")).toBe("/usage");
    expect(text("claude", "new_chat")).toBe("/clear");
    // Codex: context is /status; /approvals is now /permissions.
    expect(text("codex", "context")).toBe("/status");
    expect(text("codex", "permissions")).toBe("/permissions");
    expect(text("codex", "new_chat")).toBe("/new");
    // Gemini CLI: compact is /compress, usage /stats, exit /quit.
    expect(text("gemini", "compact")).toBe("/compress");
    expect(text("gemini", "usage")).toBe("/stats");
    expect(text("gemini", "exit")).toBe("/quit");
    // Copilot CLI, OpenCode, Kiro, Aider, Hermes Agent, goose, Antigravity.
    expect(text("copilot", "rewind")).toBe("/undo");
    expect(text("opencode", "model")).toBe("/models");
    expect(text("opencode", "resume")).toBe("/sessions");
    expect(text("kiro", "context")).toBe("/context show");
    expect(text("kiro", "resume")).toBe("/chat resume");
    expect(text("aider", "context")).toBe("/tokens");
    expect(text("hermes-agent", "compact")).toBe("/compress");
    expect(text("goose", "compact")).toBe("/compact");
    expect(text("antigravity", "plan")).toBe("/plan");
  });

  it("hides an action an agent lacks (no command, never a greyed chip)", () => {
    expect(commandForAction("codex", "help")).toBeUndefined();
    expect(commandForAction("aider", "model")).toBeUndefined();
    expect(commandForAction("opencode", "review")).toBeUndefined();
    expect(commandForAction("custom", "help")).toBeUndefined();
    expect(chipsFor("aider", ["model", "plan", "review"]).map((c) => c.action)).toEqual(["plan"]);
    expect(chipsFor("custom", DEFAULT_PINNED)).toEqual([]);
  });

  it("drops stale commands the vendors removed or renamed", () => {
    expect(ids("claude")).not.toContain("/vim");
    expect(ids("claude")).not.toContain("/allowed-tools");
    expect(ids("claude")).not.toContain("/cost");
    expect(ids("codex")).not.toContain("/approvals");
    for (const gone of ["/shell", "/edit", "/yolo", "/sandbox", "/save"]) expect(ids("gemini")).not.toContain(gone);
    // Kiro's chat takes slash commands only: no shell lines typed into it.
    expect(ids("kiro").every((c) => c.startsWith("/"))).toBe(true);
    expect(ids("kiro").some((c) => c.includes("kiro-cli"))).toBe(false);
  });

  it("gives every agent but the Custom one a list, and every action a label in the vocabulary", () => {
    for (const a of AGENT_CATALOG.agents) {
      if (a.custom) expect(builtinCommands(a.id)).toEqual([]);
      else expect(builtinCommands(a.id).length, a.id).toBeGreaterThan(3);
    }
    expect(ACTION_IDS).toEqual([
      "compact", "context", "usage", "model", "plan", "review", "diff", "rewind",
      "resume", "init", "permissions", "mcp", "help", "new_chat", "exit", "logout",
    ]);
  });

  it("knows a session's agent from the one Hermes started, else the one it recognised", () => {
    expect(agentIdOf({ ai_provider: "codex", detected_agent: { name: "claude" } })).toBe("codex");
    expect(agentIdOf({ ai_provider: null, detected_agent: { name: "Claude Code" } })).toBe("claude");
    expect(agentIdOf({ ai_provider: null, detected_agent: null })).toBeNull();
  });
});

describe("chips: stable, pinned, never destructive", () => {
  it("keep the vocabulary's order whatever order they were pinned in", () => {
    const a = chipsFor("claude", ["review", "plan", "model"]).map((c) => c.action);
    const b = chipsFor("claude", ["model", "review", "plan"]).map((c) => c.action);
    expect(a).toEqual(["model", "plan", "review"]);
    expect(b).toEqual(a);
  });

  it("never make a destructive command a chip, even pinned", () => {
    expect(chipsFor("claude", ["new_chat", "exit", "logout", "model"]).map((c) => c.action)).toEqual(["model"]);
    // Copilot's /undo rolls files back: its rewind is never a chip.
    expect(chipsFor("copilot", ["rewind", "diff"]).map((c) => c.action)).toEqual(["diff"]);
    expect(chipsFor("claude", ["rewind"]).map((c) => c.action)).toEqual(["rewind"]);
  });

  it("leave context to the gauge chip and skip what a surface handles itself", () => {
    expect(chipsFor("claude", ["context", "model"]).map((c) => c.action)).toEqual(["model"]);
    expect(chipsFor("claude", DEFAULT_PINNED, new Set<SessionActionId>(["model"])).map((c) => c.action)).toEqual(["plan", "review"]);
  });
});

describe("context chip", () => {
  it("shows the gauge, turns to Compact at 75% and hides when unknown", () => {
    expect(contextChip("claude", null)).toBeNull();
    expect(contextChip("claude", 62)).toMatchObject({ percent: 62, high: false, runs: { text: "/context" } });
    expect(contextChip("claude", 75)).toMatchObject({ high: true, runs: { text: "/compact" } });
    expect(contextChip("claude", 82)).toMatchObject({ high: true, runs: { text: "/compact" } });
    // An agent with a gauge but no command: a plain readout.
    expect(contextChip("custom", 40)).toMatchObject({ percent: 40, runs: undefined });
  });
});

describe("when a command may run, and the one state chip", () => {
  it("only while the agent waits at its prompt", () => {
    for (const k of ["idle", "done_unread", "error", "limited", "check_failed"] as const) expect(takesCommands(k), k).toBe(true);
    for (const k of ["working", "starting", "needs_approval", "needs_answer", "plan_ready", "startup_prompt", "exited", "gate"] as const) expect(takesCommands(k), k).toBe(false);
  });

  const base = { agentId: "claude", surface: "terminal" as const, status: "idle" as const, rejection: null, limited: false, helperEnded: false, canSignIn: true };
  it("is Sign in, then Resume, then Usage, and at most one", () => {
    expect(stateChipFor(base)).toBeNull();
    expect(stateChipFor({ ...base, rejection: "signed_out" })).toEqual({ kind: "sign_in" });
    expect(stateChipFor({ ...base, rejection: "signed_out", canSignIn: false })).toBeNull();
    expect(stateChipFor({ ...base, status: "exited", helperEnded: true })).toEqual({ kind: "resume" });
    // Not without a way to start it again.
    expect(stateChipFor({ ...base, status: "exited", helperEnded: false })).toBeNull();
    expect(stateChipFor({ ...base, limited: true })).toMatchObject({ kind: "usage", command: { text: "/usage" } });
    expect(stateChipFor({ ...base, agentId: "gemini", status: "limited" })).toMatchObject({ kind: "usage", command: { text: "/stats" } });
    // An agent with no usage command: no chip.
    expect(stateChipFor({ ...base, agentId: "goose", limited: true })).toBeNull();
    // The Agent view resumes by itself and has its own sign-in.
    expect(stateChipFor({ ...base, surface: "agent", rejection: "signed_out", status: "exited", helperEnded: true })).toBeNull();
  });
});

describe("the Commands list", () => {
  const builtin = builtinCommands("claude");
  const yours = [
    { text: "/deploy", label: "/deploy", description: "Deploy", category: "project" as const, destructive: false, aliases: [], source: "user" as const, scope: "project" as const },
    { text: "/clear", label: "/clear", description: "shadowed", category: "project" as const, destructive: false, aliases: [], source: "user" as const },
  ];
  const words = (c: { label: string; description: string }) => `${c.label} ${c.description}`;

  it("puts each command in one section: Pinned, Recent, Your commands, Built-in, Session last", () => {
    const sections = buildSections({ builtin, yours, pinned: ["model", "review"], recent: ["/compact", "/model", "/clear", "/deploy"], filter: "", words });
    // /deploy was sent: it is in Recent, so "Your commands" has nothing left and is not shown.
    expect(sections.map((s) => s.id)).toEqual(["pinned", "recent", "builtin", "session"]);
    expect(sections[0].items.map((c) => c.text)).toEqual(["/model", "/code-review"]);
    // Recent: what was sent, newest first, not destructive, not repeated from Pinned.
    expect(sections[1].items.map((c) => c.text)).toEqual(["/compact", "/deploy"]);
    expect(sections[3].items.map((c) => c.text)).toEqual(["/clear", "/exit", "/logout"]);
    const fresh = buildSections({ builtin, yours, pinned: [], recent: [], filter: "", words });
    expect(fresh.map((s) => s.id)).toEqual(["yours", "builtin", "session"]);
    expect(fresh[0].items.map((c) => c.text)).toEqual(["/deploy"]);
    const all = sections.flatMap((s) => s.items.map((c) => c.text));
    expect(new Set(all).size).toBe(all.length);
    // A file never shadows a built-in.
    expect(all.filter((t) => t === "/clear")).toHaveLength(1);
  });

  it("filters by command, alias, label or description", () => {
    const only = (filter: string) => buildSections({ builtin, yours, pinned: [], recent: [], filter, words }).flatMap((s) => s.items.map((c) => c.text));
    expect(only("/review")).toEqual(["/code-review"]);
    expect(only("deploy")).toEqual(["/deploy"]);
    expect(only("zzz")).toEqual([]);
  });

  it("counts every distinct command once", () => {
    expect(commandCount(builtin, [])).toBe(builtin.length);
    expect(commandCount(builtin, yours)).toBe(builtin.length + 1);
  });
});

describe("Recent and pins: stored on this device", () => {
  it("keeps only actions that can be chips, in a fixed order", () => {
    expect(pinsFrom(undefined)).toEqual(DEFAULT_PINNED);
    expect(pinsFrom("not json")).toEqual(DEFAULT_PINNED);
    expect(pinsFrom(JSON.stringify(["review", "new_chat", "bogus", "compact"]))).toEqual(["compact", "review"]);
    expect(pinsFrom("[]")).toEqual([]);
  });

  it("moves a sent command to the front, capped, and drops malformed entries", () => {
    expect(withSent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
    const many = Array.from({ length: 20 }, (_, i) => `/c${i}`);
    expect(withSent(many, "/new")).toHaveLength(RECENT_LIMIT);
    expect(recentFrom(JSON.stringify({ claude: ["/compact", 3, "rm -rf /", "/frontend:x"], codex: "x" }))).toEqual({ claude: ["/compact", "/frontend:x"] });
  });

  it("keeps a typed line only when it names one of the agent's commands, as that command", () => {
    expect(commandOfTypedLine("claude", null, "/review the auth change")?.text).toBe("/code-review");
    expect(commandOfTypedLine("kiro", null, "/context show")?.text).toBe("/context show");
    expect(commandOfTypedLine("claude", null, "/not-a-command please")).toBeUndefined();
    expect(matchTypedCommand("rm -rf", builtinCommands("claude"))).toBeUndefined();
  });

  it("counts an action by its id only, never the command text", () => {
    expect(analyticsFeature(commandForAction("claude", "compact")!)).toBe("session_action.compact");
    expect(analyticsFeature(builtinCommands("claude").find((c) => c.text === "/memory")!)).toBe("session_action.command");
    expect(analyticsFeature({ ...builtinCommands("claude")[0], action: undefined, source: "user", text: "/secret-deploy" })).toBe("session_action.own_command");
  });
});

describe("fitting the pane", () => {
  it("shows labels, then glyphs, then collapses; below 480 px always collapsed", () => {
    expect(pickLayout(0, {})).toBe("full");
    expect(pickLayout(900, {})).toBe("full");
    expect(pickLayout(900, { full: 1000 })).toBe("icons");
    expect(pickLayout(900, { full: 1000, icons: 950 })).toBe("collapsed");
    expect(pickLayout(1100, { full: 1000, icons: 950 })).toBe("full");
    expect(pickLayout(COLLAPSE_BELOW - 1, {})).toBe("collapsed");
    expect(pickLayout(900, {}, true)).toBe("collapsed");
  });

  it("folds the chrome into the header on a short pane, with one row of hysteresis", () => {
    const cell = 17;
    const chrome = 96;
    const rows = (n: number) => chrome + n * cell;
    expect(isShortPane(rows(SHORT_PANE_ROWS + 5), chrome, cell, false)).toBe(false);
    expect(isShortPane(rows(SHORT_PANE_ROWS - 1), chrome, cell, false)).toBe(true);
    expect(isShortPane(rows(SHORT_PANE_ROWS), chrome, cell, true)).toBe(true);
    expect(isShortPane(rows(SHORT_PANE_ROWS + 1), chrome, cell, true)).toBe(false);
    expect(isShortPane(0, chrome, cell, false)).toBe(false);
  });
});

describe("the catalog's command strings", () => {
  it("give every command without an action its label and description, and every flagged one its consequence", () => {
    const messages = catalogCommandMessages();
    expect(messages["agentCommand.claude.memory.label"]).toBe("Memory");
    expect(messages["agentCommand.kiro.knowledge-show.label"]).toBe("Knowledge");
    expect(messages["agentCommand.copilot.undo.consequence"]).toMatch(/Rolls back/);
    expect(messages["agentCommand.claude.compact.label"]).toBeUndefined();
    expect(commandSlug("/frontend:component")).toBe("frontend-component");
  });
});
