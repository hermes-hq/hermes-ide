import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/I18nProvider";
import {
  decideRecipe,
  dismissRecipeRun,
  stopRecipeRun,
  useRecipeRuns,
  type RecipeRun,
} from "../state/worktreeRecipes";
import "../styles/components/WorktreeRecipePanel.css";
import { Button } from "./ui";

/**
 * The visible log of worktree recipes (F26): one card per new worktree
 * whose repository has a `.hermes/worktree.toml`. A card asks before a
 * file's commands run for the first time, streams the setup output while
 * it runs, and stays until closed so a failure can be read. Renders
 * nothing when no recipe ran in this session of the app.
 *
 * While a card asks or runs, the panel sits above dialogs (the New Session
 * wizard is waiting on it). Once every run is finished it drops below them,
 * so a card left open never covers a dialog.
 */
export function WorktreeRecipePanel() {
  const runs = useRecipeRuns();
  const { t } = useI18n();
  if (runs.length === 0) return null;
  const active = runs.some((r) => r.state === "running" || r.state === "awaiting");
  return createPortal(
    <div className={`worktree-recipe-panel${active ? " worktree-recipe-panel-active" : ""}`} role="region" aria-label={t("worktreeRecipe.title")}>
      {runs.map((run) => (
        <RecipeCard key={run.runId} run={run} />
      ))}
    </div>,
    document.body,
  );
}

function RecipeCard({ run }: { run: RecipeRun }) {
  const { t } = useI18n();
  const logRef = useRef<HTMLPreElement>(null);
  const finished = run.state !== "running" && run.state !== "awaiting";
  // A setup that went fine folds its log away; one that did not keeps it open.
  const [showLog, setShowLog] = useState<boolean | null>(null);
  const logOpen = showLog ?? run.state !== "succeeded";

  // Follow the output while it runs.
  useEffect(() => {
    const el = logRef.current;
    if (el && run.state === "running") el.scrollTop = el.scrollHeight;
  }, [run.lines.length, run.state]);

  const ports = Object.entries(run.ports)
    .map(([name, port]) => `${name} ${port}`)
    .join(", ");

  return (
    <section
      className={`worktree-recipe-card worktree-recipe-${run.state}`}
      data-run-id={run.runId}
      data-session-id={run.sessionId}
      data-state={run.state}
      aria-labelledby={`${run.runId}-title`}
    >
      <header className="worktree-recipe-header">
        <span className="worktree-recipe-title" id={`${run.runId}-title`}>
          {t("worktreeRecipe.title")} · {run.projectName}
          <span className="worktree-recipe-branch"> {run.branch}</span>
        </span>
        <span className="worktree-recipe-state" role="status">
          {t(`worktreeRecipe.state.${run.state}`)}
        </span>
      </header>

      {run.state === "awaiting" && (
        <div className="worktree-recipe-ask">
          <p>{t("worktreeRecipe.askIntro")}</p>
          {run.copy.length > 0 && (
            <p className="worktree-recipe-copy">{t("worktreeRecipe.askCopy", { patterns: run.copy.join(", ") })}</p>
          )}
          {run.setup.length > 0 && (
            <ol className="worktree-recipe-commands">
              {run.setup.map((cmd, i) => (
                <li key={i}>
                  <code>{cmd}</code>
                </li>
              ))}
            </ol>
          )}
          <p className="worktree-recipe-note">{t("worktreeRecipe.askRemember")}</p>
          <div className="worktree-recipe-actions">
            <Button className="worktree-recipe-skip" onClick={() => decideRecipe(run.runId, "skip")}>
              {t("common.skip")}
            </Button>
            <Button
              variant="primary"
              className="worktree-recipe-run"
              onClick={() => decideRecipe(run.runId, "run")}
              autoFocus
            >
              {t("worktreeRecipe.run")}
            </Button>
          </div>
        </div>
      )}

      {run.state !== "awaiting" && run.state !== "skipped" && (
        <>
          {run.failure && <p className="worktree-recipe-failure">{run.failure}</p>}
          {(ports || run.doneWhen.length > 0) && (
            <p className="worktree-recipe-meta">
              {ports && <span>{t("worktreeRecipe.ports", { ports })}</span>}
              {run.doneWhen.length > 0 && (
                <span>{t("worktreeRecipe.doneWhen", { checks: run.doneWhen.join(", ") })}</span>
              )}
            </p>
          )}
          {run.lines.length > 0 && finished && (
            <Button
              variant="link"
              className="worktree-recipe-toggle"
              aria-expanded={logOpen}
              onClick={() => setShowLog(!logOpen)}
            >
              {t(logOpen ? "worktreeRecipe.hideLog" : "worktreeRecipe.showLog")}
            </Button>
          )}
          {run.lines.length > 0 && logOpen && (
            <pre className="worktree-recipe-log" ref={logRef} role="log" aria-label={t("worktreeRecipe.log")} tabIndex={0}>
              {run.dropped > 0 && <span className="worktree-recipe-line-hermes">…{"\n"}</span>}
              {run.lines.map((line, i) => (
                <span key={i} className={`worktree-recipe-line-${line.stream}`}>
                  {line.text}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </>
      )}

      {run.state !== "awaiting" && (
        <div className="worktree-recipe-actions">
          {run.state === "running" ? (
            <Button variant="danger" className="worktree-recipe-stop" onClick={() => void stopRecipeRun(run.runId)}>
              {t("worktreeRecipe.stop")}
            </Button>
          ) : (
            finished && (
              <Button className="worktree-recipe-close" onClick={() => dismissRecipeRun(run.runId)}>
                {t("common.close")}
              </Button>
            )
          )}
        </div>
      )}
    </section>
  );
}
