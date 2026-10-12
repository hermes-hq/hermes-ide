import "../styles/components/NewFolderForm.css";
import { useEffect, useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { createProjectFolder } from "../api/projects";
import { getSetting, setSetting } from "../api/settings";
import type { Project } from "../types/project";
import { useI18n } from "../i18n/I18nProvider";
import { Button, Checkbox, Input } from "./ui";

/** The folder new projects were last made in (the next one starts there too). */
const LAST_PARENT_KEY = "new_folder_parent";

/**
 * Where a new folder goes when none was used before: next to the newest
 * project (`projects` most recent first), else the home folder.
 */
export function defaultNewFolderParent(projects: { path: string }[]): string {
  const path = projects[0]?.path;
  if (!path) return "~";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : "~";
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/**
 * The IDE's "New Project": a name, where it goes and what it starts with.
 * Create makes the folder at once and hands back the project, which the
 * caller adds to the session's folders.
 */
export function NewFolderForm({
  projects,
  onCreated,
  onCancel,
}: {
  projects: { path: string }[];
  onCreated: (project: Project) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const [name, setName] = useState("");
  const [parent, setParent] = useState(() => defaultNewFolderParent(projects));
  const [git, setGit] = useState(true);
  const [agentsMd, setAgentsMd] = useState(true);
  const [readme, setReadme] = useState(false);
  const [gitignore, setGitignore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSetting(LAST_PARENT_KEY)
      .then((last) => {
        if (live && last) setParent(last);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const trimmed = name.trim();
  const canCreate = !!trimmed && !!parent.trim() && !busy;

  const pickParent = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) setParent(picked);
  };

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProjectFolder(parent.trim(), trimmed, { git, agentsMd, readme, gitignore: git && gitignore });
      void setSetting(LAST_PARENT_KEY, parent.trim()).catch(() => {});
      onCreated(project);
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    // Keys typed here stay here: the dialog around it reads Space, Enter and
    // Esc for its own list. Enter in a field creates, Esc closes the form.
    <div
      className="new-folder-form"
      role="group"
      aria-label={t("newFolder.title")}
      data-own-enter="true"
      onKeyDown={(e) => {
        e.stopPropagation();
        const field = e.target instanceof HTMLInputElement && e.target.type === "text";
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && field && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void create();
        }
      }}
    >
      <div className="new-folder-title">{t("newFolder.title")}</div>
      <div className="new-folder-fields">
        <label className="new-folder-field" htmlFor={`${ids}-name`}>
          <span>{t("newFolder.name")}</span>
          <Input
            id={`${ids}-name`}
            className="new-folder-name"
            autoFocus
            value={name}
            placeholder={t("newFolder.namePlaceholder")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="new-folder-field" htmlFor={`${ids}-parent`}>
          <span>{t("newFolder.location")}</span>
          <span className="new-folder-parent-row">
            <Input
              id={`${ids}-parent`}
              code
              className="new-folder-parent"
              value={parent}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setParent(e.target.value);
                setError(null);
              }}
            />
            <Button size="sm" className="new-folder-browse" onClick={() => void pickParent()}>
              {t("common.browse")}
            </Button>
          </span>
        </label>
      </div>
      <div className="new-folder-options">
        <Checkbox className="new-folder-git" checked={git} onChange={setGit} label={t("newFolder.git")} />
        <Checkbox
          className="new-folder-gitignore"
          checked={git && gitignore}
          disabled={!git}
          onChange={setGitignore}
          label={t("newFolder.gitignore")}
        />
        <Checkbox className="new-folder-agents" checked={agentsMd} onChange={setAgentsMd} label={t("newFolder.agentsMd")} />
        <Checkbox className="new-folder-readme" checked={readme} onChange={setReadme} label={t("newFolder.readme")} />
      </div>
      <div className="new-folder-path" aria-live="polite">
        {trimmed ? joinPath(parent.trim() || "~", trimmed) : t("newFolder.hint")}
      </div>
      {error && (
        <div className="new-folder-error" role="alert">
          {error}
        </div>
      )}
      <div className="new-folder-actions">
        <Button size="sm" variant="quiet" className="new-folder-cancel" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" variant="primary" className="new-folder-create" disabled={!canCreate} loading={busy} onClick={() => void create()}>
          {t("newFolder.create")}
        </Button>
      </div>
    </div>
  );
}
