// @vitest-environment jsdom
/**
 * M2 — TODO panel.  Spec §2 (M2) + §7.6.  Visual §8.6.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { extractTodos, type TodoItem } from "../utils/todoStore";
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
