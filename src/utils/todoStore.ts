/**
 * Pure helpers for the TODO panel.  Reads the latest TodoWrite tool_use
 * out of a stream of content blocks and returns the TODOs as a typed
 * array.  Tested independently from the panel component (M2 §2 / §7.6).
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "unknown";

export interface TodoItem {
  /** Task id (TaskCreate/TaskUpdate only; TodoWrite items have none). */
  id?: string;
  content: string;
  status: TodoStatus;
}

const KNOWN_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed"]);

interface ToolUseLike {
  type?: string;
  name?: string;
  id?: string;
  input?: { todos?: Array<{ content?: unknown; status?: unknown }> };
}

interface ToolResultLike {
  content?: unknown;
  is_error?: boolean;
}

/** SDK 0.3 replaced TodoWrite with TaskCreate / TaskUpdate. */
const TODO_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

/** TaskCreate's tool_result text is `Task #<id> created successfully: <subject>`. */
function taskIdFromResult(r: ToolResultLike | undefined): string | null {
  const c = r?.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";
  return /Task #(\S+) created successfully/.exec(text)?.[1] ?? null;
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

/** Variant that walks a messages list newest-first WITHOUT first
 *  building a flattened block array.  The full `extractTodos(blocks)`
 *  path required the caller to do `messages.flatMap(...)` which
 *  allocates an O(total-blocks) array on every render — heavy GC
 *  pressure in long sessions.  This variant short-circuits on the
 *  first TodoWrite encountered, walking newest message first. */
export function extractTodosFromMessages(
  messages: readonly { role: string; blocks?: readonly ToolUseLike[] }[],
): TodoItem[] {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const m = messages[mi];
    if (m.role !== "assistant" || !m.blocks || m.blocks.length === 0) continue;
    for (let bi = m.blocks.length - 1; bi >= 0; bi--) {
      const b = m.blocks[bi];
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
  }
  return [];
}

export function todoCounts(todos: readonly TodoItem[]): { done: number; total: number } {
  return {
    done: todos.filter((t) => t.status === "completed").length,
    total: todos.length,
  };
}

/**
 * Richer snapshot used by the panel to surface staleness:
 *   - `todos` — the live list (same as `extractTodosFromMessages`)
 *   - `sourceMessageId` — id of the assistant message that owns the
 *     latest TodoWrite call.  Used to detect "the agent updated the
 *     list" and reset client-side overrides.
 *   - `assistantTurnsSince` — number of *additional* assistant turns
 *     that have arrived AFTER the latest TodoWrite.  Zero means the
 *     latest TodoWrite is from the current turn; ≥3 means the list
 *     has gone stale and the panel should flag it.
 *   - `lastUpdatedAt` — wall-clock ms when the latest TodoWrite was
 *     observed (best-effort via the source message's timestamp).
 */
export interface TodoSnapshot {
  todos: TodoItem[];
  sourceMessageId: string | null;
  assistantTurnsSince: number;
  lastUpdatedAt: number | null;
}

interface MessageLike {
  id?: string;
  role: string;
  blocks?: readonly ToolUseLike[];
  timestamp?: number;
}

/** Replays TodoWrite (replaces the list) and TaskCreate / TaskUpdate
 *  (append / patch by id) in order.  `toolResults` supplies TaskCreate ids;
 *  without one, ids fall back to creation order (the CLI's numbering). */
export function extractTodoSnapshot(
  messages: readonly MessageLike[],
  toolResults?: ReadonlyMap<string, ToolResultLike>,
): TodoSnapshot {
  let todos: TodoItem[] = [];
  let createdCount = 0;
  let sourceIdx = -1;
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role !== "assistant" || !m.blocks) continue;
    for (const b of m.blocks) {
      if (b.type !== "tool_use" || !b.name || !TODO_TOOLS.has(b.name)) continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      const result = b.id ? toolResults?.get(b.id) : undefined;
      if (b.name === "TodoWrite") {
        const rawTodos = b.input?.todos;
        todos = Array.isArray(rawTodos)
          ? rawTodos.map((t) => {
              const content = typeof t.content === "string" ? t.content : "";
              const rawStatus =
                typeof t.status === "string" ? (t.status as TodoStatus) : "unknown";
              const status: TodoStatus = KNOWN_STATUSES.has(rawStatus)
                ? rawStatus
                : "unknown";
              return { content, status };
            })
          : [];
      } else if (result?.is_error) {
        continue;
      } else if (b.name === "TaskCreate") {
        createdCount += 1;
        const content = typeof input.subject === "string" ? input.subject : "";
        todos.push({ id: taskIdFromResult(result) ?? String(createdCount), content, status: "pending" });
      } else {
        const idx = todos.findIndex((t) => t.id !== undefined && t.id === input.taskId);
        if (idx === -1) continue;
        if (input.status === "deleted") {
          todos.splice(idx, 1);
        } else {
          const next = { ...todos[idx] };
          if (typeof input.subject === "string") next.content = input.subject;
          if (KNOWN_STATUSES.has(input.status as TodoStatus)) next.status = input.status as TodoStatus;
          todos[idx] = next;
        }
      }
      sourceIdx = mi;
    }
  }

  if (sourceIdx !== -1) {
    const m = messages[sourceIdx];
    // Count assistant turns that ARRIVED AFTER the latest list update.
    // A subagent message (parentToolUseId set) is NOT counted — those
    // are nested fan-out, not new top-level turns from the operator's
    // perspective.
    let assistantTurnsSince = 0;
    for (let fi = sourceIdx + 1; fi < messages.length; fi++) {
      const fm = messages[fi];
      if (fm.role !== "assistant") continue;
      const fmAny = fm as MessageLike & { parentToolUseId?: string | null };
      if (fmAny.parentToolUseId) continue;
      assistantTurnsSince += 1;
    }
    return {
      todos,
      sourceMessageId: typeof m.id === "string" ? m.id : null,
      assistantTurnsSince,
      lastUpdatedAt: typeof m.timestamp === "number" ? m.timestamp : null,
    };
  }
  return {
    todos: [],
    sourceMessageId: null,
    assistantTurnsSince: 0,
    lastUpdatedAt: null,
  };
}
