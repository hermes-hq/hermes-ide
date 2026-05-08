/**
 * TodoPanel — sticky checklist pinned to the bottom of the conversation
 * column.  Visual: §8.6.
 *
 * Driven by the latest TodoWrite tool_use; renders nothing when the
 * todos list is empty (visibility = list-driven, not toggle-driven).
 */
import "../styles/components/TodoPanel.css";
import { useState } from "react";
import { todoCounts, type TodoItem, type TodoStatus } from "../utils/todoStore";

const STATUS_GLYPH: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "▸",
  completed: "✓",
  unknown: "?",
};

interface Props {
  todos: TodoItem[];
}

export function TodoPanel({ todos }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (todos.length === 0) return null;

  const { done, total } = todoCounts(todos);
  const inProgress = todos.find((t) => t.status === "in_progress");

  return (
    <aside className="todo-panel" data-testid="todo-panel">
      <button
        type="button"
        className="todo-panel-header"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <span className="todo-panel-title">TODOS</span>
        <span className="todo-panel-sep">·</span>
        <span className="todo-panel-count">{done}/{total}</span>
        {collapsed && inProgress && (
          <>
            <span className="todo-panel-sep">·</span>
            <span className="todo-panel-running">running: {inProgress.content || "(empty)"}</span>
          </>
        )}
        <span className="todo-panel-disclosure" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {!collapsed && (
        <ol className="todo-rows">
          {todos.map((t, i) => (
            <li
              key={i}
              className="todo-row"
              data-status={t.status}
            >
              <span className="todo-glyph" aria-hidden="true">
                {STATUS_GLYPH[t.status]}
              </span>
              <span className="todo-content">
                {t.content === "" ? <span className="todo-empty">(empty)</span> : t.content}
              </span>
              {t.status === "in_progress" && (
                <span className="todo-active-marker" aria-hidden="true">←</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
