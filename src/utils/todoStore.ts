/**
 * Pure helpers for the TODO panel.  Reads the latest TodoWrite tool_use
 * out of a stream of content blocks and returns the TODOs as a typed
 * array.  Tested independently from the panel component (M2 §2 / §7.6).
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "unknown";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const KNOWN_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed"]);

interface ToolUseLike {
  type?: string;
  name?: string;
  input?: { todos?: Array<{ content?: unknown; status?: unknown }> };
}

/** Walk the block list latest-first, return the most recent TodoWrite's
 *  todos array (with safe-typed status).  An empty `todos: []` is honored
 *  as "all done — clear the panel". */
export function extractTodos(blocks: readonly ToolUseLike[]): TodoItem[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type !== "tool_use" || b.name !== "TodoWrite") continue;
    const todos = b.input?.todos;
    if (!Array.isArray(todos)) return [];
    return todos.map((t) => {
      const content = typeof t.content === "string" ? t.content : "";
      const rawStatus = typeof t.status === "string" ? (t.status as TodoStatus) : "unknown";
      const status: TodoStatus = KNOWN_STATUSES.has(rawStatus) ? rawStatus : "unknown";
      return { content, status };
    });
  }
  return [];
}

export function todoCounts(todos: readonly TodoItem[]): { done: number; total: number } {
  return {
    done: todos.filter((t) => t.status === "completed").length,
    total: todos.length,
  };
}
