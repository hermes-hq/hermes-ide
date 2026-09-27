// @vitest-environment jsdom
/**
 * M2 — TODO panel.  Spec §2 (M2) + §7.6.  Visual §8.6.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  extractTodos,
  extractTodosFromMessages,
  extractTodoSnapshot,
  type TodoItem,
} from "../utils/todoStore";
import { TodoPanel } from "../components/TodoPanel";

const SAMPLE: TodoItem[] = [
  { content: "Find the slowest test", status: "completed" },
  { content: "Rewrite the test fixture", status: "completed" },
  { content: "Run preflight", status: "in_progress" },
  { content: "Document the new helper", status: "pending" },
  { content: "Open a PR", status: "pending" },
];

describe("extractTodos (t-1, t-2, t-3, t-17)", () => {
  it("t-1: pulls latest TodoWrite tool_use payload", () => {
    const blocks = [
      { type: "tool_use", name: "Bash", id: "tu_1", input: {} },
      { type: "tool_use", name: "TodoWrite", id: "tu_2", input: { todos: SAMPLE } },
    ];
    expect(extractTodos(blocks)).toEqual(SAMPLE);
  });

  it("t-2: REPLACES (not appends) — last TodoWrite wins", () => {
    const blocks = [
      { type: "tool_use", name: "TodoWrite", id: "tu_a", input: { todos: [{ content: "old", status: "pending" }] } },
      { type: "tool_use", name: "TodoWrite", id: "tu_b", input: { todos: SAMPLE } },
    ];
    expect(extractTodos(blocks)).toEqual(SAMPLE);
  });

  it("t-3: empty todos:[] clears (returns empty array, not null)", () => {
    const blocks = [
      { type: "tool_use", name: "TodoWrite", id: "tu_a", input: { todos: SAMPLE } },
      { type: "tool_use", name: "TodoWrite", id: "tu_b", input: { todos: [] } },
    ];
    expect(extractTodos(blocks)).toEqual([]);
  });

  it("t-17: unknown status → mapped to 'unknown' (no crash)", () => {
    const blocks = [
      { type: "tool_use", name: "TodoWrite", id: "tu", input: { todos: [{ content: "x", status: "weird" as never }] } },
    ];
    const got = extractTodos(blocks);
    expect(got[0].status).toBe("unknown");
  });
});

describe("extractTodosFromMessages (memory: walks newest-first, no flatMap)", () => {
  it("returns the latest TodoWrite when present in the most recent message", () => {
    const messages = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", name: "Bash", id: "b", input: {} },
        ],
      },
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", name: "TodoWrite", id: "tw", input: { todos: SAMPLE } },
        ],
      },
    ];
    const got = extractTodosFromMessages(messages);
    expect(got).toEqual(SAMPLE);
  });

  it("walks back through older messages if the newest has no TodoWrite", () => {
    const older: TodoItem[] = [{ content: "older", status: "pending" }];
    const messages = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", name: "TodoWrite", id: "tw", input: { todos: older } },
        ],
      },
      {
        role: "assistant",
        blocks: [{ type: "text", id: "t", text: "no todos here" } as never],
      },
    ];
    const got = extractTodosFromMessages(messages);
    expect(got).toEqual(older);
  });

  it("ignores user-role messages", () => {
    const messages = [
      {
        role: "user",
        blocks: [
          { type: "tool_use", name: "TodoWrite", id: "tw", input: { todos: SAMPLE } },
        ],
      },
    ];
    expect(extractTodosFromMessages(messages)).toEqual([]);
  });

  it("returns [] when no TodoWrite anywhere", () => {
    const messages = [
      { role: "assistant", blocks: [{ type: "text" as never }] },
      { role: "assistant", blocks: [] },
    ];
    expect(extractTodosFromMessages(messages)).toEqual([]);
  });

  it("matches extractTodos behaviour for the latest TodoWrite (cross-check)", () => {
    const blocks = [
      { type: "tool_use", name: "TodoWrite", id: "old", input: { todos: [{ content: "stale", status: "pending" }] } },
      { type: "tool_use", name: "TodoWrite", id: "new", input: { todos: SAMPLE } },
    ];
    const flat = extractTodos(blocks);
    const nested = extractTodosFromMessages([
      { role: "assistant", blocks },
    ]);
    expect(nested).toEqual(flat);
  });
});

describe("TodoPanel — render (t-4..t-7, t-13)", () => {
  afterEach(() => cleanup());

  it("t-4: renders nothing when todos is empty", () => {
    const { container } = render(<TodoPanel todos={[]} />);
    expect(container.querySelector(".todo-panel")).toBeNull();
  });

  it("t-4-b: renders panel when todos.length > 0", () => {
    render(<TodoPanel todos={SAMPLE} />);
    expect(screen.getByText(/find the slowest test/i)).toBeInTheDocument();
  });

  it("t-5: each item has a glyph indicating status", () => {
    render(<TodoPanel todos={SAMPLE} />);
    const rows = document.querySelectorAll(".todo-row");
    expect(rows).toHaveLength(5);
  });

  it("t-7: header shows TODOS · {done}/{total}", () => {
    render(<TodoPanel todos={SAMPLE} />);
    expect(screen.getByText(/2\/5/)).toBeInTheDocument();
  });

  it("t-13: empty content rows render '(empty)' placeholder", () => {
    render(<TodoPanel todos={[{ content: "", status: "pending" }]} />);
    expect(screen.getByText(/\(empty\)/i)).toBeInTheDocument();
  });
});

/* ─── Snapshot / staleness / mark-done (added 2026-05-12) ─────── */

describe("extractTodoSnapshot — staleness tracking", () => {
  it("returns sourceMessageId + assistantTurnsSince = 0 when latest message owns the TodoWrite", () => {
    const messages = [
      {
        id: "a-1",
        role: "assistant",
        timestamp: 100,
        blocks: [
          { type: "tool_use", name: "TodoWrite", id: "tw", input: { todos: SAMPLE } },
        ],
      },
    ];
    const snap = extractTodoSnapshot(messages);
    expect(snap.todos).toEqual(SAMPLE);
    expect(snap.sourceMessageId).toBe("a-1");
    expect(snap.assistantTurnsSince).toBe(0);
    expect(snap.lastUpdatedAt).toBe(100);
  });

  it("counts subsequent top-level assistant turns as assistantTurnsSince", () => {
    const messages = [
      {
        id: "a-1",
        role: "assistant",
        timestamp: 100,
        blocks: [
          { type: "tool_use", name: "TodoWrite", id: "tw", input: { todos: SAMPLE } },
        ],
      },
      { id: "a-2", role: "assistant", timestamp: 200, blocks: [{ type: "text" as never }] },
      { id: "a-3", role: "assistant", timestamp: 300, blocks: [{ type: "text" as never }] },
    ];
    const snap = extractTodoSnapshot(messages);
    expect(snap.assistantTurnsSince).toBe(2);
  });

  it("excludes subagent messages (parentToolUseId set) from the turn count", () => {
    const messages = [
      {
        id: "a-1",
        role: "assistant",
        timestamp: 100,
        blocks: [
          { type: "tool_use", name: "TodoWrite", id: "tw", input: { todos: SAMPLE } },
        ],
      },
      // A subagent message — should NOT count as a fresh turn.
      {
        id: "a-2",
        role: "assistant",
        timestamp: 200,
        parentToolUseId: "some-task-tool-id",
        blocks: [{ type: "text" as never }],
      } as never,
      // A real top-level turn — should count.
      { id: "a-3", role: "assistant", timestamp: 300, blocks: [{ type: "text" as never }] },
    ];
    const snap = extractTodoSnapshot(messages);
    expect(snap.assistantTurnsSince).toBe(1);
  });

  it("returns empty snapshot when no TodoWrite exists", () => {
    const snap = extractTodoSnapshot([
      { id: "a-1", role: "assistant", blocks: [{ type: "text" as never }] },
    ]);
    expect(snap.todos).toEqual([]);
    expect(snap.sourceMessageId).toBeNull();
    expect(snap.assistantTurnsSince).toBe(0);
    expect(snap.lastUpdatedAt).toBeNull();
  });
});

describe("TodoPanel — staleness + mark-done", () => {
  afterEach(() => cleanup());

  it("does NOT show stale pip when assistantTurnsSince < threshold", () => {
    render(
      <TodoPanel
        snapshot={{
          todos: SAMPLE,
          sourceMessageId: "a-1",
          assistantTurnsSince: 1,
          lastUpdatedAt: 100,
        }}
      />,
    );
    expect(screen.queryByText(/stale/i)).toBeNull();
  });

  it("shows the stale pip when assistantTurnsSince >= 3", () => {
    render(
      <TodoPanel
        snapshot={{
          todos: SAMPLE,
          sourceMessageId: "a-1",
          assistantTurnsSince: 5,
          lastUpdatedAt: 100,
        }}
      />,
    );
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    expect(screen.getByText(/5 turns ago/i)).toBeInTheDocument();
  });

  it("pluralizes correctly: '1 turn ago' for a single stale turn", () => {
    // assistantTurnsSince = 1 is below the threshold so the pip
    // wouldn't show.  This test pins the singular wording for the
    // case where the threshold drops in the future.
    render(
      <TodoPanel
        snapshot={{
          todos: SAMPLE,
          sourceMessageId: "a-1",
          assistantTurnsSince: 3,
          lastUpdatedAt: 100,
        }}
      />,
    );
    expect(screen.getByText(/3 turns ago/i)).toBeInTheDocument();
  });

  it("clicking the per-row ✓ button marks the row done locally", () => {
    render(<TodoPanel todos={SAMPLE} />);
    const row = screen.getByText("Run preflight").closest(".todo-row");
    expect(row).not.toBeNull();
    const action = row!.querySelector(".todo-row-action") as HTMLButtonElement;
    expect(action).not.toBeNull();
    fireEvent.click(action);
    // After click, the row should reflect a locally-done state.
    expect(row!.getAttribute("data-local-done")).toBe("true");
  });

  it("local 'mark done' override resets when a new TodoWrite arrives (sourceMessageId changes)", () => {
    // Two rows so the panel doesn't auto-dismiss after we mark one
    // locally done (the all-done rule fires only when every row is
    // completed).
    const todos: TodoItem[] = [
      { content: "Stable task", status: "pending" },
      { content: "Companion task", status: "pending" },
    ];
    const { rerender } = render(
      <TodoPanel
        snapshot={{
          todos,
          sourceMessageId: "a-1",
          assistantTurnsSince: 0,
          lastUpdatedAt: 100,
        }}
      />,
    );
    // User marks the first one done locally.
    const row = screen.getByText("Stable task").closest(".todo-row")!;
    fireEvent.click(row.querySelector(".todo-row-action")!);
    expect(row.getAttribute("data-local-done")).toBe("true");

    // Agent emits a fresh TodoWrite (sourceMessageId changes).  The
    // local override should reset — the agent's view wins.
    rerender(
      <TodoPanel
        snapshot={{
          todos, // same content
          sourceMessageId: "a-2", // different message → fresh authority
          assistantTurnsSince: 0,
          lastUpdatedAt: 200,
        }}
      />,
    );
    const refreshedRow = screen.getByText("Stable task").closest(".todo-row")!;
    expect(refreshedRow.getAttribute("data-local-done")).toBeNull();
  });

  it("auto-dismisses when the user locally marks the last remaining row done", () => {
    // Intentional UX: when the user completes everything (real or
    // locally-overridden), the panel hides itself — consistent with
    // the existing all-completed auto-dismiss behavior.
    const todos: TodoItem[] = [
      { content: "Last one", status: "pending" },
    ];
    const { container } = render(<TodoPanel todos={todos} />);
    const row = screen.getByText("Last one").closest(".todo-row")!;
    fireEvent.click(row.querySelector(".todo-row-action")!);
    expect(container.querySelector(".todo-panel")).toBeNull();
  });
});

/* ─── SDK 0.3 Task tools (TaskCreate / TaskUpdate) ─────────────── */

describe("extractTodoSnapshot — TaskCreate / TaskUpdate", () => {
  const created = (id: string, subject: string) => ({
    type: "tool_result",
    tool_use_id: "",
    content: `Task #${id} created successfully: ${subject}`,
  });

  it("builds the list from TaskCreate and applies TaskUpdate by id", () => {
    const messages = [
      {
        id: "a-1",
        role: "assistant",
        timestamp: 100,
        blocks: [
          { type: "tool_use", name: "TaskCreate", id: "c1", input: { subject: "Write test", description: "d" } },
          { type: "tool_use", name: "TaskCreate", id: "c2", input: { subject: "Fix bug", description: "d" } },
          { type: "tool_use", name: "TaskCreate", id: "c3", input: { subject: "Drop me", description: "d" } },
        ],
      },
      {
        id: "a-2",
        role: "assistant",
        timestamp: 200,
        blocks: [
          { type: "tool_use", name: "TaskUpdate", id: "u1", input: { taskId: "7", status: "completed" } },
          { type: "tool_use", name: "TaskUpdate", id: "u2", input: { taskId: "8", status: "in_progress", subject: "Fix the bug" } },
          { type: "tool_use", name: "TaskUpdate", id: "u3", input: { taskId: "9", status: "deleted" } },
        ],
      },
    ];
    const results = new Map([
      ["c1", created("7", "Write test")],
      ["c2", created("8", "Fix bug")],
      ["c3", created("9", "Drop me")],
    ]);
    const snap = extractTodoSnapshot(messages, results);
    expect(snap.todos).toEqual([
      { id: "7", content: "Write test", status: "completed" },
      { id: "8", content: "Fix the bug", status: "in_progress" },
    ]);
    expect(snap.sourceMessageId).toBe("a-2");
    expect(snap.lastUpdatedAt).toBe(200);
  });

  it("falls back to sequential ids when the TaskCreate result has not arrived", () => {
    const messages = [
      {
        id: "a-1",
        role: "assistant",
        blocks: [
          { type: "tool_use", name: "TaskCreate", id: "c1", input: { subject: "One", description: "" } },
          { type: "tool_use", name: "TaskCreate", id: "c2", input: { subject: "Two", description: "" } },
          { type: "tool_use", name: "TaskUpdate", id: "u1", input: { taskId: "2", status: "in_progress" } },
        ],
      },
    ];
    const snap = extractTodoSnapshot(messages);
    expect(snap.todos).toEqual([
      { id: "1", content: "One", status: "pending" },
      { id: "2", content: "Two", status: "in_progress" },
    ]);
  });
});
