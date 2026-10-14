// @vitest-environment jsdom
/**
 * The session action bar, rendered for real (only the backend and the
 * terminal are stand-ins): a chip runs its command only while the agent
 * waits, a draft is never touched (the backend says "draft" and the bar
 * says so), a destructive command asks first, and the Commands list is a
 * keyboard listbox that gives the keyboard back to its trigger.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  outcome: "sent" as string,
  discovered: [] as unknown[],
  sessions: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    h.calls.push({ cmd, args });
    if (cmd === "run_session_command") return h.outcome;
    if (cmd === "discover_agent_commands") return h.discovered;
    if (cmd === "library_installs") return { lock: { schema: 1, entries: [] }, records: [] };
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../terminal/TerminalPool", () => ({
  focusTerminal: vi.fn(),
  setSubmittedCommandListener: vi.fn(),
  getTerminal: () => null,
}));
vi.mock("../state/SessionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/SessionContext")>()),
  useSession: () => ({ state: { sessions: h.sessions }, dispatch: vi.fn(), createSession: vi.fn(async () => null) }),
}));

import { SessionActionsBar } from "../components/SessionActionsBar";
import { I18nProvider } from "../i18n/I18nProvider";
import { dispatchSessionEvent, _resetSessionEventStoreForTest } from "../agent/contract/sessionEventStore";
import { _resetPinnedActionsForTest } from "../sessionActions/pins";
import { _resetRecentCommandsForTest } from "../sessionActions/recent";

function session(id: string, agent: string | null, extra: Record<string, unknown> = {}) {
  return { id, label: `${agent ?? "shell"} task`, mode: "terminal", ai_provider: agent, detected_agent: null, working_directory: "/fixture-home/project", agent_startup: null, agent_launch: null, ...extra };
}

function renderBar(agent: string | null, props: { compact?: boolean } = {}, extra: Record<string, unknown> = {}) {
  h.sessions = { s1: session("s1", agent, extra) };
  return render(
    <I18nProvider>
      <SessionActionsBar sessionId="s1" paneId="p1" focused {...props} />
    </I18nProvider>,
  );
}

const runs = () => h.calls.filter((c) => c.cmd === "run_session_command").map((c) => c.args.line);
const chip = (action: string) => document.querySelector<HTMLButtonElement>(`[data-session-action="${action}"]`);

beforeEach(() => {
  h.calls.length = 0;
  h.outcome = "sent";
  h.discovered = [];
  _resetSessionEventStoreForTest();
  _resetPinnedActionsForTest();
  _resetRecentCommandsForTest();
});
afterEach(cleanup);

describe("chips", () => {
  it("show the pinned actions in plain words, in a fixed order", () => {
    renderBar("claude");
    const labels = Array.from(document.querySelectorAll("[data-session-action]")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Model", "Plan", "Review"]);
    expect(screen.getByRole("button", { name: /Prompts/ })).toBeInTheDocument();
  });

  it("run the command with Enter through the backend when the agent waits", async () => {
    renderBar("claude");
    await act(async () => fireEvent.click(chip("review")!));
    expect(runs()).toEqual(["/code-review"]);
    // Never a raw write to the terminal.
    expect(h.calls.some((c) => c.cmd === "write_to_session")).toBe(false);
  });

  it("are disabled while the agent works, and say when they will work", async () => {
    renderBar("claude");
    act(() => {
      dispatchSessionEvent("s1", { type: "status", status: { kind: "working", confidence: "exact", detail: "" }, at: Date.now() });
    });
    const review = chip("review")!;
    expect(review).toBeDisabled();
    expect(review.closest("[title]")?.getAttribute("title")).toBe("Available when Claude Code is waiting");
    fireEvent.click(review);
    expect(runs()).toEqual([]);
  });

  it("never touch a draft: the backend refuses and the bar says why", async () => {
    h.outcome = "draft";
    renderBar("claude");
    await act(async () => fireEvent.click(chip("plan")!));
    expect(runs()).toEqual(["/plan"]);
    expect(await screen.findByRole("status")).toHaveTextContent("Finish or clear your message first");
  });

  it("turn the context chip into Compact at 75%", async () => {
    renderBar("claude");
    act(() => {
      dispatchSessionEvent("s1", { type: "context", usedTokens: 62_000, contextLimit: 100_000, model: "claude-x", at: Date.now() });
    });
    expect(chip("context")).toHaveAccessibleName("Context 62%");
    act(() => {
      dispatchSessionEvent("s1", { type: "context", usedTokens: 82_000, contextLimit: 100_000, model: "claude-x", at: Date.now() });
    });
    const compact = chip("compact")!;
    expect(compact).toHaveAccessibleName("Compact · 82%");
    expect(compact.className).toContain("h-chip--warning");
    await act(async () => fireEvent.click(compact));
    expect(runs()).toEqual(["/compact"]);
  });

  it("show for every agent: Antigravity and OpenCode get theirs, a Custom agent only Prompts", () => {
    renderBar("antigravity");
    expect(Array.from(document.querySelectorAll("[data-session-action]")).map((b) => b.getAttribute("aria-label"))).toEqual(["Model", "Plan"]);
    cleanup();
    renderBar("opencode");
    expect(Array.from(document.querySelectorAll("[data-session-action]")).map((b) => b.getAttribute("aria-label"))).toEqual(["Model"]);
    expect(document.querySelector("[data-session-commands]")).toBeInTheDocument();
    cleanup();
    renderBar("custom");
    expect(document.querySelectorAll("[data-session-action]")).toHaveLength(0);
    expect(document.querySelector("[data-session-commands]")).toBeNull();
    expect(screen.getByRole("button", { name: /Prompts/ })).toBeInTheDocument();
  });

  it("collapse on a short pane to Prompts, the state chip and / N", () => {
    renderBar("claude", { compact: true });
    expect(document.querySelectorAll("[data-session-action]")).toHaveLength(0);
    const trigger = document.querySelector("[data-session-commands]")!;
    expect(trigger.textContent).toMatch(/^\/ \d+$/);
    expect(document.querySelector(".session-actions-row")?.getAttribute("data-layout")).toBe("collapsed");
  });
});

describe("the state chip", () => {
  it("offers Usage after a usage limit, Sign in when signed out", async () => {
    renderBar("claude");
    act(() => {
      dispatchSessionEvent("s1", { type: "limit", state: "limited", resetsAt: null, window: "five_hour", at: Date.now() });
    });
    const usage = document.querySelector<HTMLButtonElement>('[data-session-state="usage"]')!;
    await act(async () => fireEvent.click(usage));
    expect(runs()).toEqual(["/usage"]);
    act(() => {
      dispatchSessionEvent("s1", { type: "launch_rejected", reason: "signed_out", vendorMessage: "Not logged in", suggestion: "sign-in", at: Date.now() });
    });
    expect(document.querySelectorAll("[data-session-state]")).toHaveLength(1);
    expect(document.querySelector('[data-session-state="sign_in"]')).toBeInTheDocument();
  });

  it("offers Resume after the agent exited (helper launch)", () => {
    renderBar("claude", {}, { agent_startup: { state: "ended", since: "", confidence: "exact" } });
    act(() => {
      dispatchSessionEvent("s1", { type: "exit", code: 0, signal: null, at: Date.now() });
    });
    expect(document.querySelector('[data-session-state="resume"]')).toBeInTheDocument();
  });
});

describe("the Commands list", () => {
  async function open() {
    const trigger = document.querySelector<HTMLButtonElement>("[data-session-commands]")!;
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    const listbox = await screen.findByRole("listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    return { trigger, listbox, input: screen.getByRole("combobox") };
  }

  it("is a listbox with sections, moved with the arrows, closed with Esc back to its trigger", async () => {
    renderBar("claude");
    const { trigger, listbox, input } = await open();
    expect(input).toHaveFocus();
    const groups = within(listbox).getAllByRole("group").map((g) => g.querySelector(".session-commands-section-title")?.textContent);
    expect(groups).toEqual(["Pinned", "Built-in", "Session"]);
    const first = input.getAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const second = input.getAttribute("aria-activedescendant");
    expect(second).not.toBe(first);
    expect(document.getElementById(second!)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("runs the highlighted command with Enter, with the filter", async () => {
    renderBar("claude");
    const { input } = await open();
    fireEvent.change(input, { target: { value: "memory" } });
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(runs()).toEqual(["/memory"]);
  });

  it("asks before a destructive command and sends nothing until confirmed", async () => {
    renderBar("claude");
    const { input } = await open();
    fireEvent.change(input, { target: { value: "new chat" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Start a new chat?")).toBeInTheDocument();
    expect(screen.getByText("The current conversation leaves the context; you can reopen it with Resume.")).toBeInTheDocument();
    expect(runs()).toEqual([]);
    // Esc goes back to the list; nothing sent.
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    expect(runs()).toEqual([]);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "New Chat" })));
    expect(runs()).toEqual(["/clear"]);
  });

  it("lists the person's own commands, and the ones they sent under Recent", async () => {
    h.discovered = [{ invocation: "/frontend:component", description: "Make a component", argumentHint: null, kind: "command", scope: "project", path: "/fixture-home/project/.claude/commands/frontend/component.md" }];
    renderBar("claude");
    await act(async () => fireEvent.click(chip("review")!));
    const { listbox } = await open();
    await within(listbox).findByText("/frontend:component");
    const titles = within(listbox).getAllByRole("group").map((g) => g.querySelector(".session-commands-section-title")?.textContent);
    expect(titles).toEqual(["Pinned", "Your commands", "Built-in", "Session"]);
    expect(within(listbox).getByText("Make a component")).toBeInTheDocument();
    expect(h.calls.find((c) => c.cmd === "discover_agent_commands")?.args).toEqual({ agentId: "claude", cwd: "/fixture-home/project" });
  });

  it("pins and unpins actions with Edit chips (they persist)", async () => {
    renderBar("claude");
    const { input } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Edit chips" }));
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
    fireEvent.change(input, { target: { value: "diff" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(chip("diff")).toBeInTheDocument());
    const saved = h.calls.filter((c) => c.cmd === "set_setting" && c.args.key === "session_actions_pinned").pop();
    expect(JSON.parse(String(saved?.args.value))).toEqual(["context", "model", "plan", "review", "diff"]);
  });
});
