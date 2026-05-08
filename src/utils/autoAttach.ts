/**
 * Single source of truth for "session cwd just landed inside a known
 * project — attach it."  Pulled out of `SessionContext.tsx` so the
 * agent/terminal split can be unit-tested at the IPC seam.
 *
 * The agent fold (`addWorkspacePath`) is the bug fix: until 1.0.0 the
 * auto-attach branch only wrote `session_realms` rows, so an agent whose
 * cwd was inside a known project showed the project as attached but was
 * spawned with `additionalDirectories: []` — the SDK file tools refused
 * every read.  Terminal sessions inherit cwd through the PTY and never
 * needed `--add-dir`, which is why this code only fires for agent mode.
 */

export interface AutoAttachSession {
  id: string;
  mode?: "terminal" | "agent" | null;
  working_directory?: string | null;
}

export interface AutoAttachProject {
  id: string;
  path: string;
}

export interface AutoAttachDeps {
  getProjects: () => Promise<AutoAttachProject[]>;
  getSessionProjects: (sessionId: string) => Promise<Array<{ id: string }>>;
  attachSessionProject: (sessionId: string, projectId: string, role: string) => Promise<void>;
  addWorkspacePath: (sessionId: string, path: string) => Promise<void>;
}

export async function autoAttachInsideProject(
  session: AutoAttachSession,
  deps: AutoAttachDeps,
): Promise<void> {
  const wd = session.working_directory;
  if (!wd) return;

  const projects = await deps.getProjects();
  for (const project of projects) {
    const rp = project.path;
    const isExactOrSubdir = wd === rp || wd.startsWith(rp + "/");
    if (!isExactOrSubdir) continue;

    const attached = await deps.getSessionProjects(session.id);
    if (attached.some((r) => r.id === project.id)) return;

    await deps.attachSessionProject(session.id, project.id, "primary");
    if (session.mode === "agent" && project.path) {
      await deps.addWorkspacePath(session.id, project.path);
    }
    return;
  }
}
