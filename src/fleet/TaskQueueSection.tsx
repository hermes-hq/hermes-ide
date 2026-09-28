// Queued agent tasks (N22), shown above the sessions while any wait.
// Each starts on its own when a slot frees; "Start now" skips the wait and
// "Remove" drops the task without starting it.

import "../styles/components/Fleet.css";
import { useI18n } from "../i18n/I18nProvider";
import { useFleetCaps } from "./fleetSettings";
import { removeTask, startTaskNow, useOccupancy, useTaskQueue } from "./taskQueue";

function formatMb(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}

export function TaskQueueSection() {
  const { t } = useI18n();
  const queue = useTaskQueue();
  const occupancy = useOccupancy();
  const caps = useFleetCaps();
  if (queue.length === 0) return null;
  const slots: string[] = [];
  if (caps.maxRunning !== null) {
    slots.push(t("fleet.queueRunning", { running: String(occupancy.sessionIds.length), cap: String(caps.maxRunning) }));
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
        {queue.map((task, i) => (
          <li key={task.id} className="task-queue-item" data-task-id={task.id}>
            <span className="task-queue-position">{i + 1}</span>
            <span className="task-queue-label" title={t("fleet.queueWaiting")}>{task.label}</span>
            <button type="button" className="task-queue-btn task-queue-start" onClick={() => startTaskNow(task.id)}>
              {t("fleet.queueStartNow")}
            </button>
            <button type="button" className="task-queue-btn task-queue-remove" onClick={() => removeTask(task.id)}>
              {t("fleet.queueRemove")}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
