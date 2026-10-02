// Queued agent tasks (N22), shown above the sessions while any wait.
// Each starts on its own when a slot frees; "Start now" skips the wait and
// "Remove" drops the task without starting it. Each row says which task it
// is (the whole task on hover) and where it will run.

import "../styles/components/Fleet.css";
import { useI18n } from "../i18n/I18nProvider";
import { getAgent } from "../catalog/agentCatalog";
import { Button } from "../components/ui";
import { useFleetCaps } from "./fleetSettings";
import { removeTask, startTaskNow, useOccupancy, useTaskQueue, type QueuedTask } from "./taskQueue";

function formatMb(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The task as it was typed (the launcher's), else what the row is called. */
export function queuedTaskText(task: QueuedTask): string {
  return (task.launch?.req.task ?? task.opts.initialPrompt ?? task.label).trim() || task.label;
}

/** "Claude Code · launcher-repo": the agent and the folder the task will run in. */
export function queuedTaskWhere(task: QueuedTask): string {
  const agent = task.opts.aiProvider ? (getAgent(task.opts.aiProvider)?.name ?? task.opts.aiProvider) : "";
  const folder = task.launch?.req.repoRoot ?? task.opts.workingDirectory ?? "";
  return [agent, folder ? baseName(folder) : ""].filter(Boolean).join(" · ");
}

export function TaskQueueSection() {
  const { t } = useI18n();
  const queue = useTaskQueue();
  const occupancy = useOccupancy();
  const caps = useFleetCaps();
  if (queue.length === 0) return null;
  const slots: string[] = [];
  if (caps.maxRunning !== null) {
    slots.push(t("fleet.queueSlots", { used: String(occupancy.sessionIds.length), cap: String(caps.maxRunning) }));
  }
  if (caps.maxMemoryMb !== null) {
    slots.push(t("fleet.queueMemory", { used: formatMb(occupancy.memoryBytes), cap: String(caps.maxMemoryMb) }));
  }
  return (
    <section className="task-queue" aria-label={t("fleet.queueTitle", { count: String(queue.length) })}>
      <div className="task-queue-header">
        <span className="task-queue-title">{t("fleet.queueTitle", { count: String(queue.length) })}</span>
        {slots.length > 0 && <span className="task-queue-slots">{slots.join(" · ")}</span>}
      </div>
      <ol className="task-queue-list">
        {queue.map((task, i) => {
          const text = queuedTaskText(task);
          const where = queuedTaskWhere(task);
          return (
            <li key={task.id} className="task-queue-item" data-task-id={task.id}>
              <span className="task-queue-position">{i + 1}</span>
              <span className="task-queue-text" title={text}>
                <span className="task-queue-label">{task.label}</span>
                {where && <span className="task-queue-where">{where}</span>}
              </span>
              <Button size="sm" variant="quiet" className="task-queue-start" aria-label={t("fleet.queueStartNowTask", { task: task.label })} onClick={() => startTaskNow(task.id)}>
                {t("fleet.queueStartNow")}
              </Button>
              <Button size="sm" variant="quiet" className="task-queue-remove" aria-label={t("fleet.queueRemoveTask", { task: task.label })} onClick={() => removeTask(task.id)}>
                {t("fleet.queueRemove")}
              </Button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
